// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock the REST client the modal talks to.
const apiMock = vi.hoisted(() => ({
  getTelegramBinding: vi.fn(),
  setTelegramBinding: vi.fn(),
  deleteTelegramBinding: vi.fn(),
  resolveTelegramUsername: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: apiMock }));

import { TelegramBridgeModal } from "./TelegramBridgeModal.js";

beforeEach(() => {
  vi.clearAllMocks(); // reset call history between tests
  apiMock.getTelegramBinding.mockResolvedValue({ binding: null });
  apiMock.setTelegramBinding.mockResolvedValue({ ok: true });
  apiMock.deleteTelegramBinding.mockResolvedValue({ ok: true, removed: true });
  apiMock.resolveTelegramUsername.mockReset();
});

function renderModal(props: Partial<Parameters<typeof TelegramBridgeModal>[0]> = {}) {
  return render(
    <TelegramBridgeModal sessionId="sess-1" sessionName="Herd" onClose={vi.fn()} {...props} />,
  );
}

describe("TelegramBridgeModal", () => {
  it("renders the dialog with the session name", async () => {
    renderModal();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText("Herd")).toBeInTheDocument();
    expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    renderModal();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    // Portal renders into document.body.
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  it("loads an existing binding into the form", async () => {
    apiMock.getTelegramBinding.mockResolvedValue({
      binding: { groupId: -100123, topicId: 3, allowlist: [111, 222], requireMention: true, enabled: true },
    });
    renderModal();
    await waitFor(() => expect(screen.getByDisplayValue("-100123")).toBeInTheDocument());
    expect(screen.getByDisplayValue("3")).toBeInTheDocument();
    // Existing binding → a "Rimuovi" (delete) button appears.
    expect(screen.getByText("Rimuovi")).toBeInTheDocument();
  });

  it("saves a valid binding with numeric allowlist ids", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("-1001234567890"), { target: { value: "-100999" } });
    fireEvent.change(screen.getByPlaceholderText("3"), { target: { value: "7" } });
    fireEvent.change(screen.getByPlaceholderText(/172751380/), { target: { value: "111\n222" } });
    fireEvent.click(screen.getByText("Salva"));

    await waitFor(() => expect(apiMock.setTelegramBinding).toHaveBeenCalled());
    expect(apiMock.setTelegramBinding).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      groupId: -100999, topicId: 7, allowlist: [111, 222],
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows an error for an invalid group id and does not save", async () => {
    renderModal();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/172751380/), { target: { value: "111" } });
    fireEvent.click(screen.getByText("Salva"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Group ID non valido/i);
    expect(apiMock.setTelegramBinding).not.toHaveBeenCalled();
  });

  it("resolves @usernames in the allowlist before saving", async () => {
    apiMock.resolveTelegramUsername.mockResolvedValue({ id: 393249644, username: "emacosc" });
    renderModal();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("-1001234567890"), { target: { value: "-100999" } });
    fireEvent.change(screen.getByPlaceholderText(/172751380/), { target: { value: "@emacosc" } });
    fireEvent.click(screen.getByText("Salva"));

    await waitFor(() => expect(apiMock.resolveTelegramUsername).toHaveBeenCalledWith("@emacosc"));
    await waitFor(() => expect(apiMock.setTelegramBinding).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      allowlist: [393249644],
    })));
  });
});
