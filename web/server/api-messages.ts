import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import type { WsBridge } from "./ws-bridge.js";
import type { CliLauncher } from "./cli-launcher.js";
import type {
  CLIMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
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
  const lastUserMessage = lastMsg ? extractTextContent(lastMsg.content) : "";

  // If there's only 1 message (or no prior turns), just return system + last message
  const priorMessages = messages.slice(0, -1);
  if (priorMessages.length === 0) {
    return { systemPrompt: systemText, lastUserMessage };
  }

  // Format prior messages as conversation history
  const historyLines = priorMessages.map((msg) => {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const text = extractTextContent(msg.content);
    return `[${role}]: ${text}`;
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

    // Extract system prompt + conversation history.
    // OpenClaw sends full messages[] on every call. Claude Code CLI only accepts
    // one user message, so we embed prior turns in the system prompt.
    const systemText = body.system
      ? (typeof body.system === "string" ? body.system : extractTextContent(body.system))
      : undefined;

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

    // Spawn a new CLI process for this request.
    // --tools "" disables ALL built-in tools (Bash, Read, Edit, Task, etc.)
    // --system-prompt replaces the agentic default prompt → pure LLM mode
    // --model is passed directly to CLI (no need for setModel WebSocket round-trip)
    const cwd = process.env.CLAUDE_CWD || undefined;
    const newSession = launcher.launch({
      model,
      cwd,
      source: "api",
      tools: "",                      // disable all tools → no subagents, no file ops
      systemPrompt: fullSystemPrompt, // system prompt + conversation history injected
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

          let contentBlockStarted = false;
          let blockIndex = 0;

          const onMessage = (msg: CLIMessage) => {
            if (closed) { cleanup(); return; }

            // assistant message — contains full content blocks
            if (msg.type === "assistant") {
              const assistantMsg = msg as CLIAssistantMessage;
              for (const block of assistantMsg.message.content) {
                if (block.type === "text") {
                  // Start a new content block
                  sendSSE("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  // Send the full text as a delta
                  sendSSE("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "text_delta", text: block.text },
                  });
                  sendSSE("content_block_stop", {
                    type: "content_block_stop",
                    index: blockIndex,
                  });
                  blockIndex++;
                }
                // tool_use blocks are internal to Claude Code — skip them
              }
            }

            // stream_event — token-by-token streaming (when --verbose)
            if (msg.type === "stream_event") {
              const streamMsg = msg as CLIStreamEventMessage;
              const event = streamMsg.event as Record<string, unknown>;

              // Handle content_block_delta from the raw Anthropic stream
              if (event?.type === "content_block_delta") {
                const delta = event.delta as { type?: string; text?: string } | undefined;
                if (delta?.type === "text_delta" && delta.text) {
                  if (!contentBlockStarted) {
                    sendSSE("content_block_start", {
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "text", text: "" },
                    });
                    contentBlockStarted = true;
                  }
                  sendSSE("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "text_delta", text: delta.text },
                  });
                }
              }

              // content_block_stop
              if (event?.type === "content_block_stop") {
                if (contentBlockStarted) {
                  sendSSE("content_block_stop", {
                    type: "content_block_stop",
                    index: blockIndex,
                  });
                  blockIndex++;
                  contentBlockStarted = false;
                }
              }
            }

            // result — query complete
            if (msg.type === "result") {
              const resultMsg = msg as CLIResultMessage;
              cleanup();

              // Close any open content block
              if (contentBlockStarted) {
                sendSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: blockIndex,
                });
              }

              sendSSE("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: "end_turn",
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
