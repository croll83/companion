// @vitest-environment jsdom

import type { SessionState, PermissionRequest, ContentBlock } from "./types.js";

// Mock the names utility before any imports
vi.mock("./utils/names.js", () => ({
  generateUniqueSessionName: vi.fn(() => "Test Session"),
}));

// Observe the completion chime without touching the Web Audio API.
const { playNotificationSoundMock } = vi.hoisted(() => ({ playNotificationSoundMock: vi.fn() }));
vi.mock("./utils/notification-sound.js", () => ({
  playNotificationSound: playNotificationSoundMock,
}));

let wsModule: typeof import("./ws.js");
let useStore: typeof import("./store.js").useStore;

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------
let lastWs: InstanceType<typeof MockWebSocket>;
/** Every socket constructed since the last reset, in creation order. */
let allWs: InstanceType<typeof MockWebSocket>[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  OPEN = 1;
  CLOSED = 3;
  CONNECTING = 0;
  CLOSING = 2;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWs = this;
    allWs.push(this);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { protocol: "http:", host: "localhost:3456" });

// ---------------------------------------------------------------------------
// Fresh module state for each test
// ---------------------------------------------------------------------------
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();

  const storeModule = await import("./store.js");
  useStore = storeModule.useStore;
  useStore.getState().reset();
  localStorage.clear();
  allWs = [];

  wsModule = await import("./ws.js");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSession(id: string): SessionState {
  return {
    session_id: id,
    model: "claude-opus-4-20250514",
    cwd: "/home/user",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "2.1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "main",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/repo",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function fireMessage(data: Record<string, unknown>) {
  lastWs.onmessage!({ data: JSON.stringify(data) });
}

// ===========================================================================
// Connection
// ===========================================================================
describe("connectSession", () => {
  it("creates a WebSocket with the correct URL", () => {
    wsModule.connectSession("s1");

    expect(lastWs.url).toBe("ws://localhost:3456/ws/browser/s1?token=");
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connecting");
  });

  it("does not create a duplicate socket for the same session", () => {
    wsModule.connectSession("s1");
    const first = lastWs;
    wsModule.connectSession("s1");

    // lastWs should still be the first one (no new constructor call)
    expect(lastWs).toBe(first);
  });

  it("replaces a stale closed socket for the same session", () => {
    wsModule.connectSession("s1");
    const first = lastWs;
    first.readyState = MockWebSocket.CLOSED;

    wsModule.connectSession("s1");

    expect(lastWs).not.toBe(first);
    expect(first.close).toHaveBeenCalled();
  });

  it("does not clobber the new socket when replaced socket closes later", () => {
    wsModule.connectSession("s1");
    const first = lastWs;
    first.readyState = MockWebSocket.CLOSING;

    wsModule.connectSession("s1");
    const second = lastWs;
    expect(second).not.toBe(first);

    first.onclose?.();

    // Old socket close must not drop the replacement socket's state.
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connecting");
    wsModule.sendToSession("s1", { type: "interrupt" });
    expect(second.send).toHaveBeenCalled();
  });


  it("sends session_subscribe with last_seq on open", () => {
    localStorage.setItem("companion:last-seq:s1", "12");
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_subscribe", last_seq: 12 }),
    );
  });
});

// ===========================================================================
// sendToSession
// ===========================================================================
describe("sendToSession", () => {
  it("JSON-stringifies and sends the message", () => {
    wsModule.connectSession("s1");
    const msg = { type: "user_message" as const, content: "hello" };

    wsModule.sendToSession("s1", msg);

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.type).toBe("user_message");
    expect(payload.content).toBe("hello");
    expect(typeof payload.client_msg_id).toBe("string");
  });

  it("does nothing when session has no socket", () => {
    // Should not throw
    wsModule.sendToSession("nonexistent", { type: "interrupt" });
  });

  it("preserves provided client_msg_id", () => {
    wsModule.connectSession("s1");
    wsModule.sendToSession("s1", {
      type: "user_message",
      content: "hello",
      client_msg_id: "fixed-id-1",
    });

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.client_msg_id).toBe("fixed-id-1");
  });

  it("adds client_msg_id for interrupt control message", () => {
    wsModule.connectSession("s1");
    wsModule.sendToSession("s1", { type: "interrupt" });

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.type).toBe("interrupt");
    expect(typeof payload.client_msg_id).toBe("string");
  });

  it("queues idempotent messages until the socket is open, then flushes them", () => {
    wsModule.connectSession("s1");
    lastWs.readyState = MockWebSocket.CONNECTING;

    wsModule.sendToSession("s1", {
      type: "user_message",
      content: "hello from queue",
    });

    expect(lastWs.send).not.toHaveBeenCalled();

    lastWs.readyState = MockWebSocket.OPEN;
    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(lastWs.send.mock.calls[0][0])).toEqual({
      type: "session_subscribe",
      last_seq: 0,
    });
    const payload = JSON.parse(lastWs.send.mock.calls[1][0]);
    expect(payload.type).toBe("user_message");
    expect(payload.content).toBe("hello from queue");
    expect(typeof payload.client_msg_id).toBe("string");
  });
});

describe("handleMessage: user_message", () => {
  it("appends live user_message events from the server", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "user_message",
      id: "cmsg-live-1",
      content: "server-backed prompt",
      timestamp: 1000,
    });

    expect(useStore.getState().messages.get("s1")).toEqual([
      expect.objectContaining({
        id: "cmsg-live-1",
        role: "user",
        content: "server-backed prompt",
        timestamp: 1000,
      }),
    ]);
  });

  it("deduplicates optimistic user messages when the server echoes the same id", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().appendMessage("s1", {
      id: "cmsg-optimistic-1",
      role: "user",
      content: "optimistic first prompt",
      timestamp: 1000,
    });

    fireMessage({
      type: "user_message",
      id: "cmsg-optimistic-1",
      content: "optimistic first prompt",
      timestamp: 1000,
    });

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "cmsg-optimistic-1",
      role: "user",
      content: "optimistic first prompt",
    });
  });

  it("clears prompt suggestions when a server user_message is received", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setPromptSuggestions("s1", ["Explain the diff"]);

    fireMessage({
      type: "user_message",
      id: "cmsg-live-2",
      content: "server-backed prompt",
      timestamp: 1001,
    });

    expect(useStore.getState().promptSuggestions.has("s1")).toBe(false);
  });
});

// ===========================================================================
// disconnectSession
// ===========================================================================
describe("disconnectSession", () => {
  it("closes the WebSocket and cleans up", () => {
    wsModule.connectSession("s1");
    const ws = lastWs;
    useStore.getState().setConnectionStatus("s1", "connected");

    wsModule.disconnectSession("s1");

    expect(ws.close).toHaveBeenCalled();
    expect(useStore.getState().connectionStatus.get("s1")).toBe("disconnected");
    // Sending after disconnect should be a no-op
    wsModule.sendToSession("s1", { type: "interrupt" });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("ignores stale onclose fired after disconnect cleanup", () => {
    wsModule.connectSession("s1");
    const ws = lastWs;

    wsModule.disconnectSession("s1");

    // Simulate async close callback arriving after socket map cleanup.
    ws.onclose?.();
    vi.advanceTimersByTime(5_000);

    expect(lastWs).toBe(ws);
    expect(useStore.getState().connectionStatus.get("s1")).toBe("disconnected");
  });

  it("clears queued outgoing messages on explicit disconnect", () => {
    wsModule.connectSession("s1");
    const firstWs = lastWs;
    firstWs.readyState = MockWebSocket.CONNECTING;

    wsModule.sendToSession("s1", {
      type: "user_message",
      content: "stale queued message",
    });

    expect(firstWs.send).not.toHaveBeenCalled();

    wsModule.disconnectSession("s1");

    wsModule.connectSession("s1");
    const secondWs = lastWs;
    secondWs.readyState = MockWebSocket.OPEN;
    secondWs.onopen?.(new Event("open"));

    expect(secondWs.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secondWs.send.mock.calls[0][0])).toEqual({
      type: "session_subscribe",
      last_seq: 0,
    });
  });
});

// ===========================================================================
// handleMessage: session_init
// ===========================================================================
describe("handleMessage: session_init", () => {
  it("adds session to store, sets CLI connected, generates name", () => {
    wsModule.connectSession("s1");
    const session = makeSession("s1");

    fireMessage({ type: "session_init", session });

    const state = useStore.getState();
    expect(state.sessions.has("s1")).toBe(true);
    expect(state.sessions.get("s1")!.model).toBe("claude-opus-4-20250514");
    expect(state.cliConnected.get("s1")).toBe(true);
    expect(state.sessionStatus.get("s1")).toBe("idle");
    expect(state.sessionNames.get("s1")).toBe("Test Session");
  });

  it("does not overwrite an existing session name", () => {
    useStore.getState().setSessionName("s1", "Custom Name");

    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Custom Name");
  });
});

// ===========================================================================
// handleMessage: session_update
// ===========================================================================
describe("handleMessage: session_update", () => {
  it("updates the session in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_update", session: { model: "claude-sonnet-4-20250514" } });

    expect(useStore.getState().sessions.get("s1")!.model).toBe("claude-sonnet-4-20250514");
  });
});

