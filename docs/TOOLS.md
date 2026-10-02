# Tool Reference

ChromeUse MCP exposes these tools through the MCP server. Most page-level tools require a `tabId` so agents do not accidentally operate on the wrong browser tab.

Start most workflows with `tabs_context`, then pass the returned `tabId` to follow-up tools.

Workspace/document tools operate on the folder selected in the ChromeUse side panel. They depend on Chromium File System Access permissions and should return actionable errors when no workspace is selected, permissions are lost, or the browser does not support the required API.

## Targeting Model

- `tabs_context` has no inputs and returns open tabs, URLs, titles, and tab group details.
- Most tools require `tabId`.
- `navigate` accepts an optional `tabId`; if omitted, it uses the active tab in the current window.
- `tabs_create` creates a new tab and accepts `active` to control whether it is foregrounded.
- `tabs_close` accepts either `tabId` or `tabIds`.
- `read_page` and `find` can return `ref_N` element references for ref-based actions.
- `computer` coordinates use screenshot pixel space when using coordinate actions.

## Tools

### `tabs_context`

Lists all open tabs and tab groups.

Inputs: none.

Use it to discover tab IDs before calling tab-scoped tools.

### `tabs_create`

Creates a new browser tab.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | URL to open. |
| `active` | boolean | no | Whether to make the new tab active. Defaults to `true`. |

### `tabs_close`

Closes one or more browser tabs.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | no | Single tab ID to close. |
| `tabIds` | number[] | no | Multiple tab IDs to close. Takes precedence over `tabId`. |

### `navigate`

Navigates a tab, goes back/forward, or reloads.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `goto`, `back`, `forward`, `reload` | yes | Navigation action. |
| `url` | string | for `goto` | Destination URL. |
| `tabId` | number | no | Target tab ID. Defaults to the active tab. |

### `computer`

Performs low-level browser interactions and captures screenshots.

Actions:

| Action | Description |
| --- | --- |
| `screenshot` | Capture a screenshot of the target tab. |
| `click` | Left-click by coordinates or `ref`. |
| `double_click` | Double-click by coordinates or `ref`. |
| `right_click` | Right-click by coordinates or `ref`. |
| `type` | Type text into the focused element. |
| `key` | Press a key or shortcut such as `Enter` or `ctrl+a`. |
| `scroll` | Scroll in a direction by a pixel amount. |
| `drag` | Drag from one coordinate to another. |
| `move` | Move the pointer. |

Common inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | yes | One of the supported actions. |
| `tabId` | number | yes | Target tab ID. |
| `x`, `y` | number | action-dependent | Coordinates in screenshot pixel space. |
| `ref` | string | action-dependent | Element reference from `read_page` or `find`. |
| `text` | string | for `type` | Text to type. |
| `key` | string | for `key` | Key name or shortcut. |
| `direction` | `up`, `down`, `left`, `right` | for `scroll` | Scroll direction. |
| `amount` | number | for `scroll` | Scroll distance in pixels. |
| `startX`, `startY`, `endX`, `endY` | number | for `drag` | Drag coordinates. |

### `read_page`

Reads page content.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `format` | `accessibility`, `html`, `text` | no | Output format. Defaults to `accessibility`. |

The accessibility format includes `ref_N` references for many page elements. Use these refs with `computer`, `find`, and `form_input` where supported.

### `find`

Searches for elements using a natural-language description.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `query` | string | yes | Description such as `email input` or `submit button`. |
| `maxResults` | number | no | Maximum matches to return. Defaults to 5. |

Returns element refs and bounding rectangles.

### `form_input`

Sets a form field value by ref.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `ref` | string | yes | Element reference such as `ref_42`. |
| `value` | string | yes | Value to set. |

Supports text inputs, textareas, selects, checkboxes, radio buttons, and contenteditable elements.

### `get_page_text`

Extracts visible page text without markup.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `maxLength` | number | no | Maximum characters to return. Defaults to 100000 and caps at 500000. |

### `javascript_tool`

Executes JavaScript in the page context through Chrome DevTools Protocol.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `code` | string | yes | JavaScript code to evaluate. |
| `awaitPromise` | boolean | no | Await Promise results. Defaults to `true`. |
| `timeout` | number | no | Evaluation timeout in milliseconds. Defaults to 30000. |

The result of the evaluated expression is returned when serializable.

### `file_upload`

Uploads files to a file input.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `selector` | string | yes | CSS selector for the file input. |
| `files` | string[] | yes | Absolute local file paths. |

