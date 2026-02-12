import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WsBridge } from "./ws-bridge.js";
import type { CliLauncher } from "./cli-launcher.js";
import type {
  CLIMessage,
  CLIAssistantMessage,
  CLIResultMessage,
} from "./session-types.js";

// ─── Types for Anthropic Messages API request ─────────────────────────────────

interface AnthropicContentBlock {
  type: "text" | "image";
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicMessagesBody {
  messages?: AnthropicMessage[];
  stream?: boolean;
  model?: string;
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
  tools?: unknown[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format tool definitions for the system prompt in a human-readable way.
 * Instead of dumping raw JSON schemas (which Claude may misinterpret when
 * injected as text), we produce a clear markdown-style listing with
 * parameter names, types, and descriptions.
 */
function formatToolDefsForPrompt(tools: unknown[]): string {
  return (tools as Array<Record<string, unknown>>).map((tool) => {
    const name = tool.name as string;
    const desc = (tool.description as string) || "";
    const schema = (tool.input_schema || tool.parameters) as Record<string, unknown> | undefined;
    const props = (schema?.properties || {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];

    const paramLines = Object.entries(props).map(([key, prop]) => {
      const type = prop.type || "string";
      const propDesc = prop.description || "";
      const isRequired = required.includes(key);
      const reqTag = isRequired ? " [REQUIRED]" : "";
      return `  - ${key} (${type})${reqTag}: ${propDesc}`;
    }).join("\n");

    return `### ${name}\n${desc}${paramLines ? `\nParameters:\n${paramLines}` : ""}`;
  }).join("\n\n");
}

/** Extract plain text from a message content field (string or content blocks). */
function extractTextContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

/**
 * Extract content from the last message, handling ALL block types.
 * Unlike extractTextContent (which only extracts text blocks), this also
 * handles tool_result and tool_use blocks — formatting them as structured
 * text that Claude can understand.
 *
 * This is needed because OpenClaw sends full message history. After a tool_use
 * response, the next user message contains tool_result blocks (not text).
 */
function extractLastMessageContent(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_result") {
      let resultContent = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
      // Truncate verbose tool results to save context space
      if (resultContent.length > 2000) {
        resultContent = resultContent.slice(0, 2000) + "\n...[truncated]";
      }
      parts.push(
        `<prior_tool_output tool_use_id="${block.tool_use_id}">${resultContent}</prior_tool_output>`,
      );
    } else if (block.type === "tool_use") {
      parts.push(
        `<prior_tool_call name="${block.name}" id="${block.id}">${JSON.stringify(block.input)}</prior_tool_call>`,
      );
    }
  }
  return parts.join("\n");
}

/**
 * Build a combined system prompt with conversation history injected.
 * OpenClaw sends full messages[] history on every call, but Claude Code CLI
 * only accepts one user message at a time via WebSocket. We embed prior turns
 * in the system prompt so Claude has full multi-turn context.
 */
function buildConversationContext(
  systemText: string | undefined,
  messages: AnthropicMessage[],
): { systemPrompt: string | undefined; lastUserMessage: string } {
  const lastMsg = messages[messages.length - 1];
  // Use extractLastMessageContent to handle ALL block types (text, tool_result, tool_use)
  const lastUserMessage = lastMsg ? extractLastMessageContent(lastMsg.content) : "";

  // If there's only 1 message (or no prior turns), just return system + last message
  const priorMessages = messages.slice(0, -1);
  if (priorMessages.length === 0) {
    return { systemPrompt: systemText, lastUserMessage };
  }

  // Cap conversation history to prevent context overflow.
  // OpenClaw may send 100+ messages (especially after tool retry loops).
  // We keep only the most recent turns — enough for context, not enough to overflow.
  const MAX_HISTORY_MESSAGES = 20;
  const MAX_TOOL_OUTPUT_CHARS = 2000;
  const cappedMessages = priorMessages.length > MAX_HISTORY_MESSAGES
    ? priorMessages.slice(-MAX_HISTORY_MESSAGES)
    : priorMessages;

  if (priorMessages.length > MAX_HISTORY_MESSAGES) {
    console.log(
      `[api-messages] history capped: ${priorMessages.length} → ${MAX_HISTORY_MESSAGES} messages`,
    );
  }

  // Format prior messages as conversation history.
  // Content can be string, or array with text/tool_use/tool_result blocks.
  const historyLines = cappedMessages.map((msg) => {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;

    if (typeof content === "string") {
      return `[${role}]: ${content}`;
    }

    // Array content — may contain text, tool_use, tool_result blocks
    const parts = (content as unknown as Record<string, unknown>[]).map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_use") {
        return `<prior_tool_call name="${block.name}" id="${block.id}">${JSON.stringify(block.input)}</prior_tool_call>`;
      }
      if (block.type === "tool_result") {
        let resultContent = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        // Truncate verbose tool results to save context space
        if (resultContent.length > MAX_TOOL_OUTPUT_CHARS) {
          resultContent = resultContent.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n...[truncated]";
        }
        return `<prior_tool_output tool_use_id="${block.tool_use_id}">${resultContent}</prior_tool_output>`;
      }
      return "";
    }).filter(Boolean).join("\n");

    return `[${role}]: ${parts}`;
  }).join("\n");

  const historyBlock = `\n\n<conversation_history>\n${historyLines}\n</conversation_history>`;

  const combinedPrompt = systemText
    ? systemText + historyBlock
    : historyBlock.trim();

  return { systemPrompt: combinedPrompt, lastUserMessage };
}

