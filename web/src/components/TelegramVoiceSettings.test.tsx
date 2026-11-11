// @vitest-environment jsdom
/**
 * The voice-notes panel of Settings → Telegram: shows the saved URL and
 * model, never the API key (only whether one is saved), saves the three
 * fields, keeps a saved key when the field is left empty, removes it on
 * request, and shows the server's error. The API is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  updateSettings: vi.fn(async (patch: Record<string, string>) => ({
    telegramSttUrl: patch.telegramSttUrl ?? "http://stt.example/v1",
    telegramSttModel: patch.telegramSttModel ?? "",
    telegramSttApiKeyConfigured: patch.telegramSttApiKey === undefined ? true : patch.telegramSttApiKey !== "",
  })),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { TelegramVoiceSettings } from "./TelegramVoiceSettings.js";

beforeEach(() => vi.clearAllMocks());

describe("TelegramVoiceSettings", () => {
  it("renders the saved URL and model, and only says a key is saved", () => {
    render(<TelegramVoiceSettings initial={{ url: "http://stt.example/v1", model: "parakeet", apiKeyConfigured: true }} />);
    expect(screen.getByLabelText("Transcription service URL")).toHaveValue("http://stt.example/v1");
    expect(screen.getByLabelText("Model (optional, default whisper-1)")).toHaveValue("parakeet");
    expect(screen.getByLabelText(/API key \(optional\): saved/)).toHaveValue("");
  });

  it("follows settings that load after the first render", () => {
    const { rerender } = render(<TelegramVoiceSettings initial={{ url: "", model: "", apiKeyConfigured: false }} />);
    rerender(<TelegramVoiceSettings initial={{ url: "http://late/v1", model: "m", apiKeyConfigured: false }} />);
    expect(screen.getByLabelText("Transcription service URL")).toHaveValue("http://late/v1");
  });

  it("saves URL, model and a new key, and keeps a saved key when the field is empty", async () => {
    render(<TelegramVoiceSettings initial={{ url: "", model: "", apiKeyConfigured: false }} />);
    fireEvent.change(screen.getByLabelText("Transcription service URL"), { target: { value: " http://stt.example/v1 " } });
    fireEvent.change(screen.getByLabelText("Model (optional, default whisper-1)"), { target: { value: "parakeet" } });
    fireEvent.change(screen.getByLabelText("API key (optional)"), { target: { value: "k-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save voice notes" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ telegramSttUrl: "http://stt.example/v1", telegramSttModel: "parakeet", telegramSttApiKey: "k-1" }));
    expect(await screen.findByText("Voice notes settings saved.")).toBeInTheDocument();
    expect(screen.getByLabelText(/API key \(optional\): saved/)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save voice notes" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenLastCalledWith({ telegramSttUrl: "http://stt.example/v1", telegramSttModel: "parakeet" }));
  });

  it("removes a saved key and shows the server's error", async () => {
    render(<TelegramVoiceSettings initial={{ url: "http://stt.example/v1", model: "", apiKeyConfigured: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove API key" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ telegramSttApiKey: "" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove API key" })).toBeNull());
    mockApi.updateSettings.mockRejectedValueOnce(new Error("telegramSttUrl must start with http:// or https://"));
    fireEvent.click(screen.getByRole("button", { name: "Save voice notes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("must start with http");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<TelegramVoiceSettings initial={{ url: "http://stt.example/v1", model: "", apiKeyConfigured: true }} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