### `read_console_messages`

Reads console messages captured through Chrome DevTools Protocol.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `clear` | boolean | no | Clear stored messages after returning them. Defaults to `false`. |
| `level` | `log`, `debug`, `info`, `warning`, `error` | no | Optional level filter. |
| `limit` | number | no | Maximum messages to return, newest first. Defaults to 100. |

### `read_network_requests`

Reads network requests captured through Chrome DevTools Protocol.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `clear` | boolean | no | Clear stored requests after returning them. Defaults to `false`. |
| `urlPattern` | string | no | Filter by URL substring. |
| `method` | string | no | Filter by HTTP method, case-insensitive. |
| `limit` | number | no | Maximum requests to return, newest first. Defaults to 100. |

### `resize_window`

Resizes the browser window containing the target tab.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `width` | number | yes | Window width in pixels. |
| `height` | number | yes | Window height in pixels. |

### `gif_creator`

Records browser actions as an animated GIF.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `start`, `screenshot`, `stop` | yes | Recording action. |
| `tabId` | number | yes | Target tab ID. |
| `delay` | number | no | Frame delay in centiseconds for `stop`. Defaults to 50. |

Use `start` before the workflow, `screenshot` whenever a frame should be captured, and `stop` to finish and return the GIF.



### `save_resource`

Downloads and saves resources from authenticated pages.

Fetches a resource URL using the page's authentication cookies. When `outputPath` is provided, it must be workspace-relative and the file is written through the selected workspace's File System Access permission. When omitted, the browser saves the file to Downloads. Supports all file types: images, PDFs, documents, archives, etc.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID for authentication context. |
| `url` | string | yes | URL of the resource to download. |
| `outputPath` | string | no | Workspace-relative path where to save the file. Can be a directory (ending with `/`) or full file path. If omitted, saves to the browser's Downloads folder. |
| `filename` | string | no | Filename to use. If omitted, extracts from URL or uses `download` as fallback. |

Returns: Success status, saved file path, file size, and content type.

Use cases:
- Download PDFs, images, documents, ZIPs from internal network pages
- Save embedded resources that require authentication into the selected workspace
- Archive page resources programmatically

Example:
```javascript
// Download a PDF from an authenticated internal page
save_resource({
  tabId: 123,
  url: "https://internal.company.com/docs/report.pdf",
  outputPath: "Documents/",
  filename: "quarterly-report.pdf"
})
```

## Direct Jev Decision Tools

These optional server-local tools are registered only when
`CHROMEUSE_JEV_API_KEY` is configured. They call OpenRouter's raw
`POST /api/v1/systemone` endpoint with `typesafe/jev-1.13`. They never call a
chat model or generative fallback.

ChromeUse compacts the main-frame accessibility tree, extracts only explicit
verbatim values, and constructs at most 255 deterministic atomic candidates.
Jev sees descriptions keyed by opaque IDs and may select one ID; it cannot
provide executable refs, text, URLs, keys, or directions. Visual-only tasks and
missing explicit values stop rather than guess.

### `ai_action`

Returns one validated candidate without executing it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `goal` | string | yes | Goal used to rank deterministic candidates. |
| `context` | string | no | Additional explicit structured context. |
| `pageContent` | string | no | Pre-fetched accessibility tree or page text. |

The result includes the action or `action: "stop"`, a structured reason,
selected probability, choice confidence, up to five alternatives, completion
and sufficiency probabilities, risk score, latency, resolved model, token usage,
and cost.

### `ai_assert`

Evaluates one condition with a Jev Noul probability.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `condition` | string | yes | Condition to evaluate against current page text. |
| `pageContent` | string | no | Pre-fetched visible page text. |

`pass` is reproducibly computed as `probability >= threshold`. The `reason` is
deterministic (for example, `probability 0.91 met threshold 0.80`), not generated
prose.

### `ai_navigate`

