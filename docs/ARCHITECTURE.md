# Architecture

ChromeUse MCP is split into five workspaces plus helper scripts. The separation keeps browser-specific code in the extension, local WebSocket and MCP protocol handling in the MCP server, multi-OpenCode gateway coordination in the gateway, optional native messaging integration in the native host, and shared wire types in one package.

The unified workspace/document foundation lives inside the ChromeUse extension. It is not a bundled Chrome Reader extension. Chrome Reader-inspired behavior is limited to a small safe markdown viewing path; the full Chrome Reader sidebar, theme system, command layer, Mermaid, KaTeX, and plugin bundle remain out of scope for this foundation.

## Components

### `mcp-server`

The MCP server is a Node.js stdio server. It registers the tool schemas exposed to MCP clients and forwards tool calls through a WebSocket-first browser transport. When it is used directly, native messaging remains available as fallback through a local Unix domain socket.

Key files:

- `mcp-server/src/index.ts`: stdio entry point.
- `mcp-server/src/server.ts`: MCP server factory and tool schemas.
- `mcp-server/src/webSocketBridge.ts`: localhost WebSocket bridge for side panel Connect sessions.
- `mcp-server/src/socketClient.ts`: native host socket discovery and request forwarding.
- `mcp-server/src/directJevProvider.ts`: raw OpenRouter System One adapter, strict runtime validation, errors, cancellation, and usage metadata.
- `mcp-server/src/actionCandidates.ts`: deterministic explicit-value extraction and bounded atomic candidates.
- `mcp-server/src/aiTools.ts`: confidence/sufficiency/completion/risk gates and one-action navigation loop.

### Direct Jev Decision Boundary

`ai_action`, `ai_assert`, and `ai_navigate` are optional server-local tools. They
are registered only when a `DecisionProvider` is injected or
`CHROMEUSE_JEV_API_KEY` configures the production `DirectJevProvider`.
`createMcpServer()` accepts the provider seam directly, so tests and embedders do
not mutate process-global singleton state.

The provider sends raw HTTPS requests to OpenRouter
`POST /api/v1/systemone` using `typesafe/jev-1.13`. It validates Choice, Noul,
Score, model resolution, usage, cost, structured HTTP errors, and cancellation.
It has no browser refs and cannot execute actions.

ChromeUse owns the executable side of the boundary:

1. Read and compact the main-frame accessibility tree to at most 150 useful elements.
2. Extract only verbatim quoted values, structured context strings, URLs, email addresses, numbers, and current page values.
3. Construct no more than 255 deterministic atomic candidates with opaque IDs.
4. Ask Jev to select an ID and independently judge completion, sufficiency, and risk.
5. Apply configured gates and resolve the ID only through ChromeUse's current candidate map.
6. Revalidate ref-based candidates against a fresh accessibility read, execute at
   most one accepted action, reread the page, and repeat.

No provider output becomes an executable ref, value, URL, key, or direction. No
chat completion, Jev Router, generated JSON plan, or fallback model exists in
this path. A missing explicit value, unsupported visual task, uncertain or
conflicting decision, excessive risk, malformed response, provider failure, or
cancellation produces a structured stop reason.

### `gateway`

The gateway is the recommended OpenCode entry point when multiple OpenCode instances may share one ChromeUse extension connection. It exposes the same MCP tools over stdio to each client process, but coordinates browser access through one local HTTP gateway and one WebSocket bridge. Normal OpenCode configuration starts `node /absolute/path/to/gateway/dist/index.js` with no environment variables; automatic SERVER/PROXY election is the default behavior.

Key files:

- `gateway/src/index.ts`: stdio gateway entry point.
- `gateway/src/gatewayRuntime.ts`: SERVER/PROXY election and lifecycle.
- `gateway/src/gatewayServer.ts`: local HTTP `/health` and `/tool` endpoints.
- `gateway/src/httpGatewayTransport.ts`: PROXY transport for forwarding tool calls to an existing SERVER.
- `gateway/src/requestQueue.ts`: serializes browser tool requests through the shared WebSocket bridge.

Gateway automatic SERVER/PROXY election is the default for `gateway/dist/index.js`. The first process that can bind the local HTTP port, `127.0.0.1:8766` by default, becomes SERVER. If another gateway process starts with the same HTTP port and finds a compatible `/health` response, it becomes PROXY and forwards tool calls to the SERVER over HTTP. Explicit `CHROMEUSE_GATEWAY_MODE=stdio` or `direct` is retained only as a debugging escape hatch, not as normal setup.

Gateway browser traffic is WebSocket-only in the MVP. The SERVER owns the WebSocket bridge to the extension, and PROXY processes never open native messaging sessions. Direct `mcp-server/dist/index.js` keeps native messaging fallback for users who need Chrome native messaging behavior.

### `native-host`

The native host is launched by Chromium through Native Messaging when the fallback path is used. It bridges Chrome's stdin/stdout native messaging channel to a Unix socket used by the MCP server.

Key files:

- `native-host/src/index.ts`: native host runtime entry point.
- `native-host/src/socketServer.ts`: Unix socket server for MCP server requests.
- `native-host/src/chromeNativeHost.ts`: Chrome native messaging integration.
- `native-host/src/install.ts`: native messaging manifest installer.

The installer writes `com.chromeuse.mcp_bridge.json` manifests into supported browser profile config directories and creates a wrapper script at `~/.chromeuse/native-host`.

### `extension`

The extension is a Manifest V3 Chromium extension. Its service worker receives tool requests from either the localhost WebSocket connection or the native host and executes them using Chrome extension APIs, Chrome DevTools Protocol, injected content scripts, and an offscreen document.

Key files:

- `extension/src/service-worker/index.ts`: service worker startup.
- `extension/src/service-worker/messageRouter.ts`: tool request routing.
- `extension/src/service-worker/webSocketConnection.ts`: WebSocket client used by the side panel Connect flow.
- `extension/src/service-worker/tools/`: individual tool handlers.
- `extension/src/service-worker/cdp.ts`: Chrome DevTools Protocol helpers.
- `extension/src/content-scripts/accessibilityTree.ts`: accessibility extraction and element refs.
- `extension/src/content-scripts/visualIndicator.ts`: automation indicator and stop control.
- `extension/src/offscreen/`: GIF capture and encoding.
- `extension/src/sidepanel/`: side panel status, history, workspace tree, and document preview UI.

### `shared`

The shared package defines cross-component constants, message shapes, and length-prefixed JSON helpers.

Key files:

- `shared/src/tools.ts`: tool name constants.
- `shared/src/messages.ts`: message contracts.
- `shared/src/lengthPrefixed.ts`: length-prefixed JSON codec.

## Workspace and Document Foundation

The side panel is the user-facing workspace surface. It combines the existing connection controls and tool history with local folder selection, lazy file-tree browsing, and document routing.

Workspace access is browser-mediated:

1. The side panel asks the user to select a directory through Chromium's File System Access API.
2. The browser grants a `FileSystemDirectoryHandle` only after a user gesture.
3. The extension stores recoverable handle metadata in extension storage/IndexedDB so the workspace can be restored when browser policy permits it.
4. Each restored handle must still pass permission checks before files are listed or read.
5. If permission is denied, revoked, or unavailable, the side panel shows a reselect-workspace action instead of silently failing.

The file tree is intentionally lazy. Directory reads are bounded by depth and entry limits so large repositories do not block the side panel or service worker. File selection updates side-panel state and routes the selected entry to the document viewer layer.

Document routing is isolated from tree rendering. Markdown files route to the safe markdown preview/source flow. Text files can use lightweight browser reads. PDF, PowerPoint, Excel, Word, binary, large-file, and unknown files route to placeholder shells that explain that full review/edit support is future work.

### Workspace MCP Tools

Workspace MCP tools are extension-backed tools that operate on the currently selected workspace and its browser-granted handles. They should follow the same request path as browser tools: MCP client to `gateway` or `mcp-server`, then WebSocket or native messaging to the extension service worker depending on the configured entry point.

The foundation tools are expected to cover these capabilities:

- Report current workspace status and permission state.
- List workspace directories/files with lazy depth and entry limits.
- Read selected workspace file content when the browser grants access.
- Return actionable errors for missing workspace selection, permission loss, unsupported browser APIs, large files, and binary files.

The markdown render tool, `markdown_render`, is the first document-focused MCP tool. It renders markdown from direct text input or, where workspace access is available, from a selected workspace file. Raw HTML is disabled or sanitized by default.

### Browser-Only Boundary

This foundation intentionally stays within the browser extension sandbox. The browser can read only files the user has selected and permissioned. Heavyweight document conversion, filesystem indexing, OCR, and robust PDF/Office parsing are deferred to a future local companion direction that can run outside Chrome's extension constraints.

## Request Flow

```text
OpenCode / MCP client
    |  MCP protocol over stdio
    v
gateway
    |\
    | \  SERVER owns HTTP 127.0.0.1:8766
    |  \         + ws://127.0.0.1:8765
    |   +---- PROXY forwards to SERVER over local HTTP
    v
Chrome extension

Direct fallback-capable path:

MCP client -> mcp-server -> WebSocket or native-host -> Chrome extension
```

### Gateway SERVER/PROXY Path

1. OpenCode starts `node gateway/dist/index.js` as a stdio process.
2. Local HTTP gateway coordination starts automatically by default; no `CHROMEUSE_GATEWAY_MODE` setting is required for normal setup.
3. The first process binds `127.0.0.1:<CHROMEUSE_HTTP_PORT>` and becomes SERVER. The default HTTP gateway port is `8766`.
4. The SERVER starts one WebSocket bridge on `127.0.0.1:<CHROMEUSE_WS_PORT>`. The default WebSocket bridge port is `8765`.
5. The user opens the ChromeUse side panel and clicks **Connect**.
6. Later OpenCode instances start the same gateway entry point, fail to bind the occupied HTTP port, probe `/health`, and become PROXY if the existing SERVER is compatible.
7. PROXY instances accept MCP stdio calls from their own OpenCode process and forward `/tool` requests to the SERVER over HTTP.
8. The SERVER queues and sends browser requests over the single WebSocket connection to the extension.