describe("handleMessage: event_replay", () => {
  it("replays sequenced stream events and stores latest seq", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
            parent_tool_use_id: null,
          },
        },
      ],
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Hello");
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("1");
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_ack", last_seq: 1 }),
    );
  });

  it("acks only once using the latest replayed seq", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    lastWs.send.mockClear();

    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } },
            parent_tool_use_id: null,
          },
        },
        {
          seq: 2,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
            parent_tool_use_id: null,
          },
        },
      ],
    });

    expect(useStore.getState().streaming.get("s1")).toBe("AB");
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_ack", last_seq: 2 }),
    );
  });
});

// ===========================================================================
// handleMessage: assistant
// ===========================================================================
describe("handleMessage: assistant", () => {
  it("appends a chat message and clears streaming", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set some streaming text first
    useStore.getState().setStreaming("s1", "partial text...");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const state = useStore.getState();
    const msgs = state.messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("Hello world");
    expect(msgs[0].id).toBe("msg-1");
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("running");
  });

  it("replaces a streaming draft message instead of appending a second assistant bubble", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Partial answer" } },
      parent_tool_use_id: null,
    });

    let msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].isStreaming).toBe(true);
    expect(msgs[0].content).toBe("Partial answer");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-final-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Final answer" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("msg-final-1");
    expect(msgs[0].content).toBe("Final answer");
    expect(msgs[0].isStreaming).toBeUndefined();
  });

  it("upserts assistant updates when Claude reuses the same message id", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-shared-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "thinking", thinking: "Thinking step" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-shared-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Final answer text" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("msg-shared-1");
    expect(msgs[0].contentBlocks?.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(msgs[0].content).toContain("Final answer text");
  });

  it("tracks changed files using session cwd for relative tool paths", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: { file_path: "web/server/index.ts" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().changedFilesTick.get("s1")).toBe(1);
  });

  it("does not bump changedFilesTick for files outside session cwd", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "Write",
            input: { file_path: "/Users/test/.claude/plans/example.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().changedFilesTick.get("s1")).toBeUndefined();
  });

  it("bumps changedFilesTick for absolute paths when inside cwd", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-3",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-3",
            name: "Write",
            input: { file_path: "/home/user/README.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().changedFilesTick.get("s1")).toBe(1);
  });

  it("deduplicates tool activity when the same tool_use id is replayed", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const assistantMessage = {
      type: "assistant" as const,
      message: {
        id: "msg-tool-dedupe",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use" as const,
            id: "tool-dup-1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1000,
    };

    fireMessage(assistantMessage);
    fireMessage(assistantMessage);

    expect(useStore.getState().toolActivity.get("s1")).toEqual([
      expect.objectContaining({
        toolUseId: "tool-dup-1",
        startedAt: 1000,
      }),
    ]);
  });
});

// ===========================================================================
// handleMessage: stream_event (content_block_delta)
// ===========================================================================
describe("handleMessage: stream_event content_block_delta", () => {
  it("accumulates streaming text from text_delta events", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Hello world");
  });

  it("accumulates streaming text from thinking_delta events", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Analyzing " } },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "context" } },
      parent_tool_use_id: null,
    });

    // Thinking text streams without any prefix — rendered inline as faded text via streamingPhase
    expect(useStore.getState().streaming.get("s1")).toBe("Analyzing context");
  });

  it("separates thinking and response text when both delta types stream", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Planning..." } },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Final answer" } },
      parent_tool_use_id: null,
    });

    // When text_delta arrives, streaming shows the text portion
    expect(useStore.getState().streaming.get("s1")).toBe("Final answer");
  });

  it("shows thinking text when thinking arrives after text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Plan" } },
      parent_tool_use_id: null,
    });

    // When thinking resumes, streaming shows the thinking portion
    expect(useStore.getState().streaming.get("s1")).toBe("Plan");
  });

  it("shows latest thinking when thinking resumes after response text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "A" } },
      parent_tool_use_id: null,
    });
    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
      parent_tool_use_id: null,
    });
    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "C" } },
      parent_tool_use_id: null,
    });

    // Thinking resets on phase transition — only shows "C" (not "AC")
    // because the text_delta ("B") cleared the thinking accumulator.
    expect(useStore.getState().streaming.get("s1")).toBe("C");
  });
});

// ===========================================================================
// handleMessage: stream_event (message_start)
// ===========================================================================
describe("handleMessage: stream_event message_start", () => {
  it("sets streaming start time", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    vi.setSystemTime(new Date(1700000000000));
    fireMessage({
      type: "stream_event",
      event: { type: "message_start" },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(1700000000000);
  });
});

// ===========================================================================
// handleMessage: result
// ===========================================================================
describe("handleMessage: result", () => {
  it("updates cost/turns, clears streaming, sets idle", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setStreaming("s1", "partial");
    useStore.getState().setStreamingStats("s1", { startedAt: Date.now() });

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 3,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u1",
        session_id: "s1",
      },
    });

    const state = useStore.getState();
    expect(state.sessions.get("s1")!.total_cost_usd).toBe(0.05);
    expect(state.sessions.get("s1")!.num_turns).toBe(3);
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.streamingStartedAt.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("idle");
  });

  it("clears transient streaming draft bubble when a turn ends without a final assistant message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Partial output" } },
      parent_tool_use_id: null,
    });
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u1",
        session_id: "s1",
      },
    });

    expect(useStore.getState().messages.get("s1")).toEqual([]);
  });

  it("appends a system error message when result has errors", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Something went wrong", "Another error"],
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u2",
        session_id: "s1",
      },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Error: Something went wrong, Another error");
  });
});

// ===========================================================================
// handleMessage: permission_request
// ===========================================================================
describe("handleMessage: permission_request", () => {
  it("adds permission to the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const request: PermissionRequest = {
      request_id: "req-1",
      tool_name: "Bash",
      input: { command: "rm -rf /" },
      tool_use_id: "tu-1",
      timestamp: Date.now(),
    };

    fireMessage({ type: "permission_request", request });

    const perms = useStore.getState().pendingPermissions.get("s1");
    expect(perms).toBeDefined();
    expect(perms!.get("req-1")).toBeDefined();
    expect(perms!.get("req-1")!.tool_name).toBe("Bash");
  });
});

// ===========================================================================
// handleMessage: permission_cancelled
// ===========================================================================
describe("handleMessage: permission_cancelled", () => {
  it("removes the permission from the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Add a permission first
    const request: PermissionRequest = {
      request_id: "req-1",
      tool_name: "Bash",
      input: {},
      tool_use_id: "tu-1",
      timestamp: Date.now(),
    };
    useStore.getState().addPermission("s1", request);

    fireMessage({ type: "permission_cancelled", request_id: "req-1" });

    const perms = useStore.getState().pendingPermissions.get("s1");
    expect(perms!.has("req-1")).toBe(false);
  });
});

