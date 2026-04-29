# opencode-chrome

A Chrome extension that exposes browser automation as [MCP](https://modelcontextprotocol.io) tools, enabling AI coding assistants like [OpenCode](https://opencode.ai) to directly control a real Chrome browser.

## What it does

OpenCode (or any MCP client) can take screenshots, click, type, navigate, read page content, monitor console/network traffic, record GIFs, control a logged-in GLKVM remote console, and more — all through structured MCP tool calls against a live Chrome session.

## Architecture

```
OpenCode (AI)
    │  MCP protocol (stdio)
    ▼
mcp-server          — stdio MCP server exposing browser and GLKVM tools
    │  length-prefixed JSON over Unix domain socket
    ▼
native-host         — Node.js process launched by Chrome via Native Messaging
    │  Chrome Native Messaging (stdin/stdout)
    ▼
Chrome Extension    — service worker dispatches tool calls via Chrome APIs & CDP
    │
    ├── content scripts   — accessibility tree, ref-based targeting, visual indicator
    ├── side panel UI     — connection status and live tool history
    ├── GLKVM bridge      — authenticated page-context KVM control
    └── offscreen doc     — GIF encoder (pure-JS, no deps)
```

The MCP server connects to the native host over a Unix socket at `/tmp/opencode-browser-bridge-{user}/{pid}.sock`. The native host is launched automatically by Chrome when the extension first connects.

## Tools

Use `tabs_context` to discover tab IDs before targeting tab-scoped tools. Most
page/tab interaction tools require an explicit `tabId` so multiple agents can
control different tabs intentionally. `navigate` keeps `tabId` optional and
falls back to the active tab in the current window; `tabs_create` has no
`tabId` input and uses `active` (default `true`) to decide whether the new tab
is foregrounded.

| Tool | Targeting | Description |
|------|-----------|-------------|
| `computer` | requires `tabId` | Screenshots, click, double-click, right-click, type, key combos, scroll, drag |
| `navigate` | optional `tabId`; defaults to active tab | Navigate to URL, go back/forward, reload |
| `read_page` | requires `tabId` | Page as accessibility tree (with `ref_N` IDs), plain text, or HTML |
| `find` | requires `tabId` | Natural language element search returning refs and bounding rects |
| `form_input` | requires `tabId` | Set form field values by ref (inputs, selects, checkboxes, contenteditable) |
| `get_page_text` | requires `tabId` | Extract all visible text from the page |
| `javascript_tool` | requires `tabId` | Execute arbitrary JS in page context via CDP |
| `file_upload` | requires `tabId` | Upload files to a `<input type=file>` element by selector |
| `read_console_messages` | requires `tabId` | Read CDP-captured console messages |
| `read_network_requests` | requires `tabId` | Read CDP-captured network requests |
| `resize_window` | requires `tabId` | Resize the window containing the target tab |
| `tabs_context` | global discovery; no `tabId` | List all open tabs and tab groups |
| `tabs_create` | creates new tab; no `tabId` input | Open a new tab; `active` controls foregrounding |
| `tabs_close` | requires `tabId` or `tabIds` | Close one or more tabs by ID |
| `gif_creator` | requires `tabId` | Record browser actions as an animated GIF (start → screenshot → stop) |
| `glkvm_status` | optional `target` / `sessionId` | Inspect a logged-in GLKVM tab, video stream state, and optional HID session state |
| `glkvm_screenshot` | optional `target` / `sessionId` | Capture the current GLKVM video frame; optional OCR metadata may be requested |
| `glkvm_input` | optional `target` / `sessionId` | Send remote keyboard, text, mouse, drag, and scroll input through GLKVM HID |
| `glkvm_wait` | optional `target` / `sessionId` | Poll GLKVM frames until the remote display changes or the timeout expires |
| `glkvm_ocr` | optional `target` / `sessionId` | Read optional GLKVM OCR text when the device reports OCR support |

OpenCode may display MCP tools with the configured server name as a prefix, such as `opencode-chrome_glkvm_status`. The registered MCP tool names are the unprefixed names shown above.

## GLKVM control

The `glkvm_*` tools control the remote machine behind a GLKVM/KVMD web console. They do not click the Chrome page itself. Open and log in to the GLKVM web interface in Chrome first; the extension reuses that tab's cookies and `localStorage` token by running GLKVM API calls in the page context.

Target selection is intentionally conservative. If exactly one GLKVM tab is open, the tools can auto-select it. If multiple GLKVM tabs are open, pass `target` as a hostname or full URL so input cannot be sent to the wrong remote machine. If no logged-in GLKVM tab is available, auth/session errors ask you to open or re-authenticate in the GLKVM web interface.

Mouse coordinates for `glkvm_input` use GLKVM screenshot space. Use `glkvm_screenshot` first, then pass `x`, `y`, `startX`, `startY`, `endX`, and `endY` measured against the returned video-frame image. The tool maps those screenshot-space points to KVMD absolute HID coordinates internally and returns both the original screenshot coordinates and diagnostic absolute coordinates. Do not pass browser page coordinates or the returned HID absolute values back as mouse input.

Examples:

```json
{ "target": "kvm.example.com" }
```

```json
{ "target": "kvm.example.com", "action": "key", "key": "ctrl+alt+delete", "keyAction": "hotkey" }
```

```json
{ "target": "kvm.example.com", "action": "click", "x": 640, "y": 360, "button": "left" }
```

```json
{ "target": "kvm.example.com", "timeout": 5000, "pollInterval": 250 }
```

Operational guardrails:

- `target` disambiguates GLKVM tabs by URL or hostname; omit it only when one GLKVM tab is open.
- Keyboard and mouse operations attempt release-all cleanup after input, and results include cleanup status when relevant.
- `tabs_close` releases and closes tracked GLKVM HID sessions before closing a tab.
- Offline devices, missing tokens, rejected WebSockets, stale sessions, hidden video streams, and unavailable OCR return structured errors instead of silently sending input elsewhere.
- `glkvm_ocr.region` uses intrinsic remote-frame pixels; OCR can report unavailable when the GLKVM device disables OCR or does not expose text results.

See `docs/glkvm-control.md` for the detailed safety model and argument reference.

## Requirements

- Node.js ≥ 20.0.0
- macOS or Linux
- Chrome, Brave, Arc, Edge, Chromium, Vivaldi, or Opera

## Installation

### 1. Clone and install

```sh
git clone https://github.com/YOUR_USERNAME/opencode-chrome.git
cd opencode-chrome
./scripts/install.sh
```

This installs npm dependencies, builds all packages, installs the native messaging host manifests, and prints instructions for loading the extension.

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer Mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory
5. Copy the **Extension ID** shown on the card

### 3. Register the extension ID

```sh
./scripts/install.sh --extension-id=<your-extension-id>
```

This registers the ID in the native messaging manifest so Chrome allows the extension to communicate with the native host. You only need to do this once (or whenever the ID changes).

### 4. Configure OpenCode

Add to your OpenCode config (or any MCP client):

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/path/to/opencode-chrome/mcp-server/dist/index.js"]
    }
  }
}
```

## Development

```sh
./scripts/dev.sh
```

Builds `shared`, `native-host`, and `mcp-server` once, then runs the extension's esbuild in watch mode. After changing extension code, click the reload button in `chrome://extensions`. After changing `shared` or `native-host`, re-run the script.