Configuration variables:

- `CHROMEUSE_GATEWAY_MODE`: optional. Leave unset for normal setup. Unset, `auto`, or `server` enables SERVER/PROXY behavior. `stdio` or `direct` bypasses gateway election for debugging.
- `CHROMEUSE_HTTP_PORT`: local HTTP gateway port shared by all OpenCode instances. Default: `8766`, chosen as the project default to avoid common application development ports such as `3000` and to sit adjacent to the WebSocket default `8765`.
- `CHROMEUSE_WS_PORT`: extension WebSocket bridge port. Default: `8765`.
- `CHROMEUSE_CLIENT_ID`: optional client identifier for logs or diagnostics.
- `CHROMEUSE_JEV_API_KEY`: enables the optional direct-Jev decision tools.
- `CHROMEUSE_JEV_BASE_URL`: defaults to `https://openrouter.ai/api/v1`.
- `CHROMEUSE_JEV_MODEL`: defaults to `typesafe/jev-1.13`.
- `CHROMEUSE_JEV_ACTION_THRESHOLD`, `CHROMEUSE_JEV_ASSERT_THRESHOLD`, and `CHROMEUSE_JEV_SUFFICIENCY_THRESHOLD`: finite 0–1 gates, each defaulting to `0.80`.
- `CHROMEUSE_JEV_MAX_AUTO_RISK`: finite 0–2 maximum accepted risk, default `1.0`.

### Direct WebSocket Connect Path (`mcp-server/dist/index.js`)

1. An MCP client starts `node mcp-server/dist/index.js` as a stdio process.
2. The MCP server starts a WebSocket bridge on `127.0.0.1:8765`, or on `CHROMEUSE_WS_PORT` when that environment variable is set.
3. The user opens the ChromeUse side panel and clicks **Connect**.
4. The extension service worker opens `ws://127.0.0.1:8765` and keeps reconnecting while Connect remains active.
5. Tool calls flow from the MCP client to the MCP server, over WebSocket to the extension, and back through the same path.

The Connect button only attaches the extension to the MCP server's localhost WebSocket bridge. It does not bypass native messaging policy for the native host path, and it cannot work unless the MCP server process is already running.

### Direct Native Messaging Fallback Path (`mcp-server/dist/index.js`)

1. An MCP client starts `node mcp-server/dist/index.js` as a stdio process.
2. The MCP client calls a ChromeUse MCP tool.
3. The MCP server validates the tool name and uses native messaging when no WebSocket extension is connected.
4. The native host receives the length-prefixed JSON request and forwards it to the extension through Chrome Native Messaging.
5. The service worker dispatches the request to the relevant tool handler.
6. The handler uses Chrome APIs, CDP, content scripts, or the offscreen document to execute the action.
7. The result returns through the same path to the MCP client.

## Native Messaging Registration

Chromium only allows native messaging from explicitly listed extension origins. The installer supports this by accepting one or more extension IDs:

```sh
./scripts/install.sh --extension-id=<id>
```

The generated native messaging manifest contains:

- `name`: `com.chromeuse.mcp_bridge`
- `path`: wrapper script path
- `type`: `stdio`
- `allowed_origins`: `chrome-extension://<id>/` values

The gateway does not bypass or replace this policy. Gateway MVP traffic reaches the extension through the side panel WebSocket connection only. Native messaging registration matters for the direct `mcp-server/dist/index.js` path and for any browser profile where direct native fallback is required.

## Build Order

`scripts/build.sh` builds packages in dependency order:

1. `shared`
2. `native-host`
3. `extension`
4. `mcp-server`
5. `gateway`

The extension build uses esbuild. The TypeScript packages use `tsc`.

## Security Boundaries

ChromeUse MCP is designed for trusted local automation. The meaningful safety boundaries are:

- Chrome's native messaging `allowed_origins` list limits which extension IDs can launch the host.
- The WebSocket bridge binds to `127.0.0.1` and is intended for local MCP clients only.
- MCP clients connect over stdio. In gateway SERVER mode, the local HTTP gateway and WebSocket bridge both bind to localhost.
- Gateway PROXY processes forward to a compatible localhost SERVER; they do not connect directly to the extension.
- The native host socket is local to the machine.
- Most browser actions require explicit `tabId` targeting.
- Workspace file access is scoped by Chromium File System Access permissions and can disappear when the user revokes access, the profile changes, or policy disables the API.

These boundaries do not make untrusted MCP clients safe. A trusted client can still read browser content, click authenticated pages, type text, upload specified files, and execute JavaScript in tabs.

Workspace tools can also read files from a user-selected local folder. Only configure trusted MCP clients when a workspace is selected.