describe("handleMessage: prompt suggestions and streamlined messages", () => {
  it("stores prompt suggestions for the active session", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "prompt_suggestion",
      suggestions: ["Summarize this change", "Write regression tests"],
    });

    expect(useStore.getState().promptSuggestions.get("s1")).toEqual([
      "Summarize this change",
      "Write regression tests",
    ]);
  });

  it("renders streamlined_text as an assistant message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "streamlined_text", text: "Rendered streamlined text" });

    expect(useStore.getState().messages.get("s1")).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Rendered streamlined text",
      }),
    ]);
  });

  it("renders streamlined_tool_use_summary as a system message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "streamlined_tool_use_summary",
      tool_summary: "Read 2 files",
    });

    expect(useStore.getState().messages.get("s1")).toEqual([
      expect.objectContaining({
        role: "system",
        content: "Read 2 files",
      }),
    ]);
  });
});

// ===========================================================================
// handleMessage: status_change (compacting)
// ===========================================================================
describe("handleMessage: status_change", () => {
  it("sets session status to compacting", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "status_change", status: "compacting" });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("compacting");
  });

  it("sets session status to arbitrary value", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "status_change", status: "running" });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
  });
});

// ===========================================================================
// handleMessage: system_event
// ===========================================================================
describe("handleMessage: system_event", () => {
  it("appends compact/task/files events as system chat messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "system_event",
      timestamp: 1500,
      event: {
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 2048 },
        uuid: "u-compact",
        session_id: "s1",
      },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Context compacted");
    expect(msgs[0].timestamp).toBe(1500);
  });

  it("ignores noisy hook_progress events in chat", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "system_event",
      event: {
        subtype: "hook_progress",
        hook_id: "hk-1",
        hook_name: "lint",
        hook_event: "post_tool_use",
        stdout: "running",
        stderr: "",
        output: "running",
        uuid: "u-hook-progress",
        session_id: "s1",
      },
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    expect(msgs).toHaveLength(0);
  });
});

// ===========================================================================
// handleMessage: cli_disconnected / cli_connected
// ===========================================================================
describe("handleMessage: cli_disconnected/connected", () => {
  it("toggles cliConnected in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    fireMessage({ type: "cli_disconnected" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();

    fireMessage({ type: "cli_connected" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
  });
});
// ===========================================================================
// handleMessage: session_phase
// ===========================================================================
describe("handleMessage: session_phase", () => {
  it("sets cliConnected=true and sessionStatus=idle for ready phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "ready", previousPhase: "initializing" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");
  });

  it("sets sessionStatus=running for streaming phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "streaming", previousPhase: "ready" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
  });

  it("sets sessionStatus=compacting for compacting phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "compacting", previousPhase: "ready" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().sessionStatus.get("s1")).toBe("compacting");
  });

  it("sets sessionStatus=running for awaiting_permission phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "awaiting_permission", previousPhase: "streaming" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
  });

  it("sets cliConnected=false for terminated phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "terminated", previousPhase: "reconnecting" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();
  });

  it("sets cliConnected=false for reconnecting phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "reconnecting", previousPhase: "ready" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();
  });

  it("sets cliConnected=false for starting phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "starting", previousPhase: "terminated" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
  });

  it("sets cliConnected=false for initializing phase", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_phase", phase: "initializing", previousPhase: "starting" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
  });
});

// ===========================================================================
// handleMessage: message_history
// ===========================================================================
describe("handleMessage: message_history", () => {
  it("reconstructs chat messages from history", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "What is 2+2?", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-hist-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "4" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
        },
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0.01,
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("What is 2+2?");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("4");
  });

  it("includes error results from history as system messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "result",
          data: {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Timed out"],
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Error: Timed out");
  });

  it("assigns stable IDs to error results based on history index", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "hi", timestamp: 1000 },
        {
          type: "result",
          data: {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Timed out"],
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    const errorMsg = msgs.find((m) => m.role === "system")!;
    expect(errorMsg.id).toBe("hist-error-1");
  });

  it("deduplicates messages on reconnection (replayed history)", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const history = {
      type: "message_history",
      messages: [
        { type: "user_message", id: "user-1", content: "hello", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
      ],
    };

    // Initial connect
    fireMessage(history);
    expect(useStore.getState().messages.get("s1")).toHaveLength(2);

    // Simulate reconnect: same history replayed
    fireMessage(history);
    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("merges assistant history entries that share a message id", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          message: {
            id: "msg-shared-history-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "thinking", thinking: "Planning..." }],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 1000,
        },
        {
          type: "assistant",
          message: {
            id: "msg-shared-history-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Final from history" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 1001,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("msg-shared-history-1");
    expect(msgs[0].contentBlocks?.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(msgs[0].content).toContain("Final from history");
  });

  it("preserves original timestamps from history instead of using Date.now()", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "hello", timestamp: 42000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 43000,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs[0].timestamp).toBe(42000);
    expect(msgs[1].timestamp).toBe(43000);
  });

  it("rebuilds tool activity from assistant tool_use and tool_result history", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().addToolActivity("s1", {
      toolUseId: "stale-tool",
      toolName: "Read",
      preview: "old.txt",
      startedAt: 1,
      elapsedSeconds: 1,
      isError: false,
    });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          message: {
            id: "msg-tool-history-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              { type: "tool_use", id: "tool-hist-1", name: "Bash", input: { command: "bun test" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
        {
          type: "assistant",
          message: {
            id: "msg-tool-history-2",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              { type: "tool_result", tool_use_id: "tool-hist-1", content: "done" },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 5000,
        },
      ],
    });

    expect(useStore.getState().toolActivity.get("s1")).toEqual([
      expect.objectContaining({
        toolUseId: "tool-hist-1",
        toolName: "Bash",
        startedAt: 2000,
        completedAt: 5000,
        elapsedSeconds: 3,
      }),
    ]);
  });

  it("reconstructs persisted system events from history and skips hook_progress", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "system_event",
          timestamp: 45000,
          event: {
            subtype: "task_notification",
            task_id: "task-1",
            status: "completed",
            output_file: "/tmp/out.txt",
            summary: "Done",
            uuid: "u-task",
            session_id: "s1",
          },
        },
        {
          type: "system_event",
          timestamp: 46000,
          event: {
            subtype: "hook_progress",
            hook_id: "hk-1",
            hook_name: "lint",
            hook_event: "post_tool_use",
            stdout: "running",
            stderr: "",
            output: "running",
            uuid: "u-hook-progress",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Task completed: task-1");
    expect(msgs[0].timestamp).toBe(45000);
  });
});

// ===========================================================================
// handleMessage: auth_status error
// ===========================================================================
describe("handleMessage: auth_status", () => {
  it("appends a system message when there is an auth error", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "auth_status",
      isAuthenticating: false,
      output: [],
      error: "Invalid API key",
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Auth error: Invalid API key");
  });

  it("does not append a message when there is no error", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Authenticating..."],
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    expect(msgs).toHaveLength(0);
  });
});

// ===========================================================================
// Task extraction: TodoWrite
// ===========================================================================
describe("task extraction: TodoWrite", () => {
  it("replaces all tasks via TodoWrite tool_use block", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tasks-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug" },
                { content: "Write tests", status: "pending", activeForm: "Writing tests" },
              ],
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subject).toBe("Fix bug");
    expect(tasks[0].status).toBe("in_progress");
    expect(tasks[0].activeForm).toBe("Fixing bug");
    expect(tasks[1].subject).toBe("Write tests");
    expect(tasks[1].status).toBe("pending");
  });
});

// ===========================================================================
// Task extraction: TaskCreate
// ===========================================================================
describe("task extraction: TaskCreate", () => {
  it("incrementally adds a task", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tc-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tc-1",
            name: "TaskCreate",
            input: { subject: "Deploy service", description: "Deploy to prod", activeForm: "Deploying service" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Deploy service");
    expect(tasks[0].description).toBe("Deploy to prod");
    expect(tasks[0].status).toBe("pending");
  });
});

