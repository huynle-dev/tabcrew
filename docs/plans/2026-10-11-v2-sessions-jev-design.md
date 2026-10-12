# ChromeUse v2: Isolated Agent Sessions and the Jev Loop

Date: 2026-10-11
Status: Approved design, not yet implemented
Supersedes: the `ai_*` tools from `2026-10-01-direct-jev-browser-decisions.md`; the gateway SERVER/PROXY election

## Goal

Many agents, including subagents inside one harness, share one ChromeUse service. Each agent fully controls its own tabs and cannot see or touch anyone else's. Agents can hand a whole goal to TypeSafe's Jev model through OpenRouter, using the loop proven in `~/projects/jev-ultrafast`. That loop runs Zürich → London on Google Flights in 7.7–11.8 s, checked independently.

## Why v1 falls short

Multi-agent use:

- `session_scope` is never set, so every tab lands in one `default` group.
- `tabs_context` lists every tab, and any client can act on any `tabId`.
- Identity is one id per harness process, so subagents can't be told apart.
- Two global serial queues (`gateway/src/requestQueue.ts`, `extension/.../messageRouter.ts`) let one slow call block every agent and let multi-step calls interleave.
- `tabs_create` activates and focuses tabs. Nothing prevents background-tab throttling.
- `ComputerTool.lastScreenshotDims` is shared across all tabs.
- The gateway has no re-election: if the SERVER process exits, every proxy fails.

Jev integration (`ai_action`, `ai_assert`, `ai_navigate`):

- Jev picks from one flat list of precomputed candidates, instead of an operation plus per-operation targets.
- It can only type values quoted in the goal. Clicks are limited to links and buttons.
- Untuned 0.80 confidence gates and a regex that blocks visual goals stop many tasks before Jev is called.
- Revalidation by role+name fails on duplicate controls. Fixed 400–1200 ms sleeps slow every step.
- It has only been tested with mocks, never on live sites.

## Decisions

| Topic | Decision |
| --- | --- |
| Isolation boundary | One session per agent, subagents included. A random session handle is a capability passed on every call. |
| Connection model | One long-running daemon started by launchd, with a single MCP endpoint over HTTP. No per-harness processes, no election. |
| Tool surface | About 12 tools: the Jev core plus essentials. The other v1 tools are not carried over. |
| Migration | v2 is built alongside v1 in new packages; v1 is deleted after v2 is proven. |
| Policy location | The daemon owns all policy, keys and model calls. The extension only reads and acts. |
| Decision model | `typesafe/jev-1.13` via `POST https://openrouter.ai/api/alpha/decisions` |

## 1. Components

```text
chromeuse-mcp/
  shared/          (existing) wire types: extended with v2 messages
  daemon/          NEW  Node service, started at login by launchd
    mcp/           MCP over HTTP at http://127.0.0.1:8770/mcp
    sessions/      session registry, tab ownership, idle timeouts
    scheduler/     one queue per tab (no global queue)
    jev/           Decisions client, text helper, browse loop
    bridge/        WebSocket server for the extension on 127.0.0.1:8771
  extension-v2/    NEW  Chrome MV3 extension, separate ID, installed alongside v1
    bridge/        connects out to the daemon, reconnects automatically
    tabs/          one tab group per session, tabs created in the background
    cdp/           chrome.debugger attached to each tab, focus emulation, input
    snapshot/      atomic page snapshot + numbered elements (port of jev-ultrafast snapshot.js)
    ui/            Stop button: per session or all sessions
```

The extension holds no keys, makes no model calls and applies no policy. Every daemon request names a session and a tab. The extension independently rejects tabs outside that session's group.

v2 uses ports 8770 (MCP) and 8771 (extension). v1 keeps 8766/8765, and the jev-ultrafast inspector uses 8767. v2 has its own extension ID, so both extensions can be installed at once. Harnesses switch by changing one MCP config entry.

**Reused from v1:** the WebSocket connection with backoff and the alarm, the indicator-overlay fix, the CDP helpers, and the build and release scripts.

**Dropped:** the SERVER/PROXY election, the global queues, `ai_*` and `actionCandidates`, and the accessibility tree with `ref_N` IDs.

## 2. Sessions, isolation and concurrency

**Sessions**

