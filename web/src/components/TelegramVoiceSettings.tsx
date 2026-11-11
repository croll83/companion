import { useEffect, useId, useState } from "react";
import { api } from "../api.js";

export interface TelegramVoiceValues {
  url: string;
  model: string;
  apiKeyConfigured: boolean;
}

const field = "w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow";

/**
 * Voice notes on the Telegram bridge (Settings → Telegram): the
 * OpenAI-compatible transcription service the bridge sends them to (OpenAI,
 * Groq, a local Whisper or Parakeet server), its model and optional API key.
 * Empty URL = voice notes off: the bot then says so instead of answering.
 * The key is never sent back to the page, only whether one is saved.
 */
export function TelegramVoiceSettings({ initial }: { initial: TelegramVoiceValues }) {
  const [url, setUrl] = useState(initial.url);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(initial.apiKeyConfigured);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const ids = { url: useId(), model: useId(), key: useId() };

  // The settings load after the first render.
  useEffect(() => {
    setUrl(initial.url);
    setModel(initial.model);
    setKeyConfigured(initial.apiKeyConfigured);
  }, [initial.url, initial.model, initial.apiKeyConfigured]);

  const save = async (patch: { telegramSttUrl?: string; telegramSttModel?: string; telegramSttApiKey?: string }) => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await api.updateSettings(patch);
      setUrl(res.telegramSttUrl);
      setModel(res.telegramSttModel);
      setKeyConfigured(res.telegramSttApiKeyConfigured);
      setApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="group" aria-label="Telegram voice notes" className="space-y-2 pt-2 border-t border-cc-separator">
      <p className="text-sm font-medium">Telegram voice notes</p>
      <p className="text-xs text-cc-muted">
        Le note vocali (e i file audio) arrivano alla sessione come testo: il bridge le manda a un servizio di trascrizione
        compatibile OpenAI (<code className="font-mono-code">/v1/audio/transcriptions</code>: OpenAI, Groq, un server Whisper o
        Parakeet locale) e risponde su Telegram con la trascrizione. Senza indirizzo le note vocali sono spente.
      </p>
      <label htmlFor={ids.url} className="block text-xs text-cc-muted">Transcription service URL</label>
      <input id={ids.url} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.openai.com/v1" className={`${field} font-mono-code`} />
      <label htmlFor={ids.model} className="block text-xs text-cc-muted">Model (optional, default whisper-1)</label>
      <input id={ids.model} value={model} onChange={(e) => setModel(e.target.value)} placeholder="whisper-1" className={`${field} font-mono-code`} />
      <label htmlFor={ids.key} className="block text-xs text-cc-muted">
        API key (optional){keyConfigured ? ": saved, leave empty to keep it" : ""}
      </label>
      <input id={ids.key} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={`${field} font-mono-code`} />
      {error && <div role="alert" className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">{error}</div>}
      {saved && <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">Voice notes settings saved.</div>}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save({ telegramSttUrl: url.trim(), telegramSttModel: model.trim(), ...(apiKey.trim() ? { telegramSttApiKey: apiKey.trim() } : {}) })}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save voice notes"}
        </button>
        {keyConfigured && (
          <button type="button" disabled={saving} onClick={() => void save({ telegramSttApiKey: "" })} className="text-xs text-cc-error hover:underline cursor-pointer disabled:opacity-50">
            Remove API key
          </button>
        )}
      </div>
    </div>
  );
}