// ===========================================================================
// Task extraction: TaskUpdate
// ===========================================================================
describe("task extraction: TaskUpdate", () => {
  it("updates an existing task", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Create a task first via TaskCreate
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tc-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tc-2",
            name: "TaskCreate",
            input: { subject: "Build feature" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasksBefore = useStore.getState().sessionTasks.get("s1")!;
    expect(tasksBefore[0].status).toBe("pending");

    // Update the task
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tu-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tu-1",
            name: "TaskUpdate",
            input: { taskId: "1", status: "completed" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasksAfter = useStore.getState().sessionTasks.get("s1")!;
    expect(tasksAfter[0].status).toBe("completed");
  });
});

// ===========================================================================
// handleMessage: session_name_update
// ===========================================================================
describe("handleMessage: session_name_update", () => {
  it("updates session name when current name is a random Adj+Noun name", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Current name is "Test Session" from the mock — set a random-style name
    useStore.getState().setSessionName("s1", "Swift Falcon");

    fireMessage({ type: "session_name_update", name: "Fix Authentication Bug" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Fix Authentication Bug");
  });

  it("marks session as recently renamed for animation", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set a random-style name
    useStore.getState().setSessionName("s1", "Calm River");

    fireMessage({ type: "session_name_update", name: "Deploy Dashboard" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("does not overwrite a manually-set custom name", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Manually renamed — not matching Adj+Noun pattern
    useStore.getState().setSessionName("s1", "My Custom Project");

    fireMessage({ type: "session_name_update", name: "Auto Generated Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("My Custom Project");
  });

  it("does not mark as recently renamed when name is not updated", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Custom name — won't be overwritten
    useStore.getState().setSessionName("s1", "My Custom Name");

    fireMessage({ type: "session_name_update", name: "Auto Title" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });

  it("updates name when session has no name at all", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Clear the name entirely
    const sessionNames = new Map(useStore.getState().sessionNames);
    sessionNames.delete("s1");
    useStore.setState({ sessionNames });

    fireMessage({ type: "session_name_update", name: "Brand New Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Brand New Title");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("does not overwrite multi-word custom names that happen to start capitalized", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // This matches the Adj+Noun pattern (two capitalized words)
    useStore.getState().setSessionName("s1", "Bright Falcon");
    fireMessage({ type: "session_name_update", name: "Auto Title" });
    // Should overwrite random names
    expect(useStore.getState().sessionNames.get("s1")).toBe("Auto Title");

    // But a three-word name should NOT be overwritten
    useStore.getState().setSessionName("s1", "My Cool Project");
    useStore.getState().clearRecentlyRenamed("s1");
    fireMessage({ type: "session_name_update", name: "Another Auto Title" });
    expect(useStore.getState().sessionNames.get("s1")).toBe("My Cool Project");
  });
});

// ===========================================================================
// MCP Status
// ===========================================================================

describe("MCP status messages", () => {
  it("mcp_status: stores servers in store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const servers = [
      {
        name: "test-mcp",
        status: "connected",
        config: { type: "stdio", command: "node", args: ["server.js"] },
        scope: "project",
        tools: [{ name: "myTool" }],
      },
      {
        name: "disabled-mcp",
        status: "disabled",
        config: { type: "sse", url: "http://localhost:3000" },
        scope: "user",
      },
    ];

    fireMessage({ type: "mcp_status", servers });

    const stored = useStore.getState().mcpServers.get("s1");
    expect(stored).toHaveLength(2);
    expect(stored![0].name).toBe("test-mcp");
    expect(stored![0].status).toBe("connected");
    expect(stored![0].tools).toHaveLength(1);
    expect(stored![1].name).toBe("disabled-mcp");
    expect(stored![1].status).toBe("disabled");
  });

  it("sendMcpGetStatus: sends mcp_get_status message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpGetStatus("s1");

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_get_status");
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpToggle: sends mcp_toggle message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpToggle("s1", "my-server", false);

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_toggle");
    expect(sent.serverName).toBe("my-server");
    expect(sent.enabled).toBe(false);
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpReconnect: sends mcp_reconnect message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpReconnect("s1", "failing-server");

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_reconnect");
    expect(sent.serverName).toBe("failing-server");
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpSetServers: sends mcp_set_servers message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    const servers = {
      "notes-server": {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
      },
    };
    wsModule.sendMcpSetServers("s1", servers);

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_set_servers");
    expect(sent.servers).toEqual(servers);
    expect(typeof sent.client_msg_id).toBe("string");
  });
});

// ===========================================================================
// handleMessage: tool_progress
// ===========================================================================
describe("handleMessage: tool_progress", () => {
  it("stores tool progress in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
    });

    const progress = useStore.getState().toolProgress.get("s1");
    expect(progress).toBeDefined();
    expect(progress!.get("tu-123")).toEqual({
      toolName: "Bash",
      elapsedSeconds: 5,
    });
  });

  it("updates elapsed time on subsequent messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 2,
    });
    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 7,
    });

    const entry = useStore.getState().toolProgress.get("s1")!.get("tu-123");
    expect(entry!.elapsedSeconds).toBe(7);
  });
});

// ===========================================================================
// handleMessage: tool_use_summary
// ===========================================================================
describe("handleMessage: tool_use_summary", () => {
  it("does not create a visible system message for Claude Code sessions", () => {
    // Set up sdkSessions so the handler recognises this as a Claude Code session
    useStore.setState({
      sdkSessions: [{ sessionId: "s1", backendType: "claude", cwd: "/test", state: "running", createdAt: Date.now() }],
    });
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_use_summary",
      summary: "Ran 3 tools: Bash, Read, Grep",
      tool_use_ids: ["tu-1", "tu-2", "tu-3"],
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    // Claude Code sessions already render tool_use blocks — summary is redundant
    const systemMsg = msgs.find((m) => m.role === "system" && m.content === "Ran 3 tools: Bash, Read, Grep");
    expect(systemMsg).toBeUndefined();
  });

  it("renders a system message for Codex sessions", () => {
    // Set up sdkSessions so the handler recognises this as a Codex session
    useStore.setState({
      sdkSessions: [{ sessionId: "s1", backendType: "codex", cwd: "/test", state: "running", createdAt: Date.now() }],
    });
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_use_summary",
      summary: "Ran 3 tools: Bash, Read, Grep",
      tool_use_ids: ["tu-1", "tu-2", "tu-3"],
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    // Codex may not include tool_use content blocks, so the summary is needed
    const systemMsg = msgs.find((m) => m.role === "system" && m.content === "Ran 3 tools: Bash, Read, Grep");
    expect(systemMsg).toBeDefined();
  });

  it("does not render a summary system message when backend is still unknown", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_use_summary",
      summary: "Ran 3 tools: Bash, Read, Grep",
      tool_use_ids: ["tu-1", "tu-2", "tu-3"],
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    const systemMsg = msgs.find((m) => m.role === "system" && m.content === "Ran 3 tools: Bash, Read, Grep");
    expect(systemMsg).toBeUndefined();
  });
});

// ===========================================================================
// assistant message: per-tool progress clearing (not blanket clear)
// ===========================================================================
describe("handleMessage: assistant clears only completed tool progress", () => {
  it("clears progress for tool_result blocks but keeps others", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set up progress for two concurrent tools
    useStore.getState().setToolProgress("s1", "tu-a", { toolName: "Grep", elapsedSeconds: 3 });
    useStore.getState().setToolProgress("s1", "tu-b", { toolName: "Glob", elapsedSeconds: 2 });

    // Simulate assistant message with tool_result for only tu-a
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          { type: "tool_result", tool_use_id: "tu-a", content: "3 matches" },
        ] as ContentBlock[],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const progress = useStore.getState().toolProgress.get("s1");
    // tu-a should be cleared (its result arrived)
    expect(progress?.has("tu-a")).toBeFalsy();
    // tu-b should still be present (still running)
    expect(progress?.get("tu-b")).toEqual({ toolName: "Glob", elapsedSeconds: 2 });
  });
});

// ---------------------------------------------------------------------------
// Helpers for the tests below
// ---------------------------------------------------------------------------
function sdk(sessionId: string, extra: Record<string, unknown> = {}) {
  return { sessionId, state: "connected" as const, cwd: "/home/user", createdAt: 0, ...extra };
}

/** Socket messages sent so far on `ws`, parsed. */
function sent(ws: InstanceType<typeof MockWebSocket>): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
}

function socketFor(sessionId: string) {
  return allWs.filter((w) => w.url.includes(`/ws/browser/${sessionId}?`)).at(-1);
}