- `session_open({label})` returns an unguessable handle (`s_` plus 128 random bits). Every other tool requires it.
- The registry is saved to `~/.chromeuse/sessions.json`. After a daemon restart, the extension reports its tab groups and the daemon matches them back to their sessions.
- `session_close` closes the session's tabs. An idle session (default 30 min without calls) is closed the same way.
- Each tab group is titled `<label> · <short id>`.

**Ownership**

- `tab_create` opens tabs only inside the session's group, in a dedicated unfocused "Agents" window. It never activates a tab or focuses a window, and the user's own windows are never touched.
- Tabs opened by an owned tab (`openerTabId`: pop-ups, `target=_blank`) join the opener's session.
- A tab the user closes yields `tab_gone` for that session only.
- The daemon and the extension each check ownership. Listings only ever show the caller's own tabs.

**Concurrency**

- Each tab has its own FIFO queue, and different tabs run in parallel. Tab creation and closing are serialised per session.
- Each tab gets its own `chrome.debugger` attachment and `Emulation.setFocusEmulationEnabled`, so background tabs keep rendering and running timers.
- Screenshot dimensions, numbered elements and fingerprints are stored per tab.
- A daemon-wide limit (default 8) caps concurrent `browse` loops. Excess calls wait in order.

**Stop:** the popup lists active sessions, each with Stop, plus a Stop all button. A stopped session's next call returns `stopped_by_user`. Its tabs stay open for inspection.

## 3. Tools and the Jev loop

Every tool takes `session`.

| Group | Tools |
| --- | --- |
| Sessions | `session_open`, `session_close` |
| Tabs | `tab_create(url)`, `tab_list`, `tab_close`, `navigate(url \| back \| forward \| reload)` |
| Jev | `browse(tab, goal, max_steps=25)` |
| Step-by-step | `observe(tab)`, `act(tab, fingerprint, operation, target, text?)` |
| Look and debug | `screenshot(tab)`, `read_text(tab)`, `debug_logs(tab, console \| network)` |

**`observe`** returns the URL, the title, the visible text, a numbered element table (`[3] combobox Where to? · empty`) and a fingerprint.

**`act`** requires the fingerprint from the agent's last `observe`, and returns `stale_page` without acting if the page changed. Operations are `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN` and `WAIT`. Targets are numbers from the table. Selectors, coordinates and code are never accepted.

**The `browse` loop**

1. **Observe:** one extension call takes an atomic snapshot and keeps references to the live page elements.
2. **Decide:** one Decisions request contains an `operation` choice plus speculative per-operation target choices (`click_target`, `type_text_target`, `select_target`). Only the target for the chosen operation is used.
3. **Text:** for `TYPE_TEXT`, the text helper (default `inception/mercury-2.5` on OpenRouter) writes the value. Its reply must parse as `{"text": str}`; Markdown fences are tolerated. On a stale retry, the value is reused only if the helper's whole input is unchanged.
4. **Act:** the extension rechecks freshness and occlusion, then acts. Each step is logged before its result is observed. Browser actions are never retried; a stale page means observe and decide again.
5. **Wait:** combobox typing waits up to 200 ms for suggestions. Everything else waits at most two animation frames or 50 ms.

The loop stops on `DONE`, `BLOCKED`, three non-WAIT actions in a row that don't change the page, `max_steps`, or Stop.

**`browse` returns** the status, the trace (operation, element label, probability, typed text), the final URL and title, a short element table, and usage and cost. `DONE` is reported as Jev's claim. Callers verify the outcome with `observe`, `read_text` or `screenshot`.

**Not carried over:** confidence gates, the visual-goal regex and precomputed candidates. Probabilities are recorded so thresholds can be tuned later from real traces.

## 4. Errors, security and configuration

**Errors:** each is a typed code with a one-line hint and no stack trace.

| Code | Meaning | Caller action |
| --- | --- | --- |
| `bad_session`, `tab_not_owned`, `tab_gone` | ownership problem | open the session or create the tab again |
| `stale_page` | page changed since `observe`; nothing executed | observe again |
| `target_covered`, `target_invalid` | element hidden, disabled, covered, or not in the table | observe and choose again |
| `stopped_by_user` | the user pressed Stop | ask the user |
| `extension_offline` | no extension connection within 10 s | retry later |
| `model_error` | OpenRouter/Jev failed or returned invalid output | `browse` returns its partial trace |
| `outcome_unknown` | an action was sent but its result is unknown | observe before doing anything else |

**Retries**

