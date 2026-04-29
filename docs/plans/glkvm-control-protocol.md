# GLKVM Control Protocol Validation

> Phase 0 spike for GLKVM Control Tools feature.
> Validated against live GLKVM V1.9.0 release1 (RM1) at `kvm.huynle.com`.
> KVMD API version: 4.82

## 1. Authentication & Session Model

### Token Storage

The GLKVM web app stores its auth token in `localStorage`:

- **Key:** `gl-kvm-token-keys` (JSON object keyed by device, e.g. `{"glkvm": "<token>"}`)
- **Fallback key:** `gl-kvm-token-key` (plain string)
- **Cookie:** `auth_token` is set via `js-cookie` with `sameSite: "none", secure: true`

### How the Web App Authenticates

- **HTTP API (axios):** Sends token as `token` header via request interceptor.
  ```js
  // Simplified from minified source
  const eo = new C({ timeout: 30000, baseURL: Le.baseURL },
    (config) => { const t = Le.getToken(); if (t) config.headers.token = t; },
    ...
  );
  ```
- **WebSocket (api/ws, janus/ws, api/media/ws):** Appends `?auth_token=<token>` as query parameter.
- **XHR (MSD upload):** Appends `?auth_token=<token>` to URL query string.

### Service Worker vs Page Context: Decision

**Finding:** When `credentials: 'omit'` is used (simulating a service-worker `fetch` without cookies), all API calls fail with "Failed to fetch" even with the token header present. This indicates the GLKVM server requires the `auth_token` cookie for session validation, not just the header.

**Decision: Page-context bridge required.**

The extension service worker cannot authenticate directly to GLKVM. The auth token must be extracted from the GLKVM page's `localStorage` via `chrome.scripting.executeScript` or CDP `Runtime.evaluate`, and the actual API calls must either:

1. Be executed in page context (via `Runtime.evaluate` / content script), or
2. Use the service worker with `credentials: 'include'` from the same origin (not possible cross-origin from extension)

**Recommended approach:** Execute GLKVM API calls via CDP `Runtime.evaluate` in the GLKVM tab's page context, similar to existing `javascript_tool`. This reuses the page's authenticated session (cookies + localStorage) without needing to extract or replicate credentials.

## 2. HID WebSocket (`/api/ws`)

### Connection

- **URL:** `wss://<host>/api/ws?auth_token=<token>`
- **Protocol:** No subprotocol required (pass `null`)
- **Binary type:** `arraybuffer`

### Initial Messages (server -> client)

On connect, the server sends a burst of JSON messages:

| event_type | Purpose |
|---|---|
| `loop` | Server version (`{"major": 4, "minor": 82}`) |
| `info` | Auth status, extras (janus, ipmi, vnc), meta |
| `gpio` | GPIO model and state |
| `ocr` | OCR availability (`enabled: false`, engine: tesseract) |
| `hid_keymaps` | Available keyboard layouts |
| `streamer` | Video encoder params, resolution, format |
| `hid` | HID device state (keyboard/mouse online, absolute mode, jiggler) |

### Heartbeat

- Client sends JSON: `{"event_type": "ping", "event": {}}`
- Server responds: `{"event_type": "pong", "event": {}}`

### HID Packet Formats (client -> server, binary)

All packets are sent as `Uint8Array`/`Int8Array` via `ws.send()`.

#### Keyboard Key

```
Byte 0: 0x01
Byte 1: state (1 = down, 0 = up)
Byte 2+: ASCII-encoded key name (e.g. "KeyA", "ShiftLeft", "Enter")
```

The key names follow the DOM `KeyboardEvent.code` convention (e.g., `KeyA`, `Digit1`, `ShiftLeft`, `ControlRight`, `Enter`, `Escape`, `F1`).

#### Mouse Button

```
Byte 0: 0x02
Byte 1: state (1 = down, 0 = up)
Byte 2+: ASCII-encoded button name ("left", "middle", "right", "up", "down")
```