// ===========================================================================
// Refusal banner
// ===========================================================================
describe("handleMessage: refusal", () => {
  it("freezes the model reported by the server on the banner", () => {
    // Retrying swaps the session model; the banner must keep the model that refused.
    useStore.getState().setSdkSessions([sdk("s1", { model: "live-model" })]);
    wsModule.connectSession("s1");
    fireMessage({ type: "refusal", category: "cyber", explanation: "Not allowed", model: "refusing-model" });

    const last = useStore.getState().messages.get("s1")!.at(-1)!;
    expect(last.role).toBe("system");
    expect(last.content).toBe("Not allowed");
    expect(last.refusal).toEqual({ category: "cyber", explanation: "Not allowed", model: "refusing-model" });

    // Changing the live model afterwards must not change what was frozen.
    useStore.getState().setSdkSessions([sdk("s1", { model: "next-model" })]);
    expect(useStore.getState().messages.get("s1")!.at(-1)!.refusal!.model).toBe("refusing-model");
  });

  it("falls back to the session model and a default text when the event omits them", () => {
    useStore.getState().setSdkSessions([sdk("s1", { model: "live-model" })]);
    wsModule.connectSession("s1");
    fireMessage({ type: "refusal" });

    const last = useStore.getState().messages.get("s1")!.at(-1)!;
    expect(last.content).toBe("The model declined to respond.");
    expect(last.refusal).toEqual({ category: undefined, explanation: undefined, model: "live-model" });
  });
});

// ===========================================================================
// Socket lifecycle: park / sync / reconnect
// ===========================================================================
describe("parkSession", () => {
  it("closes the socket without scheduling a reconnect and keeps the stream position", () => {
    // A parked session must stay closed, then resume from its last seq (not replay all).
    useStore.getState().setSdkSessions([sdk("s1")]);
    wsModule.connectSession("s1");
    const first = lastWs;
    fireMessage({ type: "cli_connected", seq: 7 });

    wsModule.parkSession("s1");
    expect(first.close).toHaveBeenCalled();
    expect(useStore.getState().connectionStatus.get("s1")).toBe("disconnected");

    // The (late) close event must not trigger the auto-reconnect.
    first.onclose?.();
    vi.advanceTimersByTime(5000);
    expect(allWs).toHaveLength(1);

    wsModule.connectSession("s1");
    lastWs.onopen!(new Event("open"));
    expect(sent(lastWs)[0]).toEqual({ type: "session_subscribe", last_seq: 7 });
  });

  it("cancels a pending reconnect timer", () => {
    useStore.getState().setSdkSessions([sdk("s1")]);
    wsModule.connectSession("s1");
    const first = lastWs;
    first.onclose!(); // schedules a reconnect in 2s
    // Nothing to close any more, but the pending timer must be cancelled.
    wsModule.parkSession("s1");
    vi.advanceTimersByTime(5000);
    expect(allWs).toEqual([first]);
  });

  it("is a no-op for a session without a socket", () => {
    wsModule.parkSession("ghost");
    expect(useStore.getState().connectionStatus.get("ghost")).toBeUndefined();
  });
});

describe("auto-reconnect", () => {
  it("reconnects a live session 2s after its socket drops", () => {
    useStore.getState().setSdkSessions([sdk("s1")]);
    wsModule.connectSession("s1");
    lastWs.onclose!();
    expect(useStore.getState().connectionStatus.get("s1")).toBe("disconnected");

    vi.advanceTimersByTime(1999);
    expect(allWs).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(allWs).toHaveLength(2);
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connecting");
  });

  it("does not reconnect an archived session", () => {
    useStore.getState().setSdkSessions([sdk("s1", { archived: true })]);
    wsModule.connectSession("s1");
    lastWs.onclose!();
    vi.advanceTimersByTime(5000);
    expect(allWs).toHaveLength(1);
  });

  it("reconnects a fresh session not yet listed only when it is the current one", () => {
    useStore.getState().setCurrentSession("fresh");
    wsModule.connectSession("fresh");
    wsModule.connectSession("other");
    socketFor("fresh")!.onclose!();
    socketFor("other")!.onclose!();
    vi.advanceTimersByTime(2000);
    expect(allWs.map((w) => w.url.split("/").pop()!.split("?")[0])).toEqual(["fresh", "other", "fresh"]);
  });

  it("schedules only one reconnect per session", () => {
    useStore.getState().setSdkSessions([sdk("s1")]);
    wsModule.connectSession("s1");
    const ws = lastWs;
    ws.onclose!();
    // A second close of the same socket is stale (already removed) and must not double up.
    ws.onclose!();
    vi.advanceTimersByTime(2000);
    expect(allWs).toHaveLength(2);
  });

  it("closes the socket on error so onclose drives the reconnect", () => {
    wsModule.connectSession("s1");
    lastWs.onerror!();
    expect(lastWs.close).toHaveBeenCalled();
  });

  it("clears the reconnect timer once the socket opens", () => {
    useStore.getState().setSdkSessions([sdk("s1")]);
    wsModule.connectSession("s1");
    lastWs.onclose!();
    vi.advanceTimersByTime(2000); // reconnect fires, new socket
    const second = lastWs;
    second.onopen!(new Event("open"));
    vi.advanceTimersByTime(5000);
    expect(allWs).toHaveLength(2);
  });

  it("disconnectSession cancels a pending reconnect", () => {
    useStore.getState().setSdkSessions([sdk("s1")]);
    wsModule.connectSession("s1");
    lastWs.onclose!();
    wsModule.disconnectSession("s1");
    vi.advanceTimersByTime(5000);
    expect(allWs).toHaveLength(1);
  });
});

describe("syncSessionSockets", () => {
  it("opens the focused session and live sessions, skipping archived and exited ones", () => {
    useStore.getState().setSdkSessions([
      sdk("live"),
      sdk("archived", { archived: true }),
      sdk("dead", { state: "exited" }),
    ]);

    wsModule.syncSessionSockets("focused");

    const ids = allWs.map((w) => w.url.split("/").pop()!.split("?")[0]).sort();
    expect(ids).toEqual(["focused", "live"]);
  });

  it("falls back to the store's current session when no focus is given", () => {
    useStore.getState().setCurrentSession("current");
    wsModule.syncSessionSockets(null);
    expect(socketFor("current")).toBeDefined();
    expect(allWs).toHaveLength(1);
  });

  it("parks sockets that are no longer wanted", () => {
    wsModule.connectSession("old");
    const old = lastWs;
    wsModule.syncSessionSockets("new");
    expect(old.close).toHaveBeenCalled();
    expect(useStore.getState().connectionStatus.get("old")).toBe("disconnected");
    // Parked: no reconnect even after its close event arrives.
    old.onclose?.();
    vi.advanceTimersByTime(5000);
    expect(allWs.filter((w) => w.url.includes("/old?"))).toHaveLength(1);
  });

  it("keeps usable sockets and replaces dead ones", () => {
    wsModule.connectSession("a");
    const a = lastWs;
    wsModule.connectSession("b");
    const b = lastWs;
    b.readyState = MockWebSocket.CLOSED;
    b.close.mockImplementation(() => { throw new Error("already closed"); });
    useStore.getState().setSdkSessions([sdk("a"), sdk("b")]);

    wsModule.syncSessionSockets(null);

    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(socketFor("a")).toBe(a);
    expect(socketFor("b")).not.toBe(b);
  });
});

describe("disconnectAll", () => {
  it("closes every open session socket", () => {
    wsModule.connectSession("a");
    wsModule.connectSession("b");
    wsModule.disconnectAll();
    expect(allWs.every((w) => w.close.mock.calls.length === 1)).toBe(true);
    expect(useStore.getState().connectionStatus.get("a")).toBe("disconnected");
    expect(useStore.getState().connectionStatus.get("b")).toBe("disconnected");
  });
});

describe("waitForConnection", () => {
  it("resolves once the socket is open", async () => {
    wsModule.connectSession("s1");
    lastWs.readyState = MockWebSocket.CONNECTING;
    const p = wsModule.waitForConnection("s1");
    vi.advanceTimersByTime(100);
    lastWs.readyState = MockWebSocket.OPEN;
    vi.advanceTimersByTime(50);
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects after 10s without an open socket", async () => {
    const p = wsModule.waitForConnection("never");
    vi.advanceTimersByTime(10_000);
    await expect(p).rejects.toThrow("Connection timeout");
  });
});

