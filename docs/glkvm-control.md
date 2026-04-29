# GLKVM Control Tools

The GLKVM tools expose remote KVM control through the Chrome tab that is already logged in to a GLKVM/KVMD web interface. They are separate from the browser `computer` tool: `computer` controls Chrome, while `glkvm_*` tools control the remote machine connected to the KVM hardware.

## Registered Tool Names

| MCP tool | OpenCode display example | Purpose |
|---|---|---|
| `glkvm_status` | `opencode-chrome_glkvm_status` | Resolve the GLKVM tab, report video stream state, and inspect an optional HID session. |
| `glkvm_screenshot` | `opencode-chrome_glkvm_screenshot` | Capture the current GLKVM video frame and optionally request OCR metadata. |
| `glkvm_input` | `opencode-chrome_glkvm_input` | Send keyboard, text, mouse, drag, and scroll input to the remote machine. |
| `glkvm_wait` | `opencode-chrome_glkvm_wait` | Poll captured frames until the remote display changes or a timeout expires. |
| `glkvm_ocr` | `opencode-chrome_glkvm_ocr` | Read optional OCR text from a remote-frame region when the device exposes OCR support. |

OpenCode prefixes tool names with the configured MCP server name. The registered names in the MCP server are the unprefixed `glkvm_*` names.

## Required Browser Session State

The extension does not ask for GLKVM credentials and does not store a separate GLKVM password. It reuses the authenticated Chrome tab:

- Open the GLKVM web interface in Chrome.
- Log in until the video console is visible.
- Keep the tab open while using `glkvm_*` tools.
- Re-authenticate in the web UI if a tool reports a missing token, rejected WebSocket, or HTTP 401/403 response.

Implementation detail: GLKVM requires the browser session cookie plus token state from the page. The extension runs GLKVM API calls in the GLKVM tab's page context with CDP `Runtime.evaluate`, so the request has the same cookies and `localStorage` token as the logged-in page.

## Target Selection

The tools accept `target` as an optional GLKVM target identifier or URL. They do not expose browser `tabId` as a public input.

Target resolution rules:

- When one GLKVM tab is open, omitting `target` auto-selects that tab.
- When multiple GLKVM tabs are open, pass `target` to avoid controlling the wrong remote machine.
- `target` may be a full URL, hostname, or partial hostname that matches a GLKVM tab URL.
- When no matching GLKVM tab exists, tools fail with a clear error instead of falling back to another tab.

Recommended pattern:

```json
{ "target": "kvm.example.com" }
```

Use `tabs_context` if you need to inspect currently open browser tabs before choosing a target.

## Coordinate Systems

GLKVM control uses three coordinate spaces. Use the right one for each tool.

| Coordinate space | Where it appears | Meaning |
|---|---|---|
| Browser page pixels | Browser `computer` tool only | Chrome window/screenshot coordinates. Do not use these for GLKVM HID input. |
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
  "target": "kvm.example.com",
  "action": "click",
  "x": 640,
  "y": 360,
  "button": "left"
}
```

Example drag:

```json
{
  "target": "kvm.example.com",
  "action": "drag",
  "startX": 400,
  "startY": 300,
  "endX": 800,
  "endY": 300,
  "button": "left"
}
```

`glkvm_ocr.region` is different: it is expressed in intrinsic remote-frame pixels (`x`, `y`, `width`, `height`) and must fit inside the remote video dimensions.

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
  "target": "kvm.example.com",
  "action": "key",
  "key": "ctrl+alt+delete",
  "keyAction": "hotkey"
}
```

Example text input:

```json
{
  "target": "kvm.example.com",
  "action": "type",
  "text": "boot rescue\n"
}
```

## Waiting And OCR

`glkvm_wait` captures an initial frame and then polls until the frame hash changes or the timeout expires. It is useful after input actions that cause remote UI changes.

```json
{
  "target": "kvm.example.com",
  "timeout": 5000,
  "pollInterval": 250
}
```

`glkvm_ocr` is optional and depends on device-reported OCR support. It can fail with explicit unavailable errors when OCR is disabled, the requested language is unavailable, or the device accepts the snapshot request but does not expose text output.

```json
{
  "target": "kvm.example.com",
  "language": "eng",
  "region": { "x": 0, "y": 0, "width": 800, "height": 200 }
}
```

## Safety Model

The GLKVM tools are designed to fail closed because HID input affects a real remote machine.

Tab targeting guardrails:

- GLKVM tabs are detected by GLKVM URL/title signals.
- A single tab can be auto-selected, but multiple tabs require an explicit `target`.
- A target mismatch returns the available GLKVM tabs instead of selecting an arbitrary tab.

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