### Build

```sh
./scripts/build.sh
# or
npm run build
```

Build outputs:
- `shared/dist/` — wire protocol types and codec
- `native-host/dist/` — `index.js` (host binary), `install.js` (manifest installer)
- `extension/dist/` — bundled service worker, content scripts, offscreen, side panel
- `mcp-server/dist/` — `index.js` (stdio MCP server)

### Test

```sh
npm test
```

Each package uses [Vitest](https://vitest.dev).

## Project structure

```
opencode-chrome/
├── shared/          # Wire protocol types, codec, tool name constants
├── extension/       # Chrome MV3 extension
│   ├── src/
│   │   ├── service-worker/   # Background service worker + tool handlers
│   │   ├── content-scripts/  # Accessibility tree, visual indicator
│   │   └── offscreen/        # GIF encoder
│   ├── sidepanel.html        # Side panel UI
│   └── manifest.json
├── native-host/     # Chrome Native Messaging host (bridges extension ↔ socket)
├── mcp-server/      # MCP stdio server (bridges OpenCode ↔ socket)
└── scripts/         # Build, install, and dev scripts
```

## Distributing to another machine

This extension requires the native host to be installed on every machine. To set up on a new machine:

1. Clone the repo
2. Run `./scripts/install.sh`
3. Load the unpacked extension in Chrome
4. Re-run `./scripts/install.sh --extension-id=<id>`

See [Chrome Web Store distribution](https://developer.chrome.com/docs/extensions/how-to/distribute/publish-to-chrome-webstore) if you want to publish publicly. Note that users would still need to run the native host installer separately, as the store only distributes the extension JS.

## License

MIT
