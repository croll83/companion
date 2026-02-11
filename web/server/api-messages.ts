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
 *   - model — model selector, forwarded to CLI via set_model
 *   - system — system prompt (logged, not directly usable by Claude Code)
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

    // Extract the last user message text (handles both string and content-block arrays)
    const lastMsg = messages[messages.length - 1];
    const lastMessageText = lastMsg ? extractTextContent(lastMsg.content) : "";

    if (!lastMessageText) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "Last message has no text content" } },
        400,
      );
    }

    // Extract system prompt text if provided
    const systemText = body.system
      ? (typeof body.system === "string" ? body.system : extractTextContent(body.system))
      : undefined;

    // Find an active session that is NOT busy, or spawn a new one
    const sessions = launcher.listSessions();
    const activeSessions = sessions.filter(
      (s) => s.state !== "exited" && !s.archived,
    );
    const freeSession = activeSessions.find(
      (s) => !wsBridge.isBusy(s.sessionId),
    );

    let sessionId: string;

    if (freeSession) {
      sessionId = freeSession.sessionId;
    } else if (activeSessions.length >= MAX_SESSIONS) {
      // All sessions busy and at limit → reject
      return c.json(
        { type: "error", error: { type: "overloaded_error", message: `All ${MAX_SESSIONS} sessions are busy. Try again later.` } },
        429,
      );
    } else {
      // All busy but under limit → spawn a new CLI session
      const cwd = process.env.CLAUDE_CWD || undefined;
      const newSession = launcher.launch({ model, cwd });
      sessionId = newSession.sessionId;
      console.log(`[api-messages] All sessions busy, spawned new session ${sessionId} (${activeSessions.length + 1}/${MAX_SESSIONS})`);
    }

    // Ensure the WsBridge has the session and mark it as busy
    wsBridge.getOrCreateSession(sessionId);
    wsBridge.markBusy(sessionId, true);

    // Send initialize with systemPrompt in "replace" mode (overrides Claude Code's built-in agentic prompt → pure LLM)
    if (systemText && !wsBridge.isInitialized(sessionId)) {
      console.log(`[api-messages] Sending systemPrompt/replace (${systemText.length} chars) for session ${sessionId}`);
      await wsBridge.initialize(sessionId, systemText, "replace");
    } else if (systemText) {
      console.log(`[api-messages] System prompt provided (${systemText.length} chars) but session already initialized, skipping`);
    }

    // Switch model if specified in the request (await CLI acknowledgment)
    if (model) {
      await wsBridge.setModel(sessionId, model);
    }

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
            wsBridge.markBusy(sessionId, false);
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