Runs a bounded decision loop and executes exactly one accepted atomic action per
step, then rereads the page before asking again.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tabId` | number | yes | Target tab ID. |
| `goal` | string | yes | Goal for the navigation loop. Quote text that must be typed. |
| `maxSteps` | number | no | Decision-step limit; defaults to 10 and caps at 25. |
| `startUrl` | string | no | Explicit URL visited before the first decision. |

Terminal stop reasons include `completed`, `low_confidence`,
`no_safe_candidates`, `explicit_value_required`, `unsupported_visual_task`,
`goal_not_verifiable`, `candidates_insufficient`, `decision_conflict`,
`risk_exceeded`, `step_limit`, `cancelled`, `provider_error`,
`invalid_provider_response`, and `browser_action_failed`.

## Workspace and Document Tools

The unified workspace/document foundation extends ChromeUse without bundling the Chrome Reader extension. Workspace state belongs to the ChromeUse side panel, and MCP tools communicate with that state through the existing extension transport.

### Workspace Tools

Workspace tools expose the selected local folder to trusted MCP clients after the user grants access in the side panel.

### `workspace_list_files`

Lists files and directories below the workspace folder selected in the ChromeUse side panel.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | no | Workspace-relative directory path. Defaults to the workspace root. |
| `depth` | number | no | Maximum recursive directory depth. Defaults to 1. |
| `limit` | number | no | Maximum entries to return before truncating the listing. |

Requires a selected workspace and current Chromium File System Access permission. Missing selection, revoked permission, unsupported browser APIs, inaccessible paths, and truncated listings should produce actionable messages.

### `workspace_read_file`

Reads a text-like file from the workspace folder selected in the ChromeUse side panel.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Workspace-relative file path to read. |
| `limit` | number | no | Maximum characters to return before truncating file content. |
| `encoding` | `utf-8` | no | Text encoding for the read operation. Defaults to `utf-8`. |

Requires a selected workspace and current Chromium File System Access permission. Missing selection, revoked permission, unsupported browser APIs, unreadable files, binary files, large files, and truncated reads should produce actionable messages.

Expected foundation capabilities:

| Capability | Description |
| --- | --- |
| Workspace status | Report whether a workspace is selected, whether permission is currently granted, and whether the browser supports File System Access. |
| Workspace tree/list | List directory entries lazily with depth and entry limits. |
| Workspace file read | Read text-like files from the selected workspace when permission is granted. |
| Actionable errors | Explain how to recover from missing selection, revoked permissions, unsupported APIs, large files, and binary files. |

These tools must not assume persistent filesystem access. Stored handles can help restore a workspace, but every operation still needs current browser permission.

### `markdown_render`

Renders markdown to safe HTML or a clearly defined render result.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `markdown` | string | no | Markdown source text to render directly. |
| `filePath` | string | no | Browser-accessible file URL or workspace file path containing markdown, when file access is available. |
| `url` | string | no | Browser-accessible URL containing markdown. |
| `allowRawHtml` | boolean | no | Raw HTML rendering request. Unsupported by default for safety unless a sanitizer is available. |

Behavior:

- Exactly one source should be supplied: direct `markdown` text, `filePath`, or `url`.
- Raw HTML is disabled by default; unsafe HTML is escaped rather than emitted as raw markup.
- `.md`, `.mdx`, and `.markdown` files are the primary workspace file targets.
- Missing workspace selection, permission loss, unsupported browser APIs, unreadable files, large files, and binary files should produce actionable error messages.
- PDF, PowerPoint, Excel, and Word rendering is not implemented by this tool in the foundation phase.

### Document Routing Placeholders

The side panel document router sends markdown files to preview/source rendering and sends PDF, PowerPoint, Excel, Word, unknown, binary, and oversized files to placeholder shells. Those placeholders are intentional: full document review/edit support is future work, likely involving a local companion for conversion and indexing outside the browser sandbox.

## Example Workflows

### Open a Page and Read It

1. Call `tabs_create` with `url: "https://example.com"`.
2. Call `tabs_context` and find the created tab ID.
3. Call `read_page` with `format: "accessibility"`.

### Find and Click a Button

1. Call `find` with `query: "submit button"`.
2. Use the returned `ref` with `computer` action `click`.

### Fill and Submit a Login Form

1. Call `find` for `email input` and `password input`.
2. Call `form_input` for each returned field ref.
3. Call `find` for `sign in button`.
4. Call `computer` action `click` on the returned button ref.

## Synchronization, debugging, and automation tools

These tools build on the Chrome DevTools Protocol and Chrome extension APIs.
Most are `tabId`-scoped; `cookies`, `history_search`, `bookmarks`, and
`tab_session` are browser-scoped.

### `wait_for`

Block until a page condition holds, instead of guessing a delay. `for` is one
of `selector` (visible), `selector_hidden`, `text` (present in body),
`network_idle`, or `console` (a message matches `pattern`). Supports
`timeoutMs` (default 10000), `idleMs` (network idle window, default 500), and
`pollMs`. Returns `satisfied` and `waitedMs`, or a timeout error.

### `network_intercept`

Mock or block requests via the Fetch domain. `action`: `mock` (return
`status`/`body`/`contentType`/`headers`), `block` (fail the request), `list`,
or `clear`. Matches by `urlPattern` (substring, or glob when it contains `*`)
plus optional `method`. Non-matching paused requests are continued untouched.

### `cookies`

`action`: `get` (by `url` or `domain`), `set` (`url`+`name`+`value`, optional
`path`/`secure`/`httpOnly`/`expirationDate`/`sameSite`), `delete` (`url`+`name`),
`clear` (by `url` or `domain`). Requires the `cookies` permission.

### `storage`

Read/write a tab's `localStorage` or `sessionStorage`. `action`: `get` (one
`key`, or all when omitted), `set` (`key`+`value`), `remove` (`key`), `clear`.
Choose `area` of `local` (default) or `session`.

### `emulate`

`action`: `device` (`preset` such as `iphone-12`/`pixel-5`/`ipad`/`desktop`, or
explicit `width`/`height`/`deviceScaleFactor`/`mobile`/`touch`), `user_agent`,
`geolocation` (`latitude`/`longitude`/`accuracy`), `color_scheme`
(`light`/`dark`/`no-preference`), `network` (`profile` of
`online`/`offline`/`slow-3g`/`fast-3g`), `cpu` (`rate` slowdown), or `reset`.

### `performance_metrics`

Returns navigation timings (TTFB, DOMContentLoaded, load), Core Web Vitals
(FCP, LCP, CLS), a resource transfer summary, and runtime metrics (JS heap,
DOM nodes) for a `tabId`.

### `screenshot_element`

Screenshot a single element by `selector` (scrolled into view and clipped to
its bounds), with optional `padding`. Returns a PNG image.

### `print_to_pdf`

Render the page to PDF. With a workspace-relative `outputPath` it is written to
the selected workspace; otherwise it downloads (`filename`, default `page.pdf`).
Options: `landscape`, `printBackground`.

### `extract_structured`

Extract a `<table>` (headers + rows) or a repeated element set (`selector`) into
structured JSON. `as` is `auto` (default), `table`, or `list`. With a
workspace-relative `outputPath`, the JSON is also saved.

### `tab_session`

`action`: `save` (snapshot a window's tabs and groups under a `name`),
`restore` (open them in a new window, recreating groups), `list`, `delete`.
Sessions persist in `chrome.storage.local`.

### `history_search`

Search browsing history by `query`, `maxResults` (default 50), and `days`
(time window). Requires the `history` permission.

### `bookmarks`

`action`: `search` (`query`), `list` (children of folder `id`, root when
omitted), `create` (`title`+optional `url`, optional `parentId`). Requires the
`bookmarks` permission.

## Code-quality, debugging, and macro tools

### `coverage`

Measure unused JavaScript and CSS. Call with `action: "start"`, exercise the
page, then `action: "stop"` to get per-URL used vs total functions (JS,
function-level) and rules (CSS), with overall percentages.

### `accessibility_audit`

Run an axe-core WCAG audit on a `tabId`. Returns violations (id, impact, help,
affected node count, sample targets). Optional `tags` (e.g. `["wcag2a","wcag2aa"]`)
and `selector` to scope.

### `debug_inspect`

Set a one-shot breakpoint at `urlRegex` + `lineNumber` (0-based), optionally only
when `condition` is truthy. When hit (within `timeoutMs`), returns the top call
frame, its local variables, and an optional `expression` evaluated in that frame,
then always resumes. The page is never left frozen.

### `clipboard`

`action: "write"` copies `text`; `action: "read"` returns clipboard text. Read can
fail when the browser blocks unfocused reads — the tool reports that clearly.

### `macro`

Record and replay UI interactions. `record_start` (`tabId`) injects a recorder
that captures clicks, input changes, and navigations; `record_stop` (`tabId`,
`name`) saves them. `replay` (`name`, `tabId`) re-runs the steps with waits;
`schedule` (`name`, `periodMinutes`) replays on a recurring alarm in a background
tab; `list`/`get`/`delete`/`unschedule` manage macros. Recording state is
in-memory — complete a recording in one session.

## Safety Guidance

- Confirm the target `tabId` before destructive actions.
- Use `read_page` or screenshots before clicking unfamiliar UI.
- Avoid running arbitrary JavaScript from untrusted sources.
- Be careful with authenticated pages, payment flows, admin dashboards, and production systems.
- Only use `file_upload` with files you explicitly intend to expose to the page.
- Only select workspace folders you are comfortable exposing to trusted MCP clients.
