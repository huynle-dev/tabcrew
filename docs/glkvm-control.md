# GLKVM Control Tools

The GLKVM tools expose remote KVM control through the Chrome tab that is already logged in to a GLKVM/KVMD web interface. They are separate from the browser `computer` tool: `computer` controls Chrome, while `glkvm_*` tools control the remote machine connected to the KVM hardware.

## Registered Tool Names

| MCP tool | OpenCode display example | Purpose |
|---|---|---|
| `glkvm_open` | `opencode-chrome_glkvm_open` | Open a GLKVM URL in an OpenCode-owned tab and return its `tabId`. |
| `glkvm_attach` | `opencode-chrome_glkvm_attach` | Mark an existing logged-in GLKVM tab as OpenCode-owned and return its `tabId`. |
| `glkvm_status` | `opencode-chrome_glkvm_status` | Validate an OpenCode-owned GLKVM `tabId`, report video stream state, and inspect an optional HID session. |
| `glkvm_screenshot` | `opencode-chrome_glkvm_screenshot` | Capture the current GLKVM video frame, optionally crop/downscale it, and return hash/dimension metadata. |
| `glkvm_input` | `opencode-chrome_glkvm_input` | Send keyboard, text, mouse, drag, and scroll input to the remote machine. |
| `glkvm_wait` | `opencode-chrome_glkvm_wait` | Poll captured frames until the remote display changes or a timeout expires. |
| `glkvm_sequence` | `opencode-chrome_glkvm_sequence` | Run batched input, capture, and frame-wait steps over one OpenCode-owned GLKVM tab. |
| `glkvm_nav` | `opencode-chrome_glkvm_nav` | Run OS-aware navigation macros through GLKVM HID. |
| `glkvm_ocr` | `opencode-chrome_glkvm_ocr` | Read optional OCR text from a remote-frame region when the device exposes OCR support. |

OpenCode prefixes tool names with the configured MCP server name. The registered names in the MCP server are the unprefixed `glkvm_*` names.

## Required Browser Session State

The extension does not ask for GLKVM credentials and does not store a separate GLKVM password. It reuses the authenticated Chrome tab:

- Open the GLKVM web interface in Chrome.
- Log in until the video console is visible.
- Keep the tab open while using `glkvm_*` tools.
- Re-authenticate in the web UI if a tool reports a missing token, rejected WebSocket, or HTTP 401/403 response.

Implementation detail: GLKVM requires the browser session cookie plus token state from the page. The extension runs GLKVM API calls in the GLKVM tab's page context with CDP `Runtime.evaluate`, so the request has the same cookies and `localStorage` token as the logged-in page.

## OpenCode-Owned Tab Selection

Direct GLKVM control requires an explicit browser `tabId` that is both a GLKVM tab and owned by the current OpenCode session. This prevents a caller from silently controlling an arbitrary matching GLKVM tab outside the OpenCode tab group.

Selection rules:

- Use `glkvm_open` with a URL to open a GLKVM web UI in an OpenCode-owned tab.
- Use `glkvm_attach` with an existing Chrome tab ID to mark a logged-in GLKVM tab as OpenCode-owned.
- Pass the returned integer `tabId` to `glkvm_status`, `glkvm_screenshot`, `glkvm_input`, `glkvm_wait`, `glkvm_sequence`, `glkvm_nav`, and `glkvm_ocr`.
- URL or hostname `target` values are only for discovery/open/attach flows. Direct-control schemas do not expose `target`, and target-only direct control is rejected.
- When targeting fails, errors include both available GLKVM tabs and OpenCode-owned GLKVM tabs so callers can choose safely.

Recommended pattern:

```json
{ "url": "https://kvm.example.com/#/" }
```

Then use the returned `tabId`:

```json
{ "tabId": 42 }
```

Use `tabs_context` if you need to inspect currently open browser tabs before attaching one with `glkvm_attach`.

## Coordinate Systems

GLKVM control uses three coordinate spaces. Use the right one for each tool.

| Coordinate space | Where it appears | Meaning |
|---|---|---|
| Browser page pixels | Browser `computer` tool only | Chrome window/screenshot coordinates. Do not use these for GLKVM HID input. |
| Intrinsic remote-frame pixels | `glkvm_screenshot.region`, `glkvm_ocr.region`, frame `source` metadata | Native KVM video pixels from the GLKVM `<video>` element (`videoWidth` / `videoHeight`). |
| GLKVM screenshot space | `glkvm_input` mouse arguments | Pixels in the captured GLKVM video-frame image returned by `glkvm_screenshot`. |
| Remote HID absolute space | Diagnostic `absolute` response fields | KVMD absolute mouse range generated internally for HID packets. Do not pass these values as input. |

Mouse input workflow:

1. Capture a fresh GLKVM frame with `glkvm_screenshot`.
2. Measure `x` and `y` within that returned frame image.
3. Pass those screenshot-space coordinates to `glkvm_input`.
4. For drag, pass `startX`, `startY`, `endX`, and `endY` in the same screenshot-space frame.