// ===========================================================================
// Focus heartbeat, history paging, misc outgoing helpers
// ===========================================================================
describe("setFocusedSession", () => {
  afterEach(() => {
    wsModule.setFocusedSession(null);
  });

  it("sends session_focus immediately and then on a 60s heartbeat", () => {
    wsModule.connectSession("s1");
    const ws = lastWs;
    wsModule.setFocusedSession("s1");
    expect(sent(ws).filter((m) => m.type === "session_focus")).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    expect(sent(ws).filter((m) => m.type === "session_focus")).toHaveLength(2);
  });

  it("moves the heartbeat to the newly focused session", () => {
    wsModule.connectSession("a");
    const a = lastWs;
    wsModule.connectSession("b");
    const b = lastWs;
    wsModule.setFocusedSession("a");
    wsModule.setFocusedSession("b");
    vi.advanceTimersByTime(60_000);
    expect(sent(a).filter((m) => m.type === "session_focus")).toHaveLength(1);
    expect(sent(b).filter((m) => m.type === "session_focus")).toHaveLength(2);
  });

  it("stops the heartbeat when focus is cleared", () => {
    wsModule.connectSession("s1");
    const ws = lastWs;
    wsModule.setFocusedSession("s1");
    wsModule.setFocusedSession(null);
    vi.advanceTimersByTime(180_000);
    expect(sent(ws).filter((m) => m.type === "session_focus")).toHaveLength(1);
  });

  it("does not claim focus while the tab is hidden", () => {
    // A hidden tab is not focus: the server must be free to reclaim the session.
    wsModule.connectSession("s1");
    const ws = lastWs;
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      wsModule.setFocusedSession("s1");
      vi.advanceTimersByTime(120_000);
      expect(sent(ws).filter((m) => m.type === "session_focus")).toHaveLength(0);
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden;
    }
  });
});

describe("page visibility", () => {
  it("reconnects and re-asserts focus on the focused session when the page becomes visible", () => {
    wsModule.setFocusedSession("s1"); // no socket yet → nothing sent
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden;
    }
    const ws = socketFor("s1")!;
    expect(ws).toBeDefined();
    expect(sent(ws)).toContainEqual(expect.objectContaining({ type: "session_focus" }));
    wsModule.setFocusedSession(null);
  });
});

describe("loadMoreHistory", () => {
  it("asks the server for the page before the loaded window", () => {
    wsModule.connectSession("s1");
    wsModule.loadMoreHistory("s1", 40);
    expect(sent(lastWs)).toContainEqual({ type: "history_load_more", before_index: 40 });
  });

  it("is dropped (not queued) while the socket is not open", () => {
    // Paging is not idempotent: a reconnect resends the window anyway.
    wsModule.connectSession("s1");
    const ws = lastWs;
    ws.readyState = MockWebSocket.CONNECTING;
    wsModule.loadMoreHistory("s1", 40);
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen!(new Event("open"));
    expect(sent(ws).map((m) => m.type)).toEqual(["session_subscribe"]);
  });
});

describe("misc outgoing helpers", () => {
  it("sendSetAiValidation sends the settings with a client_msg_id", () => {
    wsModule.connectSession("s1");
    wsModule.sendSetAiValidation("s1", { aiValidationEnabled: true, aiValidationAutoDeny: null });
    const msg = sent(lastWs)[0];
    expect(msg).toMatchObject({ type: "set_ai_validation", aiValidationEnabled: true, aiValidationAutoDeny: null });
    expect(msg.client_msg_id).toEqual(expect.stringMatching(/^cmsg-/));
  });

  it("createClientMessageId returns unique ids", () => {
    expect(wsModule.createClientMessageId()).not.toBe(wsModule.createClientMessageId());
  });

  it("resumes from the seq persisted in localStorage", () => {
    localStorage.setItem("companion:last-seq:s1", "41.7");
    wsModule.connectSession("s1");
    lastWs.onopen!(new Event("open"));
    expect(sent(lastWs)[0]).toEqual({ type: "session_subscribe", last_seq: 41 });
  });

  it("treats a corrupt persisted seq as 0", () => {
    localStorage.setItem("companion:last-seq:s1", "garbage");
    wsModule.connectSession("s1");
    lastWs.onopen!(new Event("open"));
    expect(sent(lastWs)[0]).toEqual({ type: "session_subscribe", last_seq: 0 });
  });

  it("drops messages with a seq already processed", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "error", message: "first", seq: 5 });
    fireMessage({ type: "error", message: "dup", seq: 5 });
    const contents = useStore.getState().messages.get("s1")!.map((m) => m.content);
    expect(contents).toEqual(["first"]);
  });
});

// ===========================================================================
// History paging
// ===========================================================================
describe("handleMessage: message_history paging", () => {
  function assistant(id: string, ts: number, content: ContentBlock[]) {
    return {
      type: "assistant",
      message: { id, type: "message", role: "assistant", model: "m", content, stop_reason: "end_turn", usage: {} },
      parent_tool_use_id: null,
      timestamp: ts,
    };
  }

  it("records the history window and merges an older page before what is on screen", () => {
    wsModule.connectSession("s1");
    fireMessage({
      type: "message_history",
      startIndex: 50,
      total: 60,
      messages: [{ type: "user_message", id: "u-new", content: "recent", timestamp: 2000 }],
    });
    // Live tool activity on screen must survive loading an older page.
    fireMessage(assistant("a-live", 2500, [{ type: "tool_use", id: "tu-live", name: "Bash", input: { command: "ls" } }]));

    fireMessage({
      type: "message_history",
      prepend: true,
      startIndex: 40,
      total: 60,
      messages: [
        { type: "user_message", id: "u-old", content: "older", timestamp: 1000 },
        assistant("a-old", 1100, [{ type: "tool_use", id: "tu-old", name: "Read", input: { file_path: "/x" } }]),
        { type: "result", data: { is_error: false, total_cost_usd: 1, num_turns: 2, total_lines_added: 3, total_lines_removed: 4 } },
      ],
    });

    const state = useStore.getState();
    expect(state.historyWindow.get("s1")).toEqual({ startIndex: 40, total: 60 });
    const ids = state.messages.get("s1")!.map((m) => m.id);
    expect(ids).toEqual(["u-old", "a-old", "u-new", "a-live"]);
    expect(state.toolActivity.get("s1")!.map((t) => t.toolUseId)).toEqual(["tu-old", "tu-live"]);
    expect(state.sessions.get("s1")).toBeUndefined(); // no session yet: updateSession is a no-op
  });

  it("does not reset the live turn when an older page ends with a result", () => {
    // Only the initial history may declare the turn finished.
    wsModule.connectSession("s1");
    useStore.getState().setSessionStatus("s1", "running");
    fireMessage({
      type: "message_history",
      prepend: true,
      messages: [{ type: "result", data: { is_error: false, total_cost_usd: 0, num_turns: 1 } }],
    });
    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
  });

  it("applies line counts and context usage from a history result", () => {
    useStore.getState().addSession(makeSession("s1"));
    wsModule.connectSession("s1");
    fireMessage({
      type: "message_history",
      messages: [{
        type: "result",
        data: {
          is_error: false, total_cost_usd: 2, num_turns: 3, total_lines_added: 10, total_lines_removed: 5,
          modelUsage: { m: { inputTokens: 40, outputTokens: 10, contextWindow: 100 } },
        },
      }],
    });
    expect(useStore.getState().sessions.get("s1")).toMatchObject({
      total_lines_added: 10, total_lines_removed: 5, context_used_percent: 50,
    });
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");
  });
});