/** Timeout (ms) for a session to produce a `result` message before we close the SSE. */
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Max concurrent CLI sessions. Set via MAX_SESSIONS env var. */
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "3", 10);

/**
 * Creates a Hono app that exposes POST /v1/messages
 * compatible with the Anthropic Messages API (SSE streaming).
 *
 * It creates a companion session, sends the user's message through the WsBridge,
 * and streams back assistant responses as SSE events in the Anthropic format.
 *
 * Supported Anthropic body fields:
 *   - messages (required) — conversation messages
 *   - stream (required, must be true) — SSE streaming
 *   - model — model selector, forwarded to CLI via --model flag
 *   - system — system prompt, combined with conversation history and passed via --system-prompt
 *   - max_tokens, temperature, top_p, top_k — accepted & ignored (CLI controls these)
 *   - stop_sequences, metadata — accepted & ignored
 *
 * Auth headers (x-api-key, Authorization, anthropic-version) are accepted and ignored
 * since authentication is handled by the Claude Code CLI session.
 */
export function createMessagesAPI(
  wsBridge: WsBridge,
  launcher: CliLauncher,
) {
  const app = new Hono();
  app.use("/*", cors());

  app.post("/v1/messages", async (c) => {
    const body = await c.req.json().catch(() => null) as AnthropicMessagesBody | null;
    if (!body) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
    }

    const { messages, stream, model } = body;

    if (!stream) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "Only stream=true is supported" } },
        400,
      );
    }

    if (!messages?.length) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "messages array is required and must not be empty" } },
        400,
      );
    }

    // Debug: log incoming request shape to understand what openclaw sends
    const lastMsgContent = messages[messages.length - 1]?.content;
    const lastMsgTypes = Array.isArray(lastMsgContent)
      ? (lastMsgContent as unknown as Record<string, unknown>[]).map((b) => b.type)
      : typeof lastMsgContent;
    console.log(
      `[api-messages] incoming: ${messages.length} msgs, ` +
      `tools: ${body.tools?.length ?? 0}, ` +
      `last: role=${messages[messages.length - 1]?.role} types=${JSON.stringify(lastMsgTypes)}`,
    );

    // Extract system prompt + conversation history.
    // OpenClaw sends full messages[] on every call. Claude Code CLI only accepts
    // one user message, so we embed prior turns in the system prompt.
    let systemText = body.system
      ? (typeof body.system === "string" ? body.system : extractTextContent(body.system))
      : undefined;

    // Tool fallback: Claude Code CLI can't accept custom tool definitions via API,
    // so we inject them into the system prompt. Claude will output structured
    // ---TOOL_USE--- blocks that the bridge converts to native tool_use SSE events.
    //
    // OpenClaw manages the tool execution loop:
    //   1. Bridge returns tool_use SSE blocks + stop_reason: "tool_use"
    //   2. OpenClaw executes the tool and sends tool_result in next request
    //   3. Bridge lets Claude make MORE tool_use calls if needed
    //   4. OpenClaw decides when the loop ends (stop_reason: "end_turn")
    //
    // Safeguard: if conversation has too many tool turns (e.g. retry loop on errors),
    // force end_turn to prevent infinite loops. OpenClaw has only timeout-based
    // protection (600s), so this bridge-side limit is essential.
    const MAX_TOOL_TURNS = 10;
    // Count consecutive tool turns from the END of the conversation.
    // When the user sends a pure-text message (no tool_result), the chain resets.
    // This way, old tool loops from previous interactions don't block new tool calls.
    let toolTurnCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i].content;
      if (!Array.isArray(content)) break; // string content = pure text → chain ends
      const blocks = content as unknown as Record<string, unknown>[];
      const hasToolBlock = blocks.some(
        (b) => b.type === "tool_use" || b.type === "tool_result",
      );
      if (!hasToolBlock) break; // only text blocks → chain ends
      toolTurnCount++;
    }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const allowToolUseInResponse = hasTools && toolTurnCount < MAX_TOOL_TURNS;

    if (toolTurnCount >= MAX_TOOL_TURNS) {
      console.log(
        `[api-messages] tool turn limit reached (${toolTurnCount}/${MAX_TOOL_TURNS}), forcing end_turn`,
      );
    }
    if (hasTools) {
      const toolDefs = formatToolDefsForPrompt(body.tools as unknown[]);
      const toolInstruction = `

<tool_definitions>
You have access to the following tools. When you need to use a tool, output EXACTLY this format:

---TOOL_USE---
{"id":"toolu_<unique_id>","name":"<tool_name>","input":{<parameters_object>}}
---END_TOOL_USE---

EXAMPLES:
---TOOL_USE---
{"id":"toolu_abc123","name":"read","input":{"path":"/skills/SKILL.md"}}
---END_TOOL_USE---

---TOOL_USE---
{"id":"toolu_def456","name":"exec","input":{"command":"ls -la /workspace"}}
---END_TOOL_USE---

Available tools:
${toolDefs}

CRITICAL RULES:
- The "input" field MUST be a JSON object with named parameters — NEVER a string
- ALWAYS include required parameters: "read" needs "path", "write" needs "path"+"content", "exec" needs "command"
- Output ONLY the ---TOOL_USE--- block when calling a tool
- NEVER simulate or invent tool output — just request the tool and STOP
- NEVER wrap the block in markdown code fences
- The "id" must start with "toolu_" followed by a unique string
- After outputting ---TOOL_USE---, STOP generating. Wait for the tool result.
- You may output a short text message before the tool block to explain what you're doing
- The <conversation_history> may contain <prior_tool_call> and <prior_tool_output> tags — those are COMPLETED past actions. Do NOT repeat them. Use ---TOOL_USE--- format ONLY for NEW tool calls.
- If you already received a result (shown as <prior_tool_output>), DO NOT call the same tool again. Use the existing result to respond.
- If a tool returns an error, do NOT retry more than once. Instead, explain the issue to the user.
</tool_definitions>`;

      systemText = systemText ? systemText + toolInstruction : toolInstruction;
    }

    const { systemPrompt: fullSystemPrompt, lastUserMessage: rawLastMessage } =
      buildConversationContext(systemText, messages);

    // When tool turn limit is reached, prepend an instruction to stop calling tools
    const lastMessageText = toolTurnCount >= MAX_TOOL_TURNS
      ? `IMPORTANT: Tool call limit reached. Do NOT call any more tools. Summarize what you know from the conversation history and respond to the user in natural language.\n\n${rawLastMessage}`
      : rawLastMessage;

    if (!lastMessageText) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "Last message has no text content" } },
        400,
      );
    }

    // ── One-shot session: spawn a fresh CLI process for each request ──
    // This mimics real LLM providers (stateless). Each request gets its own
    // CLI process with its own system prompt. No session reuse, no state leak.

    // Check concurrency limit (count only in-flight API sessions)
    const inFlightApiSessions = launcher.listSessions().filter(
      (s) => s.state !== "exited" && !s.archived && s.source === "api",
    );

    if (inFlightApiSessions.length >= MAX_SESSIONS) {
      return c.json(
        { type: "error", error: { type: "overloaded_error", message: `All ${MAX_SESSIONS} API sessions are in-flight. Try again later.` } },
        429,
      );
    }

    // Write system prompt + conversation history to a temp file.
    // Using --system-prompt-file avoids ARG_MAX limits for long prompts.
    const tmpDir = join(tmpdir(), "clawd-companion");
    mkdirSync(tmpDir, { recursive: true });
    // Generate a unique ID for the temp file (sessionId not yet available)
    const tempId = randomUUID();
    let systemPromptFile: string | undefined;
    if (fullSystemPrompt) {
      systemPromptFile = join(tmpDir, `sysprompt-${tempId}.txt`);
      writeFileSync(systemPromptFile, fullSystemPrompt, "utf-8");
    }

    // Spawn a new CLI process for this request.
    // Key isolation for API sessions (pure LLM mode):
    //   --tools ""              → disables ALL built-in tools (Bash, Edit, Task, etc.)
    //   --system-prompt-file    → replaces agentic prompt with openclaw's prompt
    //   cwd = sandbox           → empty dir, no TOOLS.md/SOUL.md/skills/ from openclaw
    const apiCwd = process.env.CLAUDE_API_CWD
      || join(process.env.CLAUDE_CWD || "/workspace", "claude-sandbox");
    const newSession = launcher.launch({
      model,
      cwd: apiCwd,
      source: "api",
      tools: "",           // disable all built-in tools → pure LLM
      systemPromptFile,
    });
    const sessionId = newSession.sessionId;
    const effectivePriorTurns = Math.min(messages.length - 1, 20); // matches MAX_HISTORY_MESSAGES
    console.log(`[api-messages] one-shot ${sessionId} | ${effectivePriorTurns} prior turns (${messages.length - 1} total) | system ${fullSystemPrompt?.length ?? 0} chars | toolChain=${toolTurnCount} | ${inFlightApiSessions.length + 1}/${MAX_SESSIONS}`);

    // Ensure the WsBridge has the session entry for message routing
    wsBridge.getOrCreateSession(sessionId);

    const emitter = wsBridge.getSessionEmitter(sessionId);
    if (!emitter) {
      return c.json(
        { type: "error", error: { type: "api_error", message: "Failed to get session emitter" } },
        500,
      );
    }

    const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

    // Resolve the model name: prefer CLI session state, fall back to request model
    const sessionState = wsBridge.getAllSessions().find(
      (s) => s.session_id === sessionId || s.session_id === "",
    );
    const reportedModel = model || sessionState?.model || "claude-code";

    // Stream SSE response
    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;

          const sendSSE = (event: string, data: unknown) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              );
            } catch {
              // Controller already closed
              closed = true;
            }
          };

          const closeStream = () => {
            if (closed) return;
            closed = true;
            try { controller.close(); } catch { /* already closed */ }
          };

          // Safety timeout: close the stream if we never get a `result` from CLI
          const sessionTimeout = setTimeout(() => {
            cleanup();
            sendSSE("error", {
              type: "error",
              error: { type: "timeout_error", message: "Session timed out waiting for response" },
            });
            closeStream();
          }, SESSION_TIMEOUT_MS);

          // Initial handshake — message_start
          sendSSE("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              model: reportedModel,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });

          let blockIndex = 0;
          let foundToolUse = false;

          /** Emit a text content block via SSE */
          const emitTextBlock = (text: string) => {
            sendSSE("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "text", text: "" },
            });
            sendSSE("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text },
            });
            sendSSE("content_block_stop", {
              type: "content_block_stop",
              index: blockIndex,
            });
            blockIndex++;
          };

          /** Emit a tool_use content block via SSE.
           *  Per Anthropic SSE spec, the input is NOT read from content_block_start.
           *  Instead, it must be streamed via input_json_delta events in content_block_delta.
           *  Without this, OpenClaw/pi-ai receives empty input {} → tool validation fails.
           */
          const emitToolUseBlock = (toolCall: { id?: string; name: string; input?: unknown }) => {
            const toolId = toolCall.id || `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
            // 1. content_block_start — input is empty (SDK ignores it here)
            sendSSE("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: toolId,
                name: toolCall.name,
                input: {},
              },
            });
            // 2. input_json_delta — THIS is where the SDK reads the input from
            const inputJson = JSON.stringify(toolCall.input || {});
            sendSSE("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: inputJson,
              },
            });
            // 3. content_block_stop
            sendSSE("content_block_stop", {
              type: "content_block_stop",
              index: blockIndex,
            });
            blockIndex++;
            foundToolUse = true;
          };

          /**
           * Process a text block, ALWAYS scanning for ---TOOL_USE--- markers.
           * This parsing runs regardless of hasTools — Claude may generate markers
           * even without explicit tool definitions (e.g. from OpenClaw's system prompt).
           *
           * When markers are found:
           *   - If allowToolUseInResponse: convert to native tool_use SSE blocks
           *   - Otherwise: strip the markers entirely (don't leak to user)
           */
          const processTextBlock = (text: string) => {
            // Always split on tool markers — even if no tools in request
            const parts = text.split(/(---TOOL_USE---[\s\S]*?---END_TOOL_USE---)/);
            for (const part of parts) {
              const toolMatch = part.match(/^---TOOL_USE---\s*\n?([\s\S]*?)\n?\s*---END_TOOL_USE---$/);
              if (toolMatch) {
                // Only emit ONE tool_use per response. After the first, strip the rest.
                // OpenClaw manages the tool loop — it calls the bridge N times, not N tools at once.
                if (allowToolUseInResponse && !foundToolUse) {
                  try {
                    const toolCall = JSON.parse(toolMatch[1].trim());
                    if (toolCall.name) {
                      // ── Normalize input: fix common format errors ──
                      // Claude may put params at the wrong level or use wrong names
                      if (!toolCall.input || typeof toolCall.input !== "object") {
                        // Params might be at top level instead of inside `input`
                        const { id, name, ...rest } = toolCall;
                        if (Object.keys(rest).length > 0) {
                          toolCall.input = typeof toolCall.input === "string"
                            ? { command: toolCall.input }
                            : rest;
                        } else {
                          toolCall.input = {};
                        }
                      }
                      // Normalize: "cmd" → "command" for exec tool
                      if (toolCall.name === "exec" && !toolCall.input.command && toolCall.input.cmd) {
                        toolCall.input.command = toolCall.input.cmd;
                        delete toolCall.input.cmd;
                      }
                      console.log(`[api-messages] parsed tool_use: ${toolCall.name} | ${JSON.stringify(toolCall).slice(0, 500)}`);
                      emitToolUseBlock(toolCall);
                      continue;
                    }
                  } catch {
                    console.log(`[api-messages] tool_use JSON parse failed, stripping`);
                  }
                } else if (foundToolUse) {
                  console.log(`[api-messages] extra tool_use after first, stripping`);
                }
                // Tools not allowed, already emitted one, or parse failed → STRIP
                if (!foundToolUse) {
                  console.log(`[api-messages] stripping tool_use markers (allowToolUse=${allowToolUseInResponse})`);
                }
                continue;
              }
              // Regular text — only emit if we haven't found a tool_use yet.
              // After tool_use, any trailing text (apologies, retries) is noise.
              const trimmed = part.trim();
              if (trimmed && !foundToolUse) {
                emitTextBlock(trimmed);
              }
            }
          };

          const onMessage = (msg: CLIMessage) => {
            if (closed) { cleanup(); return; }

            // ── SOLE EMISSION PATH: "assistant" message ──
            // We ONLY emit content from the complete "assistant" message, never from
            // stream_event tokens. This ensures we have the full text for parsing
            // ---TOOL_USE--- markers. Token-by-token streaming is sacrificed, but:
            //   - Telegram doesn't support real-time streaming anyway
            //   - OpenClaw buffers the full response before sending to Telegram
            //   - Tool parsing requires complete text (can't parse fragments)
            if (msg.type === "assistant") {
              const assistantMsg = msg as CLIAssistantMessage;
              const blockTypes = assistantMsg.message.content.map((b) => b.type);
              console.log(
                `[api-messages] assistant msg: ${assistantMsg.message.content.length} blocks, ` +
                `hasTools=${hasTools}, allowToolUse=${allowToolUseInResponse}, types=${JSON.stringify(blockTypes)}`,
              );
              for (const block of assistantMsg.message.content) {
                if (block.type === "text") {
                  processTextBlock(block.text);
                }
                // tool_use blocks from Claude Code's internal tools → skip them
              }
            }

            // stream_event — IGNORED for SSE emission.
            // The "assistant" message arrives after all streaming completes and
            // contains the same complete text. We use that as our sole source.

            // result — query complete
            if (msg.type === "result") {
              const resultMsg = msg as CLIResultMessage;
              cleanup();

              sendSSE("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: foundToolUse ? "tool_use" : "end_turn",
                },
                usage: {
                  input_tokens: resultMsg.usage?.input_tokens ?? 0,
                  output_tokens: resultMsg.usage?.output_tokens ?? 0,
                },
              });

              sendSSE("message_stop", { type: "message_stop" });
              closeStream();
            }
          };

          const cleanup = () => {
            clearTimeout(sessionTimeout);
            emitter.off("cli_message", onMessage);
            // Kill the one-shot CLI process and clean up session
            launcher.kill(sessionId).catch(() => {});
            wsBridge.closeSession(sessionId);
            launcher.removeSession(sessionId);
            // Clean up temp system prompt file
            if (systemPromptFile) {
              try { unlinkSync(systemPromptFile); } catch { /* ignore */ }
            }
          };

          // Subscribe before sending the message
          emitter.on("cli_message", onMessage);

          // Send the user message
          const sent = wsBridge.sendUserMessage(sessionId, lastMessageText);
          if (!sent) {
            cleanup();
            sendSSE("error", {
              type: "error",
              error: { type: "api_error", message: "Failed to send message to CLI session" },
            });
            closeStream();
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  return app;
}
