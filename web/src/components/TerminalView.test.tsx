// @vitest-environment jsdom
/**
 * Tests for TerminalView: the xterm.js view backed by a server-side PTY.
 *
 * xterm, the fit addon, the terminal WebSocket and the REST API are mocked so
 * the test can drive the lifecycle directly. Validates:
 * - a PTY is spawned on the host for the given cwd and its socket is wired up
 * - PTY output / exit / error messages reach the terminal
 * - spawn failures are reported inside the terminal
 * - unmount tears everything down and kills the PTY
 * - header (title, close button) and the accessory bar forward user input
 * - accessibility (axe scan)
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const { MockTerminal, xtermInstances } = vi.hoisted(() => {
  const instances: Array<InstanceType<typeof Mock>> = [];
  class Mock {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    write = vi.fn();
    writeln = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    dispose = vi.fn();
    dataHandler: ((data: string) => void) | null = null;
    onData = vi.fn((cb: (data: string) => void) => {
      this.dataHandler = cb;
      return { dispose: vi.fn() };
    });
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      instances.push(this);
    }
  }
  return { MockTerminal: Mock, xtermInstances: instances };
});

vi.mock("@xterm/xterm", () => ({ Terminal: MockTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

interface Callbacks {
  onData: (data: string) => void;
  onExit: (code: number) => void;
  onError: (msg: string) => void;
  onOpen: () => void;
}
let lastCallbacks: Callbacks | null = null;
const connection = {
  sendInput: vi.fn(),
  sendResize: vi.fn(),
  disconnect: vi.fn(),
};
const mockCreateConnection = vi.fn((_id: string, cbs: Callbacks) => {
  lastCallbacks = cbs;
  return connection;
});
vi.mock("../terminal-ws.js", () => ({
  createTerminalConnection: (id: string, cbs: Callbacks) => mockCreateConnection(id, cbs),
}));

const mockSpawnTerminal = vi.fn();
const mockKillTerminal = vi.fn();
vi.mock("../api.js", () => ({
  api: {
    spawnTerminal: (...args: unknown[]) => mockSpawnTerminal(...args),
    killTerminal: (...args: unknown[]) => mockKillTerminal(...args),
  },
}));

const mockSetTerminalId = vi.fn();
const storeState = { darkMode: false, setTerminalId: mockSetTerminalId };
vi.mock("../store.js", () => {
  const useStore = (selector: (s: typeof storeState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return { useStore };
});

vi.mock("./TerminalAccessoryBar.js", () => ({
  TerminalAccessoryBar: ({ onWrite }: { onWrite: (d: string) => void }) => (
    <button type="button" onClick={() => onWrite("\x03")}>Send Ctrl-C</button>
  ),
}));

import { TerminalView } from "./TerminalView.js";

beforeAll(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: () => Promise.resolve([]) },
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe = vi.fn();
    disconnect = vi.fn();
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  xtermInstances.length = 0;
  lastCallbacks = null;
  mockSpawnTerminal.mockResolvedValue({ terminalId: "term-1" });
  mockKillTerminal.mockResolvedValue({ ok: true });
});

async function renderStarted(ui: React.ReactElement) {
  const result = render(ui);
  await waitFor(() => expect(mockCreateConnection).toHaveBeenCalled());
  return result;
}

describe("TerminalView", () => {
  it("spawns a host PTY in the given cwd and connects its socket", async () => {
    await renderStarted(<TerminalView cwd="/repo" />);

    // Only cwd and size are sent — there is no container target anymore.
    expect(mockSpawnTerminal).toHaveBeenCalledWith("/repo", 80, 24);
    expect(mockSetTerminalId).toHaveBeenCalledWith("term-1");
    expect(mockCreateConnection).toHaveBeenCalledWith("term-1", expect.any(Object));
    expect(xtermInstances[0].open).toHaveBeenCalled();
  });

  it("writes PTY output, exit and error messages into the terminal", async () => {
    await renderStarted(<TerminalView cwd="/repo" />);
    const xterm = xtermInstances[0];

    act(() => {
      lastCallbacks!.onData("hello");
      lastCallbacks!.onExit(3);
      lastCallbacks!.onError("socket closed");
      lastCallbacks!.onOpen();
    });

    expect(xterm.write).toHaveBeenCalledWith("hello");
    expect(xterm.writeln).toHaveBeenCalledWith("\r\n[Process exited with code 3]");
    expect(xterm.writeln).toHaveBeenCalledWith("\r\n[socket closed]");
    // Opening the socket pushes the fitted size to the PTY.
    expect(connection.sendResize).toHaveBeenCalledWith(80, 24);
  });

  it("forwards keyboard input from xterm to the PTY", async () => {
    await renderStarted(<TerminalView cwd="/repo" />);
    act(() => xtermInstances[0].dataHandler!("ls\r"));
    expect(connection.sendInput).toHaveBeenCalledWith("ls\r");
  });

  it("reports a spawn failure inside the terminal", async () => {
    mockSpawnTerminal.mockRejectedValue(new Error("no shell"));
    render(<TerminalView cwd="/repo" />);

    await waitFor(() => {
      expect(xtermInstances[0]?.writeln).toHaveBeenCalledWith("\r\n[Failed to start terminal: no shell]");
    });
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("tears down the socket and kills the PTY on unmount", async () => {
    const { unmount } = await renderStarted(<TerminalView cwd="/repo" />);
    unmount();

    expect(connection.disconnect).toHaveBeenCalled();
    expect(xtermInstances[0].dispose).toHaveBeenCalled();
    expect(mockKillTerminal).toHaveBeenCalledWith("term-1");
  });

  it("shows the title in the header and calls onClose from the close button", async () => {
    const onClose = vi.fn();
    await renderStarted(<TerminalView cwd="/repo" title="my shell" onClose={onClose} />);

    expect(screen.getByText("my shell")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("falls back to the cwd as header label and hides the header on request", async () => {
    const { unmount } = await renderStarted(<TerminalView cwd="/repo/web" />);
    expect(screen.getByText("/repo/web")).toBeInTheDocument();
    unmount();

    await renderStarted(<TerminalView cwd="/repo/web" embedded hideHeader />);
    expect(screen.queryByText("/repo/web")).not.toBeInTheDocument();
  });

  it("sends accessory bar keys to the PTY", async () => {
    await renderStarted(<TerminalView cwd="/repo" embedded />);
    fireEvent.click(screen.getByRole("button", { name: "Send Ctrl-C" }));
    expect(connection.sendInput).toHaveBeenCalledWith("\x03");
  });

  it("passes axe accessibility checks with header and close button", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = await renderStarted(
      <TerminalView cwd="/repo" title="my shell" onClose={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