Button mapping: `{0: "left", 1: "middle", 2: "right", 3: "up", 4: "down"}`

#### Mouse Move (absolute)

```
Byte 0: 0x03
Byte 1: x >> 8
Byte 2: x & 0xFF
Byte 3: y >> 8
Byte 4: y & 0xFF
```

Coordinates are mapped from viewport to range `[-32768, 32767]` using:
```js
value = Math.round((pos - offset) / size * (32767 - (-32768)) + (-32768))
```
Where `offset` and `size` come from the letterboxed video viewport calculation.

#### Mouse Relative Move

```
Byte 0: 0x04
Byte 1: squash flag (1 = batch, 0 = single)
Byte 2: delta_x (Int8)
Byte 3: delta_y (Int8)
// If squash=1, additional pairs follow: [dx, dy, dx, dy, ...]
```

#### Mouse Wheel

```
Byte 0: 0x05
Byte 1: squash flag
Byte 2: delta_x (Int8)
Byte 3: delta_y (Int8)
```

### Implementation Note

The `Ei()` function (exported as `ht` / `bC`) encodes and sends these packets. The `sendEvent()` method on the mouse handler class calls `ht(sockets.apiWS, event)`.

## 3. Text Paste (`/api/hid/print`)

### Endpoint

- **Method:** `POST`
- **URL:** `/api/hid/print?limit=0&keymap=<layout>`
- **Body:** Plain text string to type
- **Auth:** Token header (and/or cookie)

### Behavior

- Simulates USB HID keyboard events for each character
- `limit=0` means no character limit
- `keymap` parameter selects keyboard layout (default: `en-us`)
- Available layouts: `ar`, `bepo`, `cz`, `da`, `de`, `de-ch`, `en-gb`, `en-us`, `en-us-altgr-intl`, `es`, `et`, `fi`, `fo`, `fr`, `fr-be`, `fr-ca`, `fr-ch`, `hr`, `hu`, `is`, `it`, `ja`, `lt`, `lv`, `mk`, `nl`, `no`, `pl`, `pt`, `pt-br`, `ru`, `sl`, `sv`, `th`, `tr`
- Status 416 returned when text is too long

### Validation Result

- `POST` with empty body + token header returns `{"ok": true, "result": {}}` (200)
- `GET` returns 405 Method Not Allowed
- `OPTIONS` returns 405 Method Not Allowed (no CORS preflight support)

## 4. Snapshot / OCR (`/api/streamer/snapshot`)

### Endpoint

- **Method:** `GET`
- **URL:** `/api/streamer/snapshot` or `/api/streamer/snapshot?ocr_percent=<5|10|15|20>`
- **Response:** JPEG image (`image/jpeg`, ~640KB for 2560x1440)
- **Auth:** Works with cookie session; token header alone not sufficient from cross-origin

### Validation Result

- Returns valid JPEG (magic bytes `FF D8 FF E0`, JFIF header)
- `ocr_percent` parameter accepted (controls OCR selection region, client-side only)
- Response time: ~280-410ms

### OCR

The `/api/ws` initial burst includes:
```json
{"event_type": "ocr", "event": {"enabled": false, "engine": "tesseract", "langs": {"default": [], "available": []}}}
```

**OCR is disabled on this device.** The web app does client-side OCR using Tesseract.js when the user selects a screen region. There is no server-side OCR endpoint that returns text.

For the extension tools, OCR will need to be client-side (via the existing `glkvm_screenshot` tool returning JPEG + optional Tesseract.js processing in offscreen document) or deferred entirely.

## 5. Tab Targeting & Session Semantics

### Recommendation

| Scenario | Behavior |
|---|---|
| **Zero GLKVM tabs** | Return error: "No GLKVM tab found. Open and log in to your GLKVM device first." |
| **One GLKVM tab** | Auto-select. Store `tabId` for session. |
| **Multiple GLKVM tabs** | Require explicit `tabId` parameter. Use `tabs_context` to discover. |
| **Session isolation** | Each GLKVM tab controls a different remote machine. Never auto-merge. |