// ===========================================================================
// Background processes and agents
// ===========================================================================
describe("background Bash processes", () => {
  it("registers a process when a background Bash result reports its task id", () => {
    wsModule.connectSession("s1");
    fireMessage({
      type: "assistant",
      message: {
        id: "a1", type: "message", role: "assistant", model: "m", stop_reason: "tool_use", usage: {},
        content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm run dev", description: "dev server", run_in_background: true } }],
      },
      parent_tool_use_id: null,
    });
    fireMessage({
      type: "assistant",
      message: {
        id: "a2", type: "message", role: "assistant", model: "m", stop_reason: null, usage: {},
        content: [{
          type: "tool_result", tool_use_id: "bash-1",
          content: [{ type: "text", text: "Command running in background with ID: bg42. Output is being written to: /tmp/bg42.log" }],
        }],
      },
      parent_tool_use_id: null,
    });

    const procs = useStore.getState().sessionProcesses.get("s1")!;
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({
      taskId: "bg42", toolUseId: "bash-1", command: "npm run dev", description: "dev server",
      outputFile: "/tmp/bg42.log", status: "running",
    });

    // task_notification completes the process and shows a system line.
    fireMessage({ type: "system_event", event: { subtype: "task_notification", task_id: "bg42", status: "completed", summary: "done" } });
    expect(useStore.getState().sessionProcesses.get("s1")![0]).toMatchObject({ status: "completed", summary: "done" });
    expect(useStore.getState().messages.get("s1")!.at(-1)!.content).toBe("Task completed: bg42. done");
  });

  it("ignores a background result whose text does not match the expected format", () => {
    wsModule.connectSession("s1");
    fireMessage({
      type: "permission_request",
      request: { request_id: "r1", tool_name: "Bash", tool_use_id: "bash-2", input: { run_in_background: true }, timestamp: 0 },
    });
    fireMessage({
      type: "assistant",
      message: {
        id: "a2", type: "message", role: "assistant", model: "m", stop_reason: null, usage: {},
        content: [{ type: "tool_result", tool_use_id: "bash-2", content: "permission denied" }],
      },
      parent_tool_use_id: null,
    });
    expect(useStore.getState().sessionProcesses.get("s1")).toBeUndefined();
  });
});

describe("background agents", () => {
  function agentMsg(id: string, content: unknown[]) {
    return {
      type: "assistant",
      message: { id, type: "message", role: "assistant", model: "m", stop_reason: null, usage: {}, content },
      parent_tool_use_id: null,
    };
  }

  it("tracks a background agent from launch to completion with a truncated summary", () => {
    wsModule.connectSession("s1");
    const launch = { type: "tool_use", id: "ag-1", name: "Agent", input: { description: "Scan repo", subagent_type: "explorer", run_in_background: true } };
    fireMessage(agentMsg("a1", [launch]));
    // The same tool_use replayed within the turn must not add a second agent.
    fireMessage(agentMsg("a1b", [launch]));

    let agents = useStore.getState().sessionBackgroundAgents.get("s1")!;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ toolUseId: "ag-1", name: "Scan repo", agentType: "explorer", status: "running" });

    const long = "x".repeat(250);
    fireMessage(agentMsg("a2", [{ type: "tool_result", tool_use_id: "ag-1", content: long }]));
    agents = useStore.getState().sessionBackgroundAgents.get("s1")!;
    expect(agents[0].status).toBe("completed");
    expect(agents[0].summary).toBe("x".repeat(200) + "...");
  });

  it("marks an errored agent as failed and uses defaults for missing fields", () => {
    wsModule.connectSession("s1");
    fireMessage(agentMsg("a1", [{ type: "tool_use", id: "ag-2", name: "Agent", input: { run_in_background: true } }]));
    fireMessage(agentMsg("a2", [{ type: "tool_result", tool_use_id: "ag-2", is_error: true, content: [{ type: "text", text: "boom" }] }]));

    const agent = useStore.getState().sessionBackgroundAgents.get("s1")![0];
    expect(agent).toMatchObject({ name: "Background agent", agentType: "general-purpose", status: "failed", summary: "boom" });
  });
});

// ===========================================================================
// Notifications and remaining message types
// ===========================================================================
describe("notifications when the tab is not focused", () => {
  const created: Array<{ title: string; opts: NotificationOptions }> = [];
  beforeEach(() => {
    created.length = 0;
    playNotificationSoundMock.mockReset();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.stubGlobal("Notification", class {
      static permission = "granted";
      constructor(title: string, opts: NotificationOptions) { created.push({ title, opts }); }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:3456" });
  });

  it("plays a sound and shows a desktop notification when a turn completes", () => {
    useStore.getState().setNotificationSound(true);
    useStore.getState().setNotificationDesktop(true);
    wsModule.connectSession("s1");
    fireMessage({ type: "result", data: { is_error: false, total_cost_usd: 0, num_turns: 1 } });
    expect(playNotificationSoundMock).toHaveBeenCalledOnce();
    expect(created).toEqual([{ title: "Session completed", opts: { body: "Claude finished the task", tag: "s1" } }]);
  });

  it("notifies when a permission is needed", () => {
    useStore.getState().setNotificationDesktop(true);
    wsModule.connectSession("s1");
    fireMessage({
      type: "permission_request",
      request: { request_id: "r1", tool_name: "Bash", tool_use_id: "t1", input: { command: "rm" }, timestamp: 0 },
    });
    expect(created).toEqual([{ title: "Permission needed", opts: { body: "Bash: approve or deny", tag: "r1" } }]);
  });

  it("stays silent when desktop permission was not granted", () => {
    (globalThis.Notification as unknown as { permission: string }).permission = "denied";
    useStore.getState().setNotificationDesktop(true);
    useStore.getState().setNotificationSound(false);
    wsModule.connectSession("s1");
    fireMessage({ type: "result", data: { is_error: false, total_cost_usd: 0, num_turns: 1 } });
    expect(created).toHaveLength(0);
    expect(playNotificationSoundMock).not.toHaveBeenCalled();
  });
});

describe("handleMessage: remaining message types", () => {
  it("records AI auto-resolved permissions", () => {
    wsModule.connectSession("s1");
    const request = { request_id: "r1", tool_name: "Read", tool_use_id: "t1", input: {}, timestamp: 0 };
    fireMessage({ type: "permission_auto_resolved", request, behavior: "allow", reason: "read-only" });
    expect(useStore.getState().aiResolvedPermissions.get("s1")).toEqual([
      expect.objectContaining({ request, behavior: "allow", reason: "read-only" }),
    ]);
  });

  it("stores PR status updates", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "pr_status_update", available: true, pr: null });
    expect(useStore.getState().prStatus.get("s1")).toEqual({ available: true, pr: null });
  });

  it("renders server errors as error system messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "error", message: "CLI crashed" });
    expect(useStore.getState().messages.get("s1")!.at(-1)).toMatchObject({ role: "system", content: "CLI crashed", isError: true });
  });

  it("ignores unparsable frames and unknown types without throwing", () => {
    wsModule.connectSession("s1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    lastWs.onmessage!({ data: "not json" });
    fireMessage({ type: "brand_new_type" });
    expect(warn).toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("[ws] Unhandled message type:", "brand_new_type");
    // The bad frame must not promote the connection; the valid one does.
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connected");
    warn.mockRestore();
    debug.mockRestore();
  });

  it("summarizes hook and file persistence system events", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "system_event", event: { subtype: "hook_started", hook_name: "lint", hook_event: "PostToolUse" } });
    fireMessage({ type: "system_event", event: { subtype: "hook_response", hook_name: "lint", hook_event: "PostToolUse", outcome: "success", exit_code: 0 } });
    fireMessage({ type: "system_event", event: { subtype: "hook_response", hook_name: "fmt", hook_event: "Stop", outcome: "error" } });
    fireMessage({ type: "system_event", event: { subtype: "files_persisted", files: [{}, {}], failed: [{}] } });
    expect(useStore.getState().messages.get("s1")!.map((m) => m.content)).toEqual([
      "Hook started: lint (PostToolUse).",
      "Hook success: lint (PostToolUse) (exit 0).",
      "Hook error: fmt (Stop).",
      "Persisted 2 file(s), 1 failed.",
    ]);
  });

  it("tracks output tokens from message_delta and line/context totals from result", () => {
    useStore.getState().addSession(makeSession("s1"));
    wsModule.connectSession("s1");
    fireMessage({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
    fireMessage({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 99 } }, parent_tool_use_id: null });
    expect(useStore.getState().streamingOutputTokens.get("s1")).toBe(99);

    fireMessage({
      type: "result",
      data: {
        is_error: false, total_cost_usd: 1, num_turns: 1, total_lines_added: 7, total_lines_removed: 2,
        modelUsage: { m: { inputTokens: 300, outputTokens: 0, contextWindow: 200 } },
      },
    });
    // Context % is clamped to 100.
    expect(useStore.getState().sessions.get("s1")).toMatchObject({
      total_lines_added: 7, total_lines_removed: 2, context_used_percent: 100,
    });
  });

  it("records TaskUpdate owner and blockers", () => {
    wsModule.connectSession("s1");
    fireMessage({
      type: "assistant",
      message: {
        id: "a1", type: "message", role: "assistant", model: "m", stop_reason: null, usage: {},
        content: [
          { type: "tool_use", id: "tc", name: "TaskCreate", input: { subject: "Build" } },
          { type: "tool_use", id: "tu", name: "TaskUpdate", input: { taskId: "1", owner: "agent-a", addBlockedBy: ["2"] } },
        ],
      },
      parent_tool_use_id: null,
    });
    expect(useStore.getState().sessionTasks.get("s1")![0]).toMatchObject({ owner: "agent-a", blockedBy: ["2"] });
  });

  it("treats Edit paths as in scope when the session cwd is unknown and normalizes '..'", () => {
    wsModule.connectSession("s1");
    fireMessage({
      type: "assistant",
      message: {
        id: "a1", type: "message", role: "assistant", model: "m", stop_reason: null, usage: {},
        content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/../a.ts" } }],
      },
      parent_tool_use_id: null,
    });
    expect(useStore.getState().changedFilesTick.get("s1")).toBe(1);
  });
});