Example click:

```json
{
  "tabId": 42,
  "action": "click",
  "x": 640,
  "y": 360,
  "button": "left"
}
```

Example drag:

```json
{
  "tabId": 42,
  "action": "drag",
  "startX": 400,
  "startY": 300,
  "endX": 800,
  "endY": 300,
  "button": "left"
}
```

`glkvm_screenshot.region` and `glkvm_ocr.region` are expressed in intrinsic remote-frame pixels (`x`, `y`, `width`, `height`) and must fit inside the remote video dimensions.

## Screenshot Crop, Downscale, And Hash Metadata

`glkvm_screenshot` accepts optional frame-shaping arguments for faster perception loops:

```json
{
  "tabId": 42,
  "region": { "x": 0, "y": 0, "width": 1280, "height": 720 },
  "maxWidth": 640,
  "maxHeight": 360
}
```

- `region` crops the GLKVM frame in intrinsic remote-frame pixels before any downscaling.
- `maxWidth` and `maxHeight` downscale the returned JPEG while preserving aspect ratio; they never upscale the capture.
- The image block contains the final JPEG. The metadata block reports `source` intrinsic dimensions, applied `region` / `crop`, final `output` dimensions in `glkvm_screenshot_pixels`, `hash`, and `hashAlgorithm`.
- The frame hash is computed from the final returned JPEG data and is suitable for visual change/stability detection.

## Input Actions

`glkvm_input` supports these actions:

| Action | Required arguments | Notes |
|---|---|---|
| `key` | `key` | Sends key press/release packets. `keyAction` defaults to `press` and also supports `down`, `up`, `hotkey`, and `chord`. |
| `type` | `text` | Uses GLKVM paste-as-keys when available, then can fall back to individual key events for simple characters unless `fallback` is `none`. |
| `click` | `x`, `y` | Moves to a screenshot-space point and clicks `button`, default `left`. |
| `move` | `x`, `y` | Moves the remote pointer to a screenshot-space point. |
| `drag` | `startX`, `startY`, `endX`, `endY` | Moves, presses, moves, and releases `button`, default `left`. |
| `scroll` | `direction` | Sends mouse wheel input. `direction` is `up` or `down`; `amount` defaults to `1`. |

Example hotkey:

```json
{
  "tabId": 42,
  "action": "key",
  "key": "ctrl+alt+delete",
  "keyAction": "hotkey"
}
```

Example text input:

```json
{
  "tabId": 42,
  "action": "type",
  "text": "boot rescue\n"
}
```

## Waiting And OCR

`glkvm_wait` captures an initial frame and then polls until the frame hash changes or the timeout expires. It is useful after input actions that cause remote UI changes.

```json
{
  "tabId": 42,
  "timeout": 5000,
  "pollInterval": 250
}
```

`glkvm_ocr` is optional and depends on device-reported OCR support. It can fail with explicit unavailable errors when OCR is disabled, the requested language is unavailable, or the device accepts the snapshot request but does not expose text output.

```json
{
  "tabId": 42,
  "language": "eng",
  "region": { "x": 0, "y": 0, "width": 800, "height": 200 }
}
```

## Safety Model

The GLKVM tools are designed to fail closed because HID input affects a real remote machine.

Tab targeting guardrails:

- GLKVM tabs are detected by GLKVM URL/title signals.
- Direct control requires an explicit integer `tabId` from `glkvm_open`, `glkvm_attach`, or OpenCode-owned discovery.
- The tab must still be a GLKVM page and must belong to the current OpenCode-owned tab group.
- Targeting failures return available GLKVM tabs and OpenCode-owned GLKVM tabs instead of selecting an arbitrary tab.

Authentication and offline guardrails:

- Missing `localStorage` tokens return `AUTH_FAILED` style errors asking you to log in.
- WebSocket auth rejection asks you to re-authenticate in the GLKVM web interface.
- Offline, DNS, connection timeout, and closed-WebSocket conditions are reported as structured connection or protocol errors.

Input cleanup guardrails:

- Key and mouse input tracks pressed keys and buttons in the page-context HID session.
- Each input operation attempts release-all cleanup after sending packets.
- Cleanup results include released key/button counts when relevant.
- If cleanup fails after input, the tool reports a cleanup failure instead of hiding the risk.
- `tabs_close` releases and closes tracked HID sessions before closing browser tabs.

Video and coordinate guardrails:

- Mouse input requires current GLKVM video metadata.
- Hidden, zero-size, or unavailable video streams fail with a message to capture a fresh `glkvm_screenshot` before mouse input.
- Screenshot-space mouse input is mapped to remote HID absolute coordinates internally; callers should not supply browser coordinates or HID absolute values.

Session cleanup behavior:

- HID WebSocket sessions live in the GLKVM page context and can be reused with `sessionId`.
- Closing a tracked tab removes service-worker session tracking.
- Explicit tab close through `tabs_close` performs release-all and close cleanup before removing the tab.
