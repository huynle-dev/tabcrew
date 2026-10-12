# ChromeUse

ChromeUse lets AI agents use your real Chrome. One local daemon serves many agents at once, and each agent works in its own isolated browser session: its own window and tab group, its own tabs, and no access to anyone else's tabs.

Agents can drive pages step by step (`observe` / `act`) or hand a whole goal to `browse`. `browse` runs the [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) loop (observe the page, choose one operation and target, act, repeat) using Jev through OpenRouter's Decisions API, plus a small text model for the values it types.

## Architecture

```
agent harnesses (OpenCode, Claude Code, ...)
        │  MCP over streamable HTTP, Authorization: Bearer <token>
        ▼
daemon  (127.0.0.1:8770, launchd: com.chromeuse.daemon)
        │  sessions, tab ownership, per-tab queues, Jev browse loop
        │  WebSocket 127.0.0.1:8771 (same token)
        ▼
extension offscreen document   (holds the socket)
        │  chrome.runtime port
        ▼
extension service worker       (windows, tab groups, placement)
        │  chrome.debugger, one attachment per tab
        ▼
tabs
```

| Path | Contents |
| --- | --- |
| `daemon/` | Node daemon: HTTP MCP endpoint, sessions, scheduler, Jev loop, CLI (`token`, `install-launchd`) |
| `extension-v2/` | MV3 extension: offscreen socket, service worker, CDP snapshot/act, popup |
| `shared/` | Protocol types shared by the daemon and the extension (`@chromeuse/shared/v2`) |
| `docs/plans/` | Design records |

## Install

Requires Node 20+, Chrome, macOS (for launchd) and an OpenRouter API key.

1. Build:

   ```sh
   just install        # npm install && npm run build
   ```

2. Load the extension: open `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select `extension-v2/dist`.

3. Store the OpenRouter key where the daemon reads it (never in `config.toml`):

   ```sh
   mkdir -p ~/.chromeuse
   echo 'OPENROUTER_API_KEY=sk-or-...' > ~/.chromeuse/env
   chmod 600 ~/.chromeuse/env
   ```

   The daemon skips this file if it is readable by group or other.

4. Run the daemon under launchd:

   ```sh
   node daemon/dist/index.js install-launchd
   # then run the "launchctl bootstrap gui/$(id -u) ..." command it prints
   ```

5. Print the token with `just token` (creates `~/.chromeuse/token` on first run) and paste it into the extension popup. The popup should show **connected**.

## Harness configuration

Point any MCP client that supports remote (streamable HTTP) servers at `http://127.0.0.1:8770/mcp` with the bearer token. OpenCode:

```jsonc
{
  "mcp": {
    "chromeuse": {
      "type": "remote",
      "url": "http://127.0.0.1:8770/mcp",
      "headers": { "Authorization": "Bearer {file:~/.chromeuse/token}" }
    }
  }
}
```

## Tools

Every tool except `session_open` takes the `session` handle; tab tools also take `tab_id`.