### Detection

A GLKVM tab can be detected by:
- URL matching: `*://*/#/` with page title "GLKVM" or presence of `gl-kvm-token-key` in localStorage
- Or by checking for `gl-kvm-token-keys` in the page's localStorage via `Runtime.evaluate`

### Existing Tools Interaction

The existing `computer` tool (CDP-based) operates on browser tabs. GLKVM tools operate on the *remote machine behind the KVM*. These are fundamentally different targets and must use separate tool names to avoid confusion.

## 6. Recommended Tool Names

Following existing `snake_case` convention and avoiding collision with existing `computer` tool:

| Tool | Purpose |
|---|---|
| `glkvm_status` | Check connection, auth, HID state, streamer info |
| `glkvm_screenshot` | Capture current KVM frame via `/api/streamer/snapshot` |
| `glkvm_input` | Send keyboard/mouse/scroll events via WebSocket HID |
| `glkvm_print` | Type text via `/api/hid/print` |
| `glkvm_wait` | Wait for OCR text or visual condition (uses screenshot + Tesseract.js) |

### Why Not Reuse Existing Tools

- `computer` = Chrome/browser CDP control of a web page
- `glkvm_*` = Remote machine HID control through KVM hardware
- Mixing these would confuse which machine receives input

## 7. Implementation Architecture

### Execution Model

All GLKVM API calls should be executed via CDP `Runtime.evaluate` in the GLKVM tab's page context. This:

1. Reuses the authenticated session (cookies + localStorage)
2. Avoids cross-origin issues
3. Avoids needing `chrome.cookies` permission
4. Matches the existing `javascript_tool` pattern

### File Locations

| File | Purpose |
|---|---|
| `shared/src/tools.ts` | Add `glkvm_status`, `glkvm_screenshot`, `glkvm_input`, `glkvm_print`, `glkvm_wait` constants |
| `mcp-server/src/server.ts` | Add MCP tool schemas |
| `extension/src/service-worker/tools/glkvmStatus.ts` | Status/discovery tool |
| `extension/src/service-worker/tools/glkvmScreenshot.ts` | Screenshot capture |
| `extension/src/service-worker/tools/glkvmInput.ts` | HID input (keyboard/mouse/scroll) |
| `extension/src/service-worker/tools/glkvmPrint.ts` | Text paste |
| `extension/src/service-worker/tools/glkvmWait.ts` | Visual wait/OCR |
| `extension/src/service-worker/tools/index.ts` | Register new handlers |

### Key Constraints

- No `chrome.cookies` permission in manifest (and adding it is unnecessary with page-context approach)
- MV3 service worker cannot hold WebSocket connections long-term (30s idle timeout)
- WebSocket for HID input should be opened/closed per-operation or kept alive via page context
- Snapshot is a simple HTTP GET returning JPEG, easy to proxy through page context

## 8. Risks & Open Questions

1. **WebSocket lifetime in page context:** If the GLKVM tab is backgrounded, Chrome may throttle the page. HID WebSocket may need to be re-established per input batch.
2. **Concurrent control:** Multiple MCP clients sending HID events to the same GLKVM tab could interleave. Consider a mutex or queue.
3. **Firmware variations:** This was validated against V1.9.0 (KVMD 4.82). Older firmware may have different API paths or packet formats.
4. **OCR accuracy:** Client-side Tesseract.js on KVM screenshots may have lower accuracy than purpose-built screen readers. Consider offering raw screenshots without OCR as the primary tool.
5. **Mouse coordinate mapping:** The absolute mouse coordinate mapping depends on the video viewport dimensions, which change with resolution and letterboxing. The page-context approach can reuse the existing `Mi()` function for correct mapping.
