# TabCrew

TabCrew lets AI agents use your real browser. One local daemon serves many agents at once, and each agent works in its own isolated browser session: its own window and tab group, its own tabs, and no access to anyone else's tabs.

Agents can drive pages step by step (`observe` / `act`) or hand a whole goal to `browse`. `browse` runs the [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) loop (observe the page, choose one operation and target, act, repeat) using Jev through OpenRouter's Decisions API, plus a small text model for the values it types.

TabCrew was previously called ChromeUse. It is not affiliated with or endorsed by Google.

## Quick start

Requires macOS, Node 20+, Google Chrome (or Chromium, Brave, Edge) and, for `browse`, an OpenRouter API key.

```sh
npx tabcrew setup
```

Then install the TabCrew extension (Chrome Web Store listing pending; until then see [Development](#development)). There is no token to copy: the extension pairs with the daemon automatically. Check the installation any time with `npx tabcrew doctor`.

`setup`:

1. Moves an existing `~/.chromeuse` into `~/.tabcrew` (leaving a `~/.chromeuse` symlink) and creates the token (`~/.tabcrew/token`, mode 600).
2. Asks for your OpenRouter key (hidden input), checks it with a free OpenRouter call and stores it in `~/.tabcrew/env` (mode 600). Press Enter to skip; `browse` then reports `model_error` until a key is added.
3. Copies the self-contained runtime (`daemon.mjs`, `pair-host.mjs`) into `~/.tabcrew/app/`, so nothing depends on the npx cache.
4. Writes `~/Library/LaunchAgents/com.tabcrew.daemon.plist`, removes the old `com.chromeuse.daemon` job if present, starts the service and waits for `/health`.
5. Registers the `com.tabcrew.pair` native messaging host for Chrome (and Chromium, Brave, Edge if installed).
6. Offers to add TabCrew to OpenCode (`~/.config/opencode/opencode.json[c]`, comments preserved) and Claude Code (`claude mcp add`, user scope).

Options: `--yes` (no questions; the key comes from `$OPENROUTER_API_KEY`), `--no-harness`, `--from-source <repo>` (development).

## CLI

| Command | Does |
| --- | --- |
| `tabcrew setup` | Install or repair everything (idempotent). |
| `tabcrew doctor [--online]` | Check Node, home permissions, token, key (`--online` validates it), launchd job, `/health`, extension connection, pairing host and harness entries. Prints a one-line fix per problem; exits non-zero on failure. |
| `tabcrew token` | Print the token (the only command that does). |
| `tabcrew update` | Reinstall the runtime from the current package and restart the service. |
| `tabcrew uninstall [--purge] [--yes]` | Stop and remove the service, pairing host and runtime. `--purge` also deletes token, env, sessions, config and logs; `--yes` also removes the harness entries. |

The background service is macOS-only for now; on other platforms `setup` stops with "not supported yet" after preparing the home, and `token`/`doctor` still work.

## Architecture

```
agent harnesses (OpenCode, Claude Code, ...)
        │  MCP over streamable HTTP, Authorization: Bearer <token>
        ▼
daemon  (127.0.0.1:8770, launchd: com.tabcrew.daemon, runtime in ~/.tabcrew/app)
        │  sessions, tab ownership, per-tab queues, Jev browse loop
        │  WebSocket 127.0.0.1:8771 (same token)
        ▼
extension offscreen document   (holds the socket)
        │  chrome.runtime port
        ▼
extension service worker       (windows, tab groups, placement, pairing)
        │  chrome.debugger, one attachment per tab
        ▼
tabs
```

Pairing: when the extension has no token (or the daemon rejects it with 4401), the service worker calls `chrome.runtime.sendNativeMessage("com.tabcrew.pair", {type: "get_token"})`. Chrome starts `~/.tabcrew/app/pair-host` only for extension IDs in the host manifest's `allowed_origins`; the host re-checks the caller, replies `{token}` and exits. While unpaired the popup shows **not paired: run npx tabcrew setup** and pairing is retried every minute. A token can still be entered by hand under the popup's **Advanced** section.

| Path | Contents |
| --- | --- |
| `daemon/` | Node daemon: HTTP MCP endpoint, sessions, scheduler, Jev loop; the `tabcrew` CLI (`src/cli/`) and pairing host (`src/pair/`) |
| `cli/` | The publishable `tabcrew` npm package: esbuild bundles `dist/cli.mjs`, `dist/daemon.mjs`, `dist/pair-host.mjs` |
| `extension/` | MV3 extension: offscreen socket, service worker, CDP snapshot/act, popup, pairing |
| `shared/` | Protocol types and product constants (`@tabcrew/shared/v2`, `@tabcrew/shared/product`) |
| `docs/plans/` | Design records |

## Development

```sh
just install                 # npm install && npm run build
just setup-dev               # tabcrew setup --from-source $(pwd): launchd runs daemon/dist/index.js
```

Load the extension: open `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select `extension/dist`. Development builds carry a public `key` in their manifest, so their ID is always `aejgcpbbemekfbmmkabpbgdkgmddfamo` and the pairing host accepts them. `npm run build:store -w extension` writes `extension/dist-store/` and `extension/tabcrew-extension-<version>.zip` without `key` for the Chrome Web Store; once the store assigns an ID, add it to `TABCREW_EXTENSION_IDS.store` in `shared/src/product.ts` and rerun `tabcrew setup` (or `update`) so the host manifest allows it.

`node daemon/dist/index.js` runs the daemon in the foreground; `node daemon/dist/index.js <command>` runs any `tabcrew` command from the checkout.

## Harness configuration

`tabcrew setup` does this for you. By hand: point any MCP client that supports remote (streamable HTTP) servers at `http://127.0.0.1:8770/mcp` with the bearer token. OpenCode:

```jsonc
{
  "mcp": {
    "servers": {
      "tabcrew": {
        "type": "remote",
        "url": "http://127.0.0.1:8770/mcp",
        "headers": { "Authorization": "Bearer {file:~/.tabcrew/token}" },
        "oauth": false,
        "timeout": { "catalog": 30000, "execution": 600000 }
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add --transport http --scope user tabcrew http://127.0.0.1:8770/mcp --header "Authorization: Bearer $(npx tabcrew token)"
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

- Connection status (`not paired: run npx tabcrew setup` until pairing succeeds).
- Placement setting: new agent tabs open in **their own window** (default, fastest) or in **my current window**. Agents never switch your current tab.
- Active sessions, each with **Show** (bring its window to the front) and **Stop**, plus **Stop all**.
- **Finished** list of handed-over sessions, with **Close** per session and **Close all finished**.
- **Advanced**: manual token entry and the daemon port.

## Configuration

The daemon reads `~/.tabcrew/config.toml` (or `$TABCREW_HOME/config.toml`). Environment variables override it. The old `CHROMEUSE_*` names are still read when the `TABCREW_*` variable is unset (deprecated).

| `config.toml` key | Environment variable | Default |
| --- | --- | --- |
| `mcp_port` | `TABCREW_MCP_PORT` | `8770` |
| `extension_port` | `TABCREW_EXTENSION_PORT` | `8771` |
| `idle_timeout_minutes` (0 disables) | `TABCREW_IDLE_TIMEOUT_MINUTES` | `30` |
| `browse_concurrency` (1–64) | `TABCREW_BROWSE_CONCURRENCY` | `8` |
| `jev_model` | `JEV_MODEL` | `typesafe/jev-1.13` |
| `text_model` | `TEXT_MODEL` | `inception/mercury-2.5` |
| `allowed_origins` (array) | `TABCREW_ALLOWED_ORIGINS` (comma-separated) | none |

The following settings come from the environment (or `~/.tabcrew/env`) only:

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Key for Jev and the text model | required for `browse` |
| `TEXT_MODEL_API_KEY` | Separate key for the text model | OpenRouter key |
| `TEXT_MODEL_BASE_URL` | OpenAI-compatible base URL for the text model | OpenRouter |
| `TEXT_MODEL_REASONING` | Reasoning effort for the text model, or `none` | `none` |
| `TEXT_MODEL_FALLBACK` | Second text model tried once if the first is slow or fails; `none` disables | `google/gemini-2.5-flash-lite` |
| `TEXT_MODEL_TIMEOUT_MS` | Per-attempt budget for the text model (500–60000) | `3000` |
| `TABCREW_HOME` | Home directory for token, config, env, logs and runtime | `~/.tabcrew` |
| `TABCREW_LOG` | `debug` for verbose logs, `silent` for none | info |

## Security

- Both ports bind to `127.0.0.1` only.
- The MCP endpoint requires `Authorization: Bearer <token>`; the extension socket requires the same token. The token lives in `~/.tabcrew/token`, readable only by its owner.
- Requests with an `Origin` header not listed in `allowed_origins` are rejected, so web pages cannot call the daemon. The `Host` header must be `127.0.0.1`, `localhost` or `[::1]`.
- `debug_logs` never stores headers, cookies, bodies or query strings.
- API keys are read from the environment or `~/.tabcrew/env` only; a key in `config.toml` is ignored with a warning.
- The pairing host only answers TabCrew extension IDs (checked by Chrome via `allowed_origins` and again by the host) and never logs the token.
- Agents act in your real, signed-in browser. Only connect agents you trust.

See `SECURITY.md` for reporting vulnerabilities.

## Testing

```sh
just verify          # typecheck + offline tests + build (+ npm audit)
```

Unit tests never open a browser, call a paid API, or touch your real home directory: the CLI tests run setup/doctor/uninstall against a temp HOME with fake `launchctl`, `claude` and `fetch`. The live scripts need the daemon running and the extension connected:

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

## Recovering ChromeUse v1

The previous native-messaging version (gateway, stdio MCP server, native host, v1 extension) was removed. Restore it with:

```sh
git checkout v1-final
```

## License

MIT. See `LICENSE`.
