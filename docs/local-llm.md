# Local LLM: Claude Code sessions on your own model

Companion can run a session on a model you host (for example with vLLM) instead of the Anthropic account. The session is still **Claude Code**. Domains, memory, brains, skills, MCP servers, plugins and agents all work as usual. Only its API calls go somewhere else.

The feature is **off by default**. Turn it on in **Settings → Providers → Enable local LLM**.

## How it works

```
Companion ──spawns──▶ Claude Code ──/v1/messages──▶ Companion LLM proxy ──▶ vLLM
 (your machine)      ANTHROPIC_BASE_URL = proxy      (next to vLLM, port 8787)   (Anthropic Messages API)
                     ANTHROPIC_AUTH_TOKEN = proxy token
```

- **Companion** starts Claude Code with an environment that points at the proxy:
  - `ANTHROPIC_BASE_URL` is the proxy URL, and `ANTHROPIC_AUTH_TOKEN` is the proxy's shared token.
  - `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` are set to your model, and Claude Code runs on `--model sonnet`. It does not know your model's name, so it runs on an alias that the variables resolve to your model.
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set, together with the context and autocompact variables (see [Limits](#limits)).
  - `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are unset, along with any Bedrock or Vertex variables. This holds even when Companion's environment, an env profile or the Settings token has them.
- **The Companion LLM proxy** (`tools/llm-proxy/`) is a small service, a single file with no dependencies. It runs **on the model host, next to vLLM**. For each request it:
  - checks the shared token and **drops every credential the client sent**. Only the upstream token, if configured, goes to vLLM. It logs which kinds of credentials arrived, never their values, and logs a warning if an Anthropic token (`sk-ant-…`) ever shows up.
  - maps Claude Code's **reasoning effort** to the model's reasoning parameters (see [Reasoning levels](#reasoning-levels)).
  - rewrites `model` to the served model, and drops Anthropic-only fields (`context_management`, `output_config`, `metadata`, `thinking`, …) and server tools (web search).
  - streams the answer back as it comes (SSE).
  - answers `count_tokens` with an estimate when the server has none.
  - rewords vLLM's "maximum context length" error the way Anthropic words it, so Claude Code compacts.
  - records tokens in and out, time to first token and duration per session. These show in the session's context panel instead of the cost.

Endpoints:

| Endpoint | Token required | Purpose |
|---|---|---|
| `GET /health` | no | Answers 503 when vLLM is down |
| `GET /info` | yes | Models, context window, levels. Companion reads it |
| `GET /metrics[?session=<id>]` | yes | The recorded numbers |
| `/v1/*` | yes | Forwarded to vLLM |

## What you need

1. **vLLM with the Anthropic Messages API** (`/v1/messages`, in recent vLLM releases). It also needs tool calling (`--enable-auto-tool-choice` and the parser for your model, e.g. `--tool-call-parser qwen3_coder`) and, for thinking models, a reasoning parser (e.g. `--reasoning-parser qwen3`).
2. **Node.js ≥ 22** (or Bun) on that host, for the proxy.
3. A network path from Companion's machine to the proxy port, e.g. a LAN or a tailnet. The proxy always requires its token. Bind it to a private address when the host also has a public one.

## Install the proxy (on the model host)

```bash
git clone https://github.com/croll83/companion.git
cd companion/tools/llm-proxy
sudo ./install.sh --user <service-user> --upstream http://127.0.0.1:8000 \
     --listen 0.0.0.0:8787 --model <served-model-name> --context 131072
```

The script is idempotent and installs:

| Path | What |
|---|---|
| `/opt/companion-llm-proxy/llm-proxy.mjs` | the proxy |
| `/etc/companion-llm-proxy/config.json` | the config. Mode `0600`, owned by the service user. Created once with a new random token, which the script prints |
| `/etc/systemd/system/companion-llm-proxy.service` | a system unit with `User=<service-user>`. Enabled at boot, `Restart=always`, logs in journald |

When node comes from nvm and is not on the user's login `PATH`, add `--runtime "$(command -v node)"`.

Check that it works:

```bash
curl -s http://<proxy-host>:8787/health
curl -s -H "Authorization: Bearer <token>" http://<proxy-host>:8787/info
journalctl -u companion-llm-proxy -f
```

- **Upgrade**: `git pull`, then run `sudo ./install.sh --user <service-user>` again. It replaces the script and the unit, keeps the config, and restarts the service.
- **Change settings**: edit `/etc/companion-llm-proxy/config.json`, then `sudo systemctl restart companion-llm-proxy`.
- **Uninstall**: `sudo ./install.sh --uninstall`. Add `--purge` to also delete the config and its token.

### Config

See `tools/llm-proxy/config.example.json`.

| Field | Meaning |
|---|---|
| `listen.host`, `listen.port` | Where the proxy listens (default `0.0.0.0:8787`) |
| `upstream.url` | vLLM's URL, with or without `/v1` |
| `upstream.token` | vLLM's `--api-key`, if you set one |
| `token` | The shared secret Companion sends (at least 16 characters) |
| `model` | The served model name. Default: the first model vLLM lists |
| `contextWindow` | Published to Companion. Default: vLLM's `max_model_len` |
| `effort.levels`, `effort.default` | The reasoning levels (below) |
| `dropFields` | Request fields removed before vLLM (default: the Anthropic-only ones) |
| `keepThinking` | `true` keeps Claude Code's own `thinking` field |
| `log` | One log line per request (default on) |

## Reasoning levels

Claude Code sends the session's effort with every request (`output_config.effort`: `low`, `medium`, `high`, `xhigh` or `max`). The effort switcher changes it at runtime. Checked on Claude Code 2.1.303: `apply_flag_settings {effortLevel}` applies to the next request, with no restart.

The proxy maps each value to model parameters. The default levels fit Qwen3 chat templates:

| Claude Code effort | Model level (shown in Companion) | Parameters sent to vLLM |
|---|---|---|
| `low` | off | `chat_template_kwargs.enable_thinking = false` |
| `medium` | low | `chat_template_kwargs.reasoning_effort = "low"` |
| `high` | medium | `chat_template_kwargs.reasoning_effort = "medium"` |
| `xhigh` | xhigh | `chat_template_kwargs.reasoning_effort = "xhigh"` |

A request without an effort runs at `effort.default`. Change the table in `effort.levels` (`name`, `claude`, `params`) to fit your model. Each Claude Code value can carry one level.

Why the effort and not a header: the proxy is remote and shared, so it cannot keep per-session state. The level must travel in the request. Claude Code's own effort already does, and changes at runtime. A header (`ANTHROPIC_CUSTOM_HEADERS`) is fixed when the CLI starts, so changing it would need a relaunch.

## Companion settings

**Settings → Providers → Enable local LLM**, then **Add local provider**:

- **Name**, plus the **Proxy URL** (`http://<proxy-host>:8787`) and the **Proxy token**. The token is stored in a `0600` file under `~/.companion/local-providers/` and never returned by the API.
- **Test** reads the proxy's `/info` and fills in the models, the context window and the reasoning levels (`claude effort=model level`). You can still edit them by hand.
- Each provider's health (`/health`, every 30 s) shows as online or offline. Starting a session on an offline provider shows a warning.

Then, when you start a session, pick **Claude | Codex | Local**, then the provider and the model. Local sessions show a badge with the provider and model in the header and the sidebar. A domain can make Local the default for its new sessions (Domains → the domain → "New sessions run on"). An agent can run on a local provider too: choose "Local" in the agent editor, or `backend: "local"` with `local_provider` in the `create_agent` MCP tool.

## Limits

- **No WebSearch**: it is a server-side tool of the Anthropic API. Local sessions start with `--disallowedTools WebSearch`, and the proxy drops server tools. WebFetch still works, with its summary written by your model.
- **Context and autocompact.** Companion sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to the provider's context window. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is set to `min(32000, window / 4)`, because vLLM refuses a request whose prompt plus `max_tokens` exceeds the model length. Claude Code compacts at `window − min(max output, 20000) − 13000`, which is 98,072 tokens for a 131,072 window. Without these variables it assumes 200k for a model it does not know.
- **No provider switch in an existing session.** A local model's thinking blocks carry no signature the Anthropic API accepts, so a conversation never moves between the Anthropic account and a local provider:
  - the model switcher and the refusal fallback are hidden;
  - "Branch from session" is hidden for Local;
  - a resume or agent fork across the two is refused.
  
  To change, start a new session.
- **Ultracode, cost and usage limits** are Anthropic features. They are hidden on local sessions, and the proxy's numbers show instead of the cost.
- **Credentials.** Claude Code sends only `ANTHROPIC_AUTH_TOKEN`, the proxy token, when it is set. It wins over a stored login and over `CLAUDE_CODE_OAUTH_TOKEN`. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` also stops the start-up calls that would otherwise send the stored login token to api.anthropic.com. Check it on your setup: the proxy logs `credentials received: authorization: proxy token` for each session, and the context panel lists the same kinds. The proxy token is in the session's environment, so the session's own shell can read it. It opens the model server only.
- **Concurrency**: subagents run in parallel only as far as vLLM allows (`--max-num-seqs`).
- **Turning the switch off** stops new local sessions, agent runs and domain defaults. Sessions already on a provider keep running.
- The proxy keeps its numbers in memory, so they reset when it restarts.
