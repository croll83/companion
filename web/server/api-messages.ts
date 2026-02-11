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
      const resultContent = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
      parts.push(
        `---TOOL_RESULT---\ntool_use_id: ${block.tool_use_id}\n${resultContent}\n---END_TOOL_RESULT---`,
      );
    } else if (block.type === "tool_use") {
      parts.push(
        `---TOOL_USE---\n${JSON.stringify({ id: block.id, name: block.name, input: block.input })}\n---END_TOOL_USE---`,
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

  // Format prior messages as conversation history.
  // Content can be string, or array with text/tool_use/tool_result blocks.
  const historyLines = priorMessages.map((msg) => {
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
        return `---TOOL_USE---\n${JSON.stringify({ id: block.id, name: block.name, input: block.input })}\n---END_TOOL_USE---`;
      }
      if (block.type === "tool_result") {
        const resultContent = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        return `---TOOL_RESULT---\ntool_use_id: ${block.tool_use_id}\n${resultContent}\n---END_TOOL_RESULT---`;
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
    // Loop protection is handled by OpenClaw (maxTurns) + SESSION_TIMEOUT_MS.
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const allowToolUseInResponse = hasTools;
    if (hasTools) {
      const toolDefs = JSON.stringify(body.tools, null, 2);
      const toolInstruction = `

<tool_definitions>
You have access to the following tools. When you need to use a tool, output EXACTLY this format:

---TOOL_USE---
{"id":"toolu_<unique_id>","name":"<tool_name>","input":{<parameters>}}
---END_TOOL_USE---

Available tools:
${toolDefs}

CRITICAL RULES:
- Output ONLY the ---TOOL_USE--- block when calling a tool, with NO additional text before or after
- NEVER simulate or invent tool output — just request the tool and STOP
- NEVER wrap the block in markdown code fences
- The "id" must start with "toolu_" followed by a unique string
- After outputting ---TOOL_USE---, STOP generating. Wait for the tool result.
- You may output a short text message before the tool block to explain what you're doing
- When you receive a ---TOOL_RESULT---, read the result and respond to the user in natural language. Do NOT call another tool unless absolutely necessary for a DIFFERENT purpose. NEVER re-call the same tool.
</tool_definitions>`;

      systemText = systemText ? systemText + toolInstruction : toolInstruction;
    }

    const { systemPrompt: fullSystemPrompt, lastUserMessage: lastMessageText } =
      buildConversationContext(systemText, messages);

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
    console.log(`[api-messages] one-shot ${sessionId} | ${messages.length - 1} prior turns | system ${fullSystemPrompt?.length ?? 0} chars | ${inFlightApiSessions.length + 1}/${MAX_SESSIONS}`);

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

          /** Emit a tool_use content block via SSE */
          const emitToolUseBlock = (toolCall: { id?: string; name: string; input?: unknown }) => {
            const toolId = toolCall.id || `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
            sendSSE("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: toolId,
                name: toolCall.name,
                input: toolCall.input || {},
              },
            });
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
                if (allowToolUseInResponse) {
                  try {
                    const toolCall = JSON.parse(toolMatch[1].trim());
                    if (toolCall.name) {
                      console.log(`[api-messages] parsed tool_use: ${toolCall.name}`);
                      emitToolUseBlock(toolCall);
                      continue;
                    }
                  } catch {
                    console.log(`[api-messages] tool_use JSON parse failed, stripping`);
                  }
                }
                // Tools not allowed or parse failed → STRIP markers, don't show to user
                console.log(`[api-messages] stripping tool_use markers (allowToolUse=${allowToolUseInResponse})`);
                continue;
              }
              // Regular text (skip empty/whitespace-only parts)
              const trimmed = part.trim();
              if (trimmed) {
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