- Model calls retry at most twice on 429, 503 or 529, with backoff.
- Browser actions are never retried.
- Invalid Jev answers (unknown id, probabilities not summing to 1, chosen option not the highest) stop that step without any guessing.

**Recovery**

- The extension reconnects automatically.
- launchd restarts the daemon after a crash, and the saved registry plus tab-group matching restore ownership.
- The service worker stays alive while a debugger is attached; otherwise the 1-minute alarm revives it.

**Security**

- The MCP endpoint binds to `127.0.0.1` only. It rejects requests whose `Origin` is not allowed, so web pages can't call it, and it requires `Authorization: Bearer <token>`. The token is kept in `~/.chromeuse/token`, readable only by its owner.
- The extension socket accepts only the v2 extension, which presents the same token.
- `OPENROUTER_API_KEY` comes from the environment and is never written to config files. The current plaintext key in `~/.config/opencode/opencode.jsonc` moves to `{env:OPENROUTER_API_KEY}`.
- Page text and typed values are not logged at the default level. Traces are written to `~/.chromeuse/traces/` only when tracing is turned on.

**Configuration:** `~/.chromeuse/config.toml`, overridden by environment variables. It covers the ports, `JEV_MODEL` (default `typesafe/jev-1.13`), the text model, the idle timeout, the browse limit and the Agents window behaviour.

## 5. Testing and rollout

No automated test calls a paid API.

- **Unit tests:** session registry, ownership, per-tab queues (different tabs run in parallel, the same tab in order), building the Decisions request, answer validation, and text-helper parsing.
- **Browser guard tests:** freshness and occlusion checks on fixture pages in real Chrome, ported from jev-ultrafast `scripts/check_guards.py`. They cover moved, covered, disabled, replaced and stale elements, dropdown options, and combobox suggestions. No model calls.
- **Isolation test:** three sessions drive their own tabs in parallel in real Chrome. Calls on another session's tab return `tab_not_owned`. `tab_list` shows only the caller's tabs. A slow `WAIT` in one session does not delay the others.
- **Live checks:** run only on demand (`just live`), and paid. They cover Wikipedia, a local hotel-search fixture, and Google Flights with a date generated in the future. Each result is checked independently, and timings, costs and pass rates are recorded in `docs/performance.md`.

| Phase | Delivers | Done when |
| --- | --- | --- |
| 1 | Daemon skeleton: HTTP MCP, token, launchd, config | `session_open` works from OpenCode |
| 2 | Extension v2: bridge, tab groups, Agents window, CDP, focus emulation | `tab_create`/`tab_list`/`tab_close` and `screenshot` work |
| 3 | Sessions, ownership, per-tab queues | isolation test passes |
| 4 | `snapshot`, `observe`, `act` with freshness and occlusion checks | browser guard tests pass |
| 5 | Jev `browse` loop and text helper | Wikipedia and Flights live checks pass |
| 6 | `navigate`, `read_text`, `debug_logs`, Stop UI | all tools in place |
| 7 | Switch harness configs to v2 and use it in real work | user sign-off |
| 8 | Delete v1 (`gateway/`, `mcp-server/`, `native-host/`, `extension/`) | separate decision |

Phases 1 and 2, and the snapshot part of phase 4, are independent and can be built in parallel.

## Status (2026-10-12)

Phases 1–6 and 8 are built: the daemon (`daemon/`), extension (`extension-v2/`) and 12 tools, with the offline unit tests and the live smoke, isolation, guards, concurrency and paid live-browse scripts. v1 (`gateway/`, `mcp-server/`, `native-host/`, `extension/`) was deleted; it is recoverable from tag `v1-final`.

Decisions made during the build:

- Each session gets its own window (instead of one shared Agents window), so sessions never compete for the active tab.
- The daemon WebSocket lives in an offscreen document, not the service worker; this cut the 3-agent isolation run from 20.6 s to 1.95 s.
- `session_close` (and connection loss or idle timeout) hands remaining tabs to the user's window as a collapsed `✓ <label>` group instead of closing them; the agent loses control.
- Optional "My current window" placement in the popup; the default stays a window per session.
- Tabs are ungrouped before they are closed.
- Tool descriptions and server instructions tell agents to close throwaway tabs and call `session_close` when done.
- The text helper falls back once to a second model (`TEXT_MODEL_FALLBACK`) when the first is slow or fails (`TEXT_MODEL_TIMEOUT_MS`).
