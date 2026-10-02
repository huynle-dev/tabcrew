# ChromeUse MCP

ChromeUse MCP gives AI assistants and other MCP clients direct, structured control of a real Chromium browser.

It combines a Chrome extension, a stdio MCP server, a localhost WebSocket bridge, and an optional native messaging host so tools can inspect pages, click elements, fill forms, capture screenshots, monitor console and network activity, run page JavaScript, manage tabs, and record GIFs from the browser you actually use.

## Why Use It

- Automate real browser workflows from any [Model Context Protocol](https://modelcontextprotocol.io) client.
- Test web apps in an actual Chromium session instead of a synthetic browser environment.
- Target elements by `ref` from the accessibility tree, by natural-language search, or by screenshot coordinates.
- Debug frontend behavior with console logs, network requests, screenshots, page text, and JavaScript evaluation.
- Keep multiple agents safer by requiring explicit `tabId` targeting for most tab-scoped tools.
- Use the extension side panel as a unified workspace surface for connection status, recent tool activity, selected local folders, and document previews.

## Feature Overview

ChromeUse MCP exposes browser automation tools plus workspace and document foundation tools:

| Category | Tools | What You Can Do |
| --- | --- | --- |
| Browser control | `computer`, `navigate`, `resize_window` | Take screenshots, click, type, press keys, scroll, drag, move the pointer, navigate, reload, go back/forward, and resize windows. |
| Page understanding | `read_page`, `get_page_text`, `find` | Read accessibility trees, HTML, text, visible page text, and find elements by human-readable descriptions. |
| Form and file workflows | `form_input`, `file_upload` | Fill inputs, selects, checkboxes, radio buttons, contenteditable fields, and file inputs. |
| File operations | `workspace_write_file`, `save_resource` | Write files inside the selected workspace and save authenticated resources to a workspace-relative path or browser Downloads. |
| Debugging | `javascript_tool`, `read_console_messages`, `read_network_requests` | Run JavaScript through Chrome DevTools Protocol and inspect captured console/network activity. |
| Synchronization | `wait_for` | Wait for a selector, page text, network idle, or a console message before continuing — reliable multi-step flows. |
| Network control | `network_intercept` | Mock, block, or fail matching requests (stub APIs, force error states). |
| Browser state | `cookies`, `storage` | Inspect and mutate cookies, `localStorage`, and `sessionStorage` (auth flows, reset state). |
| Emulation | `emulate` | Emulate device metrics, touch, user-agent, geolocation, color scheme, and network/CPU throttling. |
| Performance & capture | `performance_metrics`, `screenshot_element`, `print_to_pdf` | Capture Core Web Vitals and timings, screenshot one element, or save the page as PDF. |
| Data extraction | `extract_structured` | Extract a table or repeated list into structured JSON (optionally saved to the workspace). |
| Code quality | `coverage`, `accessibility_audit` | Report unused JS/CSS and run axe-core WCAG audits. |
| Source debugging | `debug_inspect` | Set a one-shot breakpoint and capture the frame + locals on hit. |
| Clipboard | `clipboard` | Read from and write to the system clipboard. |
| Macros | `macro` | Record, replay, and schedule UI interaction macros. |
| Tab management | `tabs_context`, `tabs_create`, `tabs_close`, `tab_session` | List/create/close tabs and tab groups, and save/restore named tab sessions. |
| Browser data | `history_search`, `bookmarks` | Search browsing history and search/list/create bookmarks. |
| Recording | `gif_creator` | Capture browser workflows as animated GIFs. |
| Direct browser decisions | `ai_action`, `ai_assert`, `ai_navigate` | Use direct Jev structured decisions to select from deterministic ChromeUse-owned actions, evaluate page conditions, or navigate one atomic action at a time. |
| Workspace foundation | workspace tools | Work with a user-selected local folder through the Chrome extension side panel and browser-granted File System Access handles. |
| Document foundation | `markdown_render` | Render safe markdown from supplied text or selected workspace files. PDF and Office viewers are placeholder/extensible shells in this foundation phase. |

See [`docs/TOOLS.md`](docs/TOOLS.md) for detailed tool inputs, targeting rules, and example workflows.

## How It Works

```text
OpenCode / MCP client
    |  MCP protocol over stdio
    v
gateway
    |\
    | \  SERVER: owns HTTP gateway at 127.0.0.1:8766
    |  \         + WebSocket bridge at ws://127.0.0.1:8765
    |   +---- PROXY: forwards to existing SERVER over HTTP
    |
    |  WebSocket-only browser path ws://127.0.0.1:8765
    v
Chrome extension

Direct fallback-capable path:

MCP client -> mcp-server -> WebSocket or native-host -> Chrome extension
```

The gateway entry point, `gateway/dist/index.js`, lets multiple OpenCode instances share one ChromeUse extension connection by default with no environment variables. The first process binds the local HTTP gateway on `127.0.0.1:8766` and owns the WebSocket bridge on `127.0.0.1:8765`. Later OpenCode instances detect that compatible gateway and become PROXY processes that forward tool calls to the SERVER instead of opening another extension bridge.

The gateway MVP is WebSocket-only for browser traffic. By default the extension auto-connects in the background to `ws://127.0.0.1:8765` and keeps the connection alive across service-worker restarts, so ChromeUse is ready to use without any manual step. The side panel still exposes **Connect**/**Disconnect** for manual control; clicking **Disconnect** opts out of background auto-connect until you click **Connect** again. Auto-connect is not a native messaging bypass and it still requires a gateway SERVER process to be running.

Native messaging remains available only on the direct `mcp-server/dist/index.js` path. In that path, the extension asks Chrome to launch the native host. The native host opens a Unix socket at `/tmp/chromeuse-browser-bridge-{user}/{pid}.sock`, and the MCP server connects to that socket when a client makes a tool call.

For more implementation detail, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Workspace and Documents

The unified workspace/document foundation is part of the ChromeUse extension. It is not a bundled copy of Chrome Reader, and it does not import Chrome Reader's full sidebar, command system, themes, Mermaid, KaTeX, or plugin stack.

The side panel can act as the user's workspace surface:

1. Open the ChromeUse side panel.
2. Select a local folder when prompted by the browser.
3. Browse the lazily loaded file tree.
4. Open markdown files in a safe preview/source flow.
5. Use workspace MCP tools and `markdown_render` where available to inspect workspace files from an MCP client.

Workspace access uses Chromium's File System Access API. The browser requires an explicit user gesture to grant folder access, and permissions can be revoked or lost after browser/profile changes. If access is lost, reselect the workspace folder from the side panel.

This foundation phase focuses on browser-only local workspace access and markdown rendering. PDF, PowerPoint, Excel, Word, binary, large-file, and unknown document support is intentionally placeholder/extensible: the UI routes these files to clear shells that explain current limits and future viewer work. Future local companion mode can move heavyweight parsing, indexing, conversion, and binary document processing outside the browser sandbox.

## Requirements

- Node.js 20 or newer
- macOS or Linux
- A Chromium-based browser: Chrome, Brave, Arc, Edge, Chromium, Vivaldi, or Opera
- An MCP client that can run a local stdio server
- An OpenRouter API key only if you want to use `ai_action`, `ai_assert`, or `ai_navigate`

Windows is not currently supported because the native host and MCP server communicate over Unix domain sockets.

## Quick Start

### 1. Clone and Install

```sh
git clone https://github.com/huynle/chromeuse-mcp.git
cd chromeuse-mcp
./scripts/install.sh
```

The installer:

- Installs npm workspace dependencies.
- Builds `shared`, `extension`, `native-host`, `mcp-server`, and `gateway`.
- Installs native messaging host manifests for supported Chromium browsers.
- Prints the extension loading instructions.

### 2. Load the Extension

1. Open `chrome://extensions` in your Chromium browser.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` directory from this repository.
5. Copy the extension ID shown on the extension card.

### 3. Register Your Extension ID

Chrome native messaging requires each extension ID to be explicitly allowed. Re-run the installer with the ID from `chrome://extensions`:

```sh
./scripts/install.sh --extension-id=<your-extension-id>
```

You can register multiple IDs in one run:

```sh
./scripts/install.sh --extension-id=<id-1> --extension-id=<id-2>
```

Or use an environment variable:

```sh
CHROMEUSE_EXTENSION_IDS=<id-1>,<id-2> ./scripts/install.sh
```

### 4. Configure Your MCP Client

For OpenCode and other clients that may start multiple ChromeUse MCP instances, use the gateway entry point. The normal setup is zero-config: use `node` with one absolute `gateway/dist/index.js` argument and no gateway environment variables.

For OpenCode, add a local MCP entry to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "chromeuse-mcp": {
      "type": "local",
      "enabled": true,
      "command": [
        "node",
        "/absolute/path/to/chromeuse-mcp/gateway/dist/index.js"
      ],
      "environment": {
        "CHROMEUSE_JEV_API_KEY": "{env:OPENROUTER_API_KEY}",
        "CHROMEUSE_JEV_BASE_URL": "https://openrouter.ai/api/v1",
        "CHROMEUSE_JEV_MODEL": "typesafe/jev-1.13"
      },
      "timeout": 120000
    }
  }
}
```

Use the absolute path to your checkout. For example, if you cloned this repository to `/Users/alice/projects/chromeuse-mcp`, use `/Users/alice/projects/chromeuse-mcp/gateway/dist/index.js`. The two-minute timeout allows autonomous `ai_navigate` calls to complete multiple inference and browser-action steps.

When OpenCode starts, the first ChromeUse MCP process becomes the gateway SERVER and listens on `127.0.0.1:8766` plus `ws://127.0.0.1:8765`. Additional OpenCode TUI instances become PROXY processes and share the same browser extension connection. Keep at least one OpenCode instance that owns the gateway running if you want the side panel to stay connected.

Other MCP clients commonly use this shape:

```json
{
  "mcpServers": {
    "chromeuse": {
      "command": "node",
      "args": ["/absolute/path/to/chromeuse-mcp/gateway/dist/index.js"]
    }
  }
}
```

Restart your MCP client after changing its config.

The three optional AI tools use OpenRouter's raw `POST /api/v1/systemone`
contract with direct `typesafe/jev-1.13`. They do not call chat completions,
Jev Router, or a fallback model. ChromeUse constructs at most 255 deterministic
atomic candidates; Jev can select only their opaque IDs. Text and URLs must be
present verbatim in quoted goal text, structured context, explicit URLs/emails/
numbers, or current page content. Missing values, visual-only tasks, low
confidence, insufficient candidates, excessive risk, malformed responses, and
cancellation stop safely instead of generating or inferring parameters.

Optional direct-Jev settings:

- `CHROMEUSE_JEV_API_KEY`: OpenRouter API key. AI tools are absent when unset.
- `CHROMEUSE_JEV_BASE_URL`: defaults to `https://openrouter.ai/api/v1`.
- `CHROMEUSE_JEV_MODEL`: defaults to `typesafe/jev-1.13`.
- `CHROMEUSE_JEV_ACTION_THRESHOLD`: defaults to `0.80`.
- `CHROMEUSE_JEV_ASSERT_THRESHOLD`: defaults to `0.80`.
- `CHROMEUSE_JEV_SUFFICIENCY_THRESHOLD`: defaults to `0.80`.
- `CHROMEUSE_JEV_MAX_AUTO_RISK`: defaults to `1.0` on Jev's 0–2 risk scale.

Thresholds are provisional and must be calibrated against recorded browser
evaluations. Invalid, nonnumeric, nonfinite, or out-of-range settings fail fast.
Keep the two-minute MCP timeout until measured live multi-step runs support a
lower value.

Optional gateway environment variables:

- `CHROMEUSE_GATEWAY_MODE`: optional. Leave unset for normal automatic gateway behavior. Unset, `auto`, or `server` uses automatic HTTP gateway election. The first process becomes SERVER; later compatible processes become PROXY automatically. Use `stdio` or `direct` only when debugging the gateway without HTTP election.
- `CHROMEUSE_HTTP_PORT`: local HTTP gateway port used by SERVER and PROXY processes. Use the same value for all OpenCode instances that should share one extension connection. Default: `8766`. The project uses `8766` instead of common app development ports such as `3000` so the HTTP gateway sits next to the WebSocket bridge default, `8765`, without colliding with typical web apps.
- `CHROMEUSE_WS_PORT`: WebSocket bridge port that the ChromeUse side panel connects to. Default: `8765`.
- `CHROMEUSE_CLIENT_ID`: optional label for identifying a client instance in logs or diagnostics.

If you need the older native messaging fallback behavior, configure the direct MCP server instead. This is a different mode from the automatic gateway: `mcp-server/dist/index.js` does not participate in HTTP SERVER/PROXY election and is intended for direct WebSocket or native messaging fallback use.

```json
{
  "mcpServers": {
    "chromeuse": {
      "command": "node",
      "args": ["/absolute/path/to/chromeuse-mcp/mcp-server/dist/index.js"]
    }
  }
}
```

Use `gateway/dist/index.js` for shared OpenCode gateway behavior. Use `mcp-server/dist/index.js` when you specifically need direct native messaging fallback.

### 5. Verify the Connection

1. Restart your MCP client so it starts `gateway/dist/index.js`.
2. Open a normal web page in the browser where the extension is loaded.
3. The extension auto-connects to the localhost WebSocket transport in the
   background. Open the ChromeUse MCP side panel from the extension toolbar to
   confirm the status shows **Connected** (or click **Connect** if you had
   previously disconnected).
4. Ask your MCP client to call `tabs_context`.
5. Use one returned `tabId` with `read_page` or `computer` screenshot.

The WebSocket bridge listens on `127.0.0.1:8765` by default. Keep that port free for the side panel Connect flow. Advanced setups can set `CHROMEUSE_WS_PORT=<port>` in the MCP client server environment, but the extension must connect to the same WebSocket URL. Gateway mode does not use native messaging fallback; configure `mcp-server/dist/index.js` directly if you need that fallback.

If the server cannot connect, see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Typical Workflows

### Inspect and Click an Element

1. Call `tabs_context` to get the target `tabId`.
2. Call `read_page` with `format: "accessibility"`.
3. Use a returned `ref_N` with `computer` action `click`, or call `find` with a natural-language query and click the returned ref.

### Fill a Form

1. Call `read_page` or `find` to locate form fields.
2. Use `form_input` with each field `ref` and desired value.
3. Use `computer` with a submit button `ref`, or press `Enter` with `computer` action `key`.

### Debug a Web App

1. Call `read_console_messages` to inspect browser logs.
2. Call `read_network_requests` to inspect recent requests.
3. Call `javascript_tool` for targeted page-state inspection.
4. Capture screenshots with `computer` to verify visual state.

### Record a GIF

1. Call `gif_creator` with `action: "start"` and a `tabId`.
2. Perform browser actions.
3. Call `gif_creator` with `action: "screenshot"` when you want to capture a frame.
4. Call `gif_creator` with `action: "stop"` to generate the GIF.

## Development

Run the development watcher:

```sh
./scripts/dev.sh
```

This builds `shared`, `native-host`, and `mcp-server` once, then starts the extension build in watch mode. After extension source changes, reload the unpacked extension in `chrome://extensions`. After changes to `shared` or `native-host`, re-run the script.

Build everything:

```sh
./scripts/build.sh
```

Run tests:

```sh
npm test
```

Clean generated output:

```sh
npm run clean
```

## Project Structure

```text
chromeuse-mcp/
├── shared/          # Wire protocol types, codecs, and tool name constants
├── extension/       # Chrome MV3 extension
│   ├── src/
│   │   ├── service-worker/   # Tool handlers, CDP, tab management, bridge logic
│   │   ├── content-scripts/  # Accessibility tree, refs, visual indicator
│   │   ├── offscreen/        # GIF encoder
│   │   └── sidepanel/        # Side panel UI, workspace tree, document preview
│   ├── sidepanel.html
│   └── manifest.json
├── native-host/     # Chrome Native Messaging host and manifest installer
├── mcp-server/      # Direct MCP stdio server with native messaging fallback
├── gateway/         # Multi-OpenCode stdio gateway with HTTP SERVER/PROXY sharing
├── scripts/         # Install, build, and development scripts
└── docs/            # User and maintainer documentation
```

## Security Notes

ChromeUse MCP intentionally gives local MCP clients powerful browser automation capabilities. Treat it like a local development tool, not a sandbox.

- Only configure MCP clients you trust.
- Tool calls can read page content, click buttons, type text, upload local files you specify, and execute JavaScript in pages.
- The extension requests broad host permissions because it is designed to automate arbitrary pages.
- Native messaging only allows registered extension IDs through Chrome's `allowed_origins` manifest field.
- The WebSocket bridge listens on localhost only and is intended for trusted local MCP clients.
- The MCP server communicates with MCP clients over stdio; it does not expose an HTTP API.

See [`SECURITY.md`](SECURITY.md) for reporting vulnerabilities and recommended safe usage.

## Troubleshooting

Common issues are documented in [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md), including the side panel Connect flow, WebSocket port conflicts, native host registration, extension IDs, browser reloads, and MCP client configuration.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening issues or pull requests.

## License

MIT. See [`LICENSE`](LICENSE).