| Tool | Purpose |
| --- | --- |
| `session_open` | Open a private session (optional `label` shown on the tab group) and get its handle. |
| `session_close` | Finish the session and hand its tabs to the user; the agent loses control of them. |
| `tab_create` | Open a background tab in the session, optionally at a URL. Returns `tab_id`. |
| `tab_list` | List the session's own tabs. |
| `tab_close` | Close one of the session's tabs. |
| `screenshot` | Capture the visible part of a tab (jpeg or png). |
| `observe` | URL, title, visible text, numbered element table with supported operations, and a fingerprint for `act`. |
| `act` | One operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`) against the latest observation; returns `stale_page` if the page changed. |
| `browse` | Let Jev pursue a natural-language goal until DONE, BLOCKED, no progress, `max_steps` or Stop. Returns status, step trace, final page and model usage/cost. |
| `navigate` | Open an http(s) URL, or go back/forward/reload; waits for load (up to 15 s). |
| `read_text` | Full text of the page (not just the visible part), up to `max_length`. |
| `debug_logs` | Recent console messages or network requests of a tab. |

## Agent etiquette

- Call `session_open` once per agent or subagent, and never share the handle.
- Prefer `browse` for multi-step goals and `observe` / `act` for precise control. `browse` returning DONE is a claim, so check the page with `observe`, `read_text` or `screenshot`.
- Close throwaway tabs with `tab_close` when you are done with them.
- Call `session_close` when finished. Remaining tabs move into the user's window as a collapsed `✓ <label>` group for review. Sessions left open are handed over the same way when the agent's connection ends or after the idle timeout.

## Extension popup

- Connection status and the daemon token field (plus the daemon port).
- Placement setting: new agent tabs open in **their own window** (default, fastest) or in **my current window**. Agents never switch your current tab.
- Active sessions, each with **Show** (bring its window to the front) and **Stop**, plus **Stop all**.
- **Finished** list of handed-over sessions, with **Close** per session and **Close all finished**.

## Configuration

The daemon reads `~/.chromeuse/config.toml` (or `$CHROMEUSE_HOME/config.toml`). Environment variables override it.

| `config.toml` key | Environment variable | Default |
| --- | --- | --- |
| `mcp_port` | `CHROMEUSE_MCP_PORT` | `8770` |
| `extension_port` | `CHROMEUSE_EXTENSION_PORT` | `8771` |
| `idle_timeout_minutes` (0 disables) | `CHROMEUSE_IDLE_TIMEOUT_MINUTES` | `30` |
| `browse_concurrency` (1–64) | `CHROMEUSE_BROWSE_CONCURRENCY` | `8` |
| `jev_model` | `JEV_MODEL` | `typesafe/jev-1.13` |
| `text_model` | `TEXT_MODEL` | `inception/mercury-2.5` |
| `allowed_origins` (array) | `CHROMEUSE_ALLOWED_ORIGINS` (comma-separated) | none |

The following settings come from the environment (or `~/.chromeuse/env`) only:

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Key for Jev and the text model | required for `browse` |
| `TEXT_MODEL_API_KEY` | Separate key for the text model | OpenRouter key |
| `TEXT_MODEL_BASE_URL` | OpenAI-compatible base URL for the text model | OpenRouter |
| `TEXT_MODEL_REASONING` | Reasoning effort for the text model, or `none` | `none` |
| `TEXT_MODEL_FALLBACK` | Second text model tried once if the first is slow or fails; `none` disables | `google/gemini-2.5-flash-lite` |
| `TEXT_MODEL_TIMEOUT_MS` | Per-attempt budget for the text model (500–60000) | `3000` |
| `CHROMEUSE_HOME` | Home directory for token, config and env | `~/.chromeuse` |
| `CHROMEUSE_LOG` | `debug` for verbose logs | info |

## Security

- Both ports bind to `127.0.0.1` only.
- The MCP endpoint requires `Authorization: Bearer <token>`; the extension socket requires the same token. The token lives in `~/.chromeuse/token`, readable only by its owner.
- Requests with an `Origin` header not listed in `allowed_origins` are rejected, so web pages cannot call the daemon. The `Host` header must be `127.0.0.1`, `localhost` or `[::1]`.
- `debug_logs` never stores headers, cookies, bodies or query strings.
- API keys are read from the environment or `~/.chromeuse/env` only; a key in `config.toml` is ignored with a warning.
- Agents act in your real, signed-in browser. Only connect agents you trust.

See `SECURITY.md` for reporting vulnerabilities.

## Testing

```sh
just verify          # typecheck + offline tests + build (+ npm audit)
```

Unit tests never open a browser or call a paid API. The live scripts need the daemon running and the extension connected:

| Recipe | Checks | Cost |
| --- | --- | --- |
| `just smoke` | sessions, tabs, screenshot, navigate, read_text, debug_logs | free |
| `just isolation` | three parallel sessions stay isolated | free |
| `just guards` | freshness and occlusion guards on local fixture pages | free |
| `just concurrency` | latency of concurrent calls across sessions | free |
| `just live` | `browse` on Wikipedia and Google Flights | **paid** (OpenRouter) |

Measured on the development machine: the 3-agent isolation run went from 20.6 s to 1.95 s after moving the socket into the offscreen document; live `browse` takes about 3.6–10 s on Wikipedia and 10–20 s on Google Flights.

## Known limitations

- Scrolling inside inner panels is not supported; `SCROLL_UP` / `SCROLL_DOWN` scroll the page.
- Jev does not yet close popups or overlays that cover its target.
- `tab_create` returns before the page has loaded; use `navigate` or `browse` next.
- Background tabs are slower in "My current window" placement because Chrome throttles tabs you aren't looking at.
- No iframes, shadow DOM, canvas content or file uploads.

## Recovering v1

The previous native-messaging version (gateway, stdio MCP server, native host, v1 extension) was removed. Restore it with:

```sh
git checkout v1-final
```

## License

MIT. See `LICENSE`.
