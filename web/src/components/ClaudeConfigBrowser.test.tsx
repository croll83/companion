// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockGetClaudeConfig = vi.fn();
// Config files are read through the session-scoped route (readConfigFile)
const mockReadFile = vi.fn();
const mockWriteConfigFile = vi.fn();
const mockCreateConfigFile = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    getClaudeConfig: (...args: unknown[]) => mockGetClaudeConfig(...args),
    readConfigFile: (...args: unknown[]) => mockReadFile(...args),
    writeConfigFile: (...args: unknown[]) => mockWriteConfigFile(...args),
    createConfigFile: (...args: unknown[]) => mockCreateConfigFile(...args),
    getClaudeMdFiles: vi.fn().mockResolvedValue({ files: [] }),
    saveClaudeMd: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

interface MockStoreState {
  sessions: Map<string, { cwd?: string; repo_root?: string; backend_type?: string }>;
  sdkSessions: { sessionId: string; cwd?: string; backendType?: string }[];
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessions: new Map([["s1", { cwd: "/repo", repo_root: "/repo" }]]),
    sdkSessions: [],
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

// Mock ClaudeMdEditor to avoid complex dependency
vi.mock("./ClaudeMdEditor.js", () => ({
  ClaudeMdEditor: ({ onClose, cwd, initialPath }: { onClose: () => void; cwd: string; initialPath?: string }) => (
    <div data-testid="claude-md-editor" data-cwd={cwd} data-initial-path={initialPath}>
      <button onClick={onClose}>Close Editor</button>
    </div>
  ),
}));

import { ClaudeConfigBrowser } from "./ClaudeConfigBrowser.js";

const fullConfig = {
  project: {
    root: "/repo",
    cwd: "/repo",
    claudeLocalMd: [],
    mcpJson: null,
    agents: [],
    skills: [],
    agentsMd: [],
    claudeMd: [
      { path: "/repo/CLAUDE.md", content: "# Project" },
      { path: "/repo/.claude/CLAUDE.md", content: "# Inner" },
    ],
    settings: { path: "/repo/.claude/settings.json", content: '{"key":"value"}' },
    settingsLocal: null,
    commands: [
      { name: "deploy", path: "/repo/.claude/commands/deploy.md" },
    ],
  },
  user: {
    root: "/Users/test/.claude",
    claudeMd: { path: "/Users/test/.claude/CLAUDE.md", content: "# User" },
    skills: [
      { slug: "my-skill", name: "My Skill", description: "A test skill", path: "/Users/test/.claude/skills/my-skill/SKILL.md" },
      { slug: "other-skill", name: "Other Skill", description: "Another", path: "/Users/test/.claude/skills/other-skill/SKILL.md" },
    ],
    agents: [
      { name: "researcher", path: "/Users/test/.claude/agents/researcher.md" },
    ],
    settings: { path: "/Users/test/.claude/settings.json", content: '{"global":true}' },
    settingsLocal: null,
    commands: [
      { name: "commit", path: "/Users/test/.claude/commands/commit.md" },
    ],
    codex: { root: "/Users/test/.codex", agentsMd: null, config: null },
  },
};

const emptyConfig = {
  project: {
    root: "/repo", cwd: "/repo", claudeMd: [], claudeLocalMd: [], settings: null, settingsLocal: null,
    mcpJson: null, commands: [], agents: [], skills: [], agentsMd: [],
  },
  user: {
    root: "/Users/test/.claude", claudeMd: null, skills: [], agents: [], settings: null, settingsLocal: null,
    commands: [], codex: { root: "/Users/test/.codex", agentsMd: null, config: null },
  },
};

describe("ClaudeConfigBrowser", () => {
  beforeEach(() => {
    resetStore();
    mockGetClaudeConfig.mockResolvedValue(fullConfig);
    mockReadFile.mockResolvedValue({ content: '{"test":true}' });
  });

  // Renders the component and waits for data to load
  it("renders project and user section headers after loading", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText(/Project/)).toBeInTheDocument();
      expect(screen.getByText(/User/)).toBeInTheDocument();
    });
  });

  // Checks that correct counts are displayed in section headers
  it("shows correct item counts in section headers", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      // Project: 2 claudeMd + 1 settings + 0 settingsLocal + 1 command = 4
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
      // User: 1 claudeMd + 2 skills + 1 agent + 1 settings + 1 command = 6
      expect(screen.getByText("User (6)")).toBeInTheDocument();
    });
  });

  // Sections start collapsed and expand on click
  it("expands project section on click to reveal items", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });
    // Items should not be visible before expanding
    expect(screen.queryByText("CLAUDE.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Project (4)"));
    // After expanding, project CLAUDE.md files should be visible
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText(".claude/CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("settings.json")).toBeInTheDocument();
  });

  // User section shows skills with count
  it("expands user section to show skills, agents, and commands", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("User (6)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("User (6)"));
    // Skills header with count
    expect(screen.getByText("Skills (2)")).toBeInTheDocument();
    expect(screen.getByText("My Skill")).toBeInTheDocument();
    expect(screen.getByText("Other Skill")).toBeInTheDocument();
    // Agents
    expect(screen.getByText("Agents (1)")).toBeInTheDocument();
    expect(screen.getByText("researcher")).toBeInTheDocument();
    // Commands
    expect(screen.getByText(/Commands \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("/commit")).toBeInTheDocument();
  });

  // Clicking a .md item opens the ClaudeMdEditor
  it("opens ClaudeMdEditor when clicking a CLAUDE.md item", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Project (4)"));
    fireEvent.click(screen.getByText("CLAUDE.md"));

    expect(screen.getByTestId("claude-md-editor")).toBeInTheDocument();
  });

  // Clicking a skill opens the generic markdown editor, not ClaudeMdEditor
  it("opens generic file editor when clicking a skill item", async () => {
    mockReadFile.mockResolvedValue({ content: "# My Skill\nSome content" });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("User (6)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("User (6)"));
    fireEvent.click(screen.getByText("My Skill"));

    // Generic MarkdownFileEditor shows a Save button and the file path
    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
    // "My Skill" appears in both the list row and the editor header — verify there are 2
    expect(screen.getAllByText("My Skill")).toHaveLength(2);
    // Should NOT open the ClaudeMdEditor
    expect(screen.queryByTestId("claude-md-editor")).not.toBeInTheDocument();
  });

  // settings.json used to open a read-only JSON viewer; it now opens the
  // editable ConfigFileEditor (JSON validated before save).
  it("opens an editable JSON editor when clicking settings.json", async () => {
    mockReadFile.mockResolvedValue({ content: '{"key":"value"}', format: "json", readOnly: false });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Project (4)"));
    // Find the settings.json button (not the one under User)
    const settingsButtons = screen.getAllByText("settings.json");
    fireEvent.click(settingsButtons[0]);

    // The editor shows the raw JSON in an editable textarea with a Save button
    await waitFor(() => {
      expect(screen.getByLabelText("Contents of settings.json")).toHaveValue('{"key":"value"}');
    });
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  // Handles no cwd gracefully
  it("returns null when no cwd is available", () => {
    resetStore({
      sessions: new Map([["s1", {}]]),
    });
    const { container } = render(<ClaudeConfigBrowser sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  // Handles empty config
  it("shows empty state messages when no config items exist", async () => {
    mockGetClaudeConfig.mockResolvedValue({
      ...emptyConfig,
    });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (0)")).toBeInTheDocument();
      expect(screen.getByText("User (0)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Project (0)"));
    expect(screen.getByText("No .claude config found")).toBeInTheDocument();
  });

  // Accessibility: passes axe scan
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });
    const { container } = render(<ClaudeConfigBrowser sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("ClaudeConfigBrowser: discovery, New… and Codex", () => {
  const richConfig = {
    project: {
      ...emptyConfig.project,
      cwd: "/repo/pkg",
      claudeMd: [
        { path: "/repo/pkg/CLAUDE.md", content: "# Sub" },
        { path: "/repo/CLAUDE.md", content: "# Root" },
      ],
      claudeLocalMd: [{ path: "/repo/CLAUDE.local.md", content: "# Local" }],
      settingsLocal: { path: "/repo/.claude/settings.local.json", content: "{}" },
      mcpJson: { path: "/repo/.mcp.json", content: "{}" },
      agents: [{ name: "reviewer", path: "/repo/.claude/agents/reviewer.md" }],
      skills: [{ slug: "lint", name: "lint", description: "", path: "/repo/.claude/skills/lint/SKILL.md" }],
      agentsMd: [{ path: "/repo/AGENTS.md", content: "# Agents" }],
    },
    user: {
      ...emptyConfig.user,
      claudeMd: { path: "/Users/test/.claude/CLAUDE.md", content: "# User" },
      settingsLocal: { path: "/Users/test/.claude/settings.local.json", content: "{}" },
      skills: [
        { slug: "audit", name: "audit", description: "Audits", path: "/Users/test/.claude/skills/audit/SKILL.md", source: "link" },
        { slug: "pdf", name: "pdf", description: "PDFs", path: "/Users/test/.claude/skills/synced/id/pdf/SKILL.md", source: "synced" },
      ],
      codex: {
        root: "/Users/test/.codex",
        agentsMd: { path: "/Users/test/.codex/AGENTS.md", content: "# Codex" },
        config: { path: "/Users/test/.codex/config.toml", editable: false },
      },
    },
  };

  beforeEach(() => {
    resetStore({ sessions: new Map([["s1", { cwd: "/repo/pkg", repo_root: "/repo" }]]) });
    mockGetClaudeConfig.mockReset();
    mockGetClaudeConfig.mockResolvedValue(richConfig);
    mockReadFile.mockReset();
    mockReadFile.mockResolvedValue({ content: "# x", format: "markdown", readOnly: false });
    mockCreateConfigFile.mockReset();
  });

  // Regression: the panel passed repo_root, so sub-directory CLAUDE.md files
  // were never found. It must pass the session cwd (and the session id).
  it("requests the config with the session cwd, not repo_root", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(mockGetClaudeConfig).toHaveBeenCalledWith("/repo/pkg", "s1"));
  });

  // The previously missing files are listed, labelled relative to the project root.
  it("lists sub-directory CLAUDE.md, CLAUDE.local.md, settings.local.json, .mcp.json, agents and skills", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (7)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Project (7)"));
    expect(screen.getByText("pkg/CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("CLAUDE.local.md")).toBeInTheDocument();
    expect(screen.getByText("settings.local.json")).toBeInTheDocument();
    expect(screen.getByText(".mcp.json")).toBeInTheDocument();
    expect(screen.getByText("Agents (1)")).toBeInTheDocument();
    expect(screen.getByText("Skills (1)")).toBeInTheDocument();
    // Codex-only AGENTS.md is hidden for Claude sessions
    expect(screen.queryByText("AGENTS.md")).not.toBeInTheDocument();
  });

  // Clicking a sub-directory CLAUDE.md opens ClaudeMdEditor on that very file,
  // walking from the session cwd.
  it("opens ClaudeMdEditor on the clicked CLAUDE.md from the session cwd", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (7)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Project (7)"));
    fireEvent.click(screen.getByText("pkg/CLAUDE.md"));
    const editor = screen.getByTestId("claude-md-editor");
    expect(editor).toHaveAttribute("data-cwd", "/repo/pkg");
    expect(editor).toHaveAttribute("data-initial-path", "/repo/pkg/CLAUDE.md");
    // Closing the editor refreshes the listing
    fireEvent.click(screen.getByText("Close Editor"));
    await waitFor(() => expect(mockGetClaudeConfig).toHaveBeenCalledTimes(2));
  });

  // Regression: the user CLAUDE.md opened ClaudeMdEditor on ~/.claude, which
  // offered ~/.claude/.claude/CLAUDE.md and said "Project instructions".
  it("opens the user CLAUDE.md as a single file labelled as user instructions", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("User (4)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("User (4)"));
    fireEvent.click(screen.getByText("CLAUDE.md"));
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledWith("s1", "/Users/test/.claude/CLAUDE.md"));
    expect(screen.queryByTestId("claude-md-editor")).not.toBeInTheDocument();
    expect(screen.getByText("User instructions for Claude Code (all projects)")).toBeInTheDocument();
  });

  // Synced skills are marked; symlinked ones are listed like any other.
  it("marks synced skills and lists symlinked skills", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("User (4)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("User (4)"));
    expect(screen.getByText("audit")).toBeInTheDocument();
    expect(screen.getByText("synced")).toBeInTheDocument();
    expect(screen.getByText("pdf").closest("button")).toHaveAttribute("title", "Synced from claude.ai (read-only)");
  });

  // Codex sessions see only AGENTS.md (walk-up), ~/.codex/AGENTS.md and config.toml.
  it("shows only Codex files for Codex sessions", async () => {
    resetStore({ sessions: new Map([["s1", { cwd: "/repo/pkg", backend_type: "codex" }]]) });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (1)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Project (1)"));
    fireEvent.click(screen.getByText("User (2)"));
    expect(screen.getAllByText("AGENTS.md")).toHaveLength(2);
    expect(screen.getByText("config.toml")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
    expect(screen.getByText("all sessions").closest("button")?.getAttribute("title")).toMatch(/CODEX_HOME/);
    expect(screen.queryByText("CLAUDE.local.md")).not.toBeInTheDocument();
    expect(screen.queryByText(/Skills/)).not.toBeInTheDocument();
  });

  it("shows Codex empty states and offers AGENTS.md creation", async () => {
    resetStore({ sessions: new Map([["s1", { cwd: "/repo", backend_type: "codex" }]]) });
    mockGetClaudeConfig.mockResolvedValue(emptyConfig);
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (0)")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("New user config file"));
    expect(screen.getByText("No ~/.codex config found")).toBeInTheDocument();
    const menu = screen.getByTestId("new-user-menu");
    expect(menu).toHaveTextContent("AGENTS.md");
    expect(menu).not.toHaveTextContent("Skill");
    fireEvent.click(screen.getByText("Project (0)"));
    expect(screen.getByText("No AGENTS.md found")).toBeInTheDocument();
  });

  // "New…" offers only the fixed files that don't exist yet, creates them and
  // opens the editor on the result.
  it("creates a missing fixed file from the New menu and opens it", async () => {
    mockGetClaudeConfig.mockResolvedValue(emptyConfig);
    mockCreateConfigFile.mockResolvedValue({ ok: true, path: "/repo/.mcp.json" });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (0)")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("New project config file"));
    const menu = screen.getByTestId("new-project-menu");
    expect(menu).toHaveTextContent("CLAUDE.local.md");
    fireEvent.click(screen.getByText(".mcp.json"));
    await waitFor(() => expect(mockCreateConfigFile).toHaveBeenCalledWith("s1", "project", "mcp-json", undefined));
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledWith("s1", "/repo/.mcp.json"));
    expect(screen.queryByTestId("new-project-menu")).not.toBeInTheDocument();
  });

  it("hides fixed files that already exist from the New menu", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (7)")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("New project config file"));
    const menu = screen.getByTestId("new-project-menu");
    // root CLAUDE.md, CLAUDE.local.md, settings.local.json and .mcp.json exist
    expect(menu).not.toHaveTextContent("CLAUDE");
    expect(menu).not.toHaveTextContent(".mcp.json");
    expect(menu).toHaveTextContent("settings.json");
    // Cancel closes the menu
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("new-project-menu")).not.toBeInTheDocument();
  });

  // Review finding: nothing checked that EVERY existing fixed file is left out
  // of the menu (a menu offering an existing settings.json would only get a 409).
  it("offers only the named types when every fixed file already exists", async () => {
    mockGetClaudeConfig.mockResolvedValue({
      ...richConfig,
      project: {
        ...richConfig.project,
        settings: { path: "/repo/.claude/settings.json", content: "{}" },
      },
      user: {
        ...richConfig.user,
        settings: { path: "/Users/test/.claude/settings.json", content: "{}" },
      },
    });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (8)")).toBeInTheDocument());
    for (const scope of ["project", "user"] as const) {
      fireEvent.click(screen.getByLabelText(`New ${scope} config file`));
      const options = within(screen.getByTestId(`new-${scope}-menu`)).getAllByRole("button").map((b) => b.textContent);
      expect(options).toEqual(["Command…", "Agent…", "Skill…", "Cancel"]);
      fireEvent.click(screen.getByText("Cancel"));
    }
  });

  // Codex has no named types: once AGENTS.md exists in a scope there is nothing
  // to create, so the "+" button is hidden instead of opening an empty menu.
  it("hides the New button for Codex scopes whose AGENTS.md already exists", async () => {
    resetStore({ sessions: new Map([["s1", { cwd: "/repo", backend_type: "codex" }]]) });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (1)")).toBeInTheDocument());
    expect(screen.queryByLabelText("New project config file")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New user config file")).not.toBeInTheDocument();
  });

  // Review finding: config.toml is COPIED into each session's CODEX_HOME when
  // the session is created (AGENTS.md is linked), so editing it does not reach
  // existing sessions. The row and the editor must say so.
  it("labels ~/.codex/config.toml as applying to new sessions only", async () => {
    resetStore({ sessions: new Map([["s1", { cwd: "/repo", backend_type: "codex" }]]) });
    mockGetClaudeConfig.mockResolvedValue({
      ...richConfig,
      user: { ...richConfig.user, codex: { ...richConfig.user.codex, config: { path: "/Users/test/.codex/config.toml", editable: true } } },
    });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("User (2)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("User (2)"));
    const row = screen.getByText("config.toml").closest("button")!;
    expect(row).toHaveTextContent("new sessions only");
    expect(row.getAttribute("title")).toMatch(/existing sessions keep their own copy/);
    fireEvent.click(row);
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledWith("s1", "/Users/test/.codex/config.toml"));
    expect(screen.getByRole("dialog")).toHaveTextContent("existing sessions keep their own copy");
  });

  // Creating a project CLAUDE.md opens it in ClaudeMdEditor.
  it("opens a newly created project CLAUDE.md in ClaudeMdEditor", async () => {
    mockGetClaudeConfig.mockResolvedValue(emptyConfig);
    mockCreateConfigFile.mockResolvedValue({ ok: true, path: "/repo/CLAUDE.md" });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (0)")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("New project config file"));
    fireEvent.click(screen.getByText("CLAUDE.md"));
    await waitFor(() => expect(screen.getByTestId("claude-md-editor")).toHaveAttribute("data-initial-path", "/repo/CLAUDE.md"));
  });

  // Named items ask for a name, then create; errors are shown inline.
  it("creates a named skill and shows server errors inline", async () => {
    mockCreateConfigFile.mockRejectedValueOnce(new Error("/Users/test/.claude/skills/lint/SKILL.md already exists"));
    mockCreateConfigFile.mockResolvedValueOnce({ ok: true, path: "/Users/test/.claude/skills/new-one/SKILL.md" });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("User (4)")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("New user config file"));
    fireEvent.click(screen.getByText("Skill…"));
    const input = screen.getByLabelText("New user skill name");
    // Create is disabled until a name is typed
    expect(screen.getByText("Create")).toBeDisabled();
    fireEvent.change(input, { target: { value: "lint" } });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already exists"));
    expect(mockCreateConfigFile).toHaveBeenCalledWith("s1", "user", "skill", "lint");

    fireEvent.change(input, { target: { value: "new-one" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledWith("s1", "/Users/test/.claude/skills/new-one/SKILL.md"));
  });

  it("returns from the name prompt to the option list with Back", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("User (4)")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("New user config file"));
    fireEvent.click(screen.getByText("Agent…"));
    expect(screen.getByLabelText("New user agent name")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("Command…")).toBeInTheDocument();
    // Collapsing the section also closes the menu
    fireEvent.click(screen.getByText("User (4)"));
    expect(screen.queryByTestId("new-user-menu")).not.toBeInTheDocument();
  });

  it("passes axe accessibility checks with sections and the New menu open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("Project (7)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Project (7)"));
    fireEvent.click(screen.getByLabelText("New user config file"));
    fireEvent.click(screen.getByText("Command…"));
    expect(await axe(container)).toHaveNoViolations();
  });
});