// ===========================================================================
// Message times: known vs unknown send time
// ===========================================================================
// Chat bubbles show the send time. Old history entries were stored without a
// timestamp; rebuilding them used to fall back to Date.now(), which would show
// the reload time as if it were the send time. They now keep a placeholder
// (so ordering and sorting behave exactly as before) flagged timestampUnknown,
// and the UI renders no time for them. Applies to Claude and Codex alike: both
// go through the same message_history / live frames.
describe("message times: known vs unknown timestamps", () => {
  function assistantFrame(id: string, text: string, timestamp?: number) {
    return {
      type: "assistant",
      message: {
        id, type: "message", role: "assistant", model: "m",
        content: [{ type: "text", text }], stop_reason: "end_turn", usage: {},
      },
      parent_tool_use_id: null,
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
  }

  it("flags history entries without a stored timestamp and keeps their order", () => {
    vi.setSystemTime(9_000_000);
    wsModule.connectSession("s1");
    fireMessage({
      type: "message_history",
      messages: [
        // Legacy entries: no timestamp at all.
        { type: "user_message", id: "u-legacy", content: "old question" },
        assistantFrame("a-legacy", "old answer"),
        { type: "system_event", event: { subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } } },
        // Stamped entries.
        { type: "user_message", id: "u-new", content: "new question", timestamp: 5000 },
        assistantFrame("a-new", "new answer", 6000),
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    // Order is the history order, untouched.
    expect(msgs.map((m) => m.id)).toEqual(["u-legacy", "a-legacy", "hist-system-event-2", "u-new", "a-new"]);
    // Legacy: flagged, with the numeric sort key each kind used before:
    // user messages sorted as `undefined ?? 0`, the others got Date.now().
    for (const m of msgs.slice(0, 3)) expect(m.timestampUnknown).toBe(true);
    expect(msgs[0].timestamp).toBe(0);
    expect(msgs[1].timestamp).toBe(9_000_000);
    expect(msgs[2].timestamp).toBe(9_000_000);
    // Stamped: real time, not flagged.
    expect(msgs[3]).toMatchObject({ timestamp: 5000 });
    expect(msgs[3].timestampUnknown).toBeUndefined();
    expect(msgs[4]).toMatchObject({ timestamp: 6000 });
    expect(msgs[4].timestampUnknown).toBeFalsy();
  });

  // Results are stored without a time, so their "Error: …" line is unknown too.
  it("flags the error line rebuilt from a history result", () => {
    wsModule.connectSession("s1");
    fireMessage({
      type: "message_history",
      messages: [{ type: "result", data: { is_error: true, errors: ["boom"], total_cost_usd: 0, num_turns: 1 } }],
    });
    const msg = useStore.getState().messages.get("s1")![0];
    expect(msg.content).toBe("Error: boom");
    expect(msg.timestampUnknown).toBe(true);
  });

  // Older-page merge (prepend): the sort by timestamp orders an unstamped
  // history user message exactly as main did (sort key 0 → top), so a message
  // from an older page never lands below the newest live message.
  it("keeps the older-page merge order of unknown user messages", () => {
    vi.setSystemTime(9_000_000);
    wsModule.connectSession("s1");
    fireMessage({ type: "user_message", id: "u-live", content: "live", timestamp: 3000 });
    fireMessage({
      type: "message_history",
      prepend: true,
      messages: [
        { type: "user_message", id: "u-legacy", content: "legacy" },
        { type: "user_message", id: "u-old", content: "older", timestamp: 1000 },
      ],
    });
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((m) => m.id)).toEqual(["u-legacy", "u-old", "u-live"]);
    expect(msgs.find((m) => m.id === "u-legacy")!.timestampUnknown).toBe(true);
    expect(msgs.find((m) => m.id === "u-live")!.timestampUnknown).toBeUndefined();
  });

  // Reconnect: the server re-sends the whole history on every browser
  // connect. Unstamped entries must keep their place instead of taking a new
  // placeholder (reconnect time) and jumping below every stamped message.
  it("keeps unknown entries in place across a reconnect replay", () => {
    vi.setSystemTime(9_000_000);
    wsModule.connectSession("s1");
    const history = {
      type: "message_history",
      messages: [
        { type: "user_message", id: "u-legacy", content: "legacy" },
        { type: "user_message", id: "u1", content: "q", timestamp: 1000 },
        assistantFrame("a1", "answer", 2000),
        { type: "result", data: { is_error: true, errors: ["boom"], total_cost_usd: 0, num_turns: 1 } },
      ],
    };
    fireMessage(history);
    const before = useStore.getState().messages.get("s1")!;
    expect(before.map((m) => m.id)).toEqual(["u-legacy", "u1", "a1", "hist-error-3"]);

    // Reconnect much later: same history again.
    vi.setSystemTime(20_000_000);
    fireMessage(history);
    const after = useStore.getState().messages.get("s1")!;
    expect(after.map((m) => m.id)).toEqual(["u-legacy", "u1", "a1", "hist-error-3"]);
    // The unknown error line kept its first placeholder, still flagged.
    const err = after.find((m) => m.id === "hist-error-3")!;
    expect(err.timestamp).toBe(9_000_000);
    expect(err.timestampUnknown).toBe(true);
  });

  // A re-sent unknown copy of an entry whose time is already known keeps the
  // known time (the known value wins over a placeholder).
  it("keeps a known time when the re-sent copy is unknown", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "user_message", id: "u1", content: "q", timestamp: 4000 });
    fireMessage({ type: "message_history", messages: [{ type: "user_message", id: "u1", content: "q" }] });
    const msg = useStore.getState().messages.get("s1")![0];
    expect(msg.timestamp).toBe(4000);
    expect(msg.timestampUnknown).toBeUndefined();
  });

  // A placeholder is replaced when an in-place update of the same assistant
  // message carries the real time; a real time is never overwritten.
  it("adopts the real time on an in-place update of an unknown assistant message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "message_history", messages: [assistantFrame("a1", "partial")] });
    expect(useStore.getState().messages.get("s1")![0].timestampUnknown).toBe(true);

    fireMessage(assistantFrame("a1", "final", 7000));
    const updated = useStore.getState().messages.get("s1")![0];
    expect(updated.timestamp).toBe(7000);
    expect(updated.timestampUnknown).toBeFalsy();

    // A later update keeps the original (known) position/time.
    fireMessage(assistantFrame("a1", "final again", 8000));
    expect(useStore.getState().messages.get("s1")![0].timestamp).toBe(7000);
  });

  // Live frames carry server stamps (assistant/user by their builders,
  // error/refusal by the publish pipeline); missing ones are unknown.
  it("uses the server timestamp on live error and refusal frames", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "error", message: "bad", timestamp: 4242 });
    fireMessage({ type: "refusal", explanation: "no", timestamp: 4343 });
    fireMessage({ type: "error", message: "unstamped" });
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs[0]).toMatchObject({ isError: true, timestamp: 4242 });
    expect(msgs[0].timestampUnknown).toBeUndefined();
    expect(msgs[1]).toMatchObject({ timestamp: 4343 });
    expect(msgs[2].timestampUnknown).toBe(true);
  });
});
