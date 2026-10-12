/**
 * ChromeUse v2 service worker: wires the daemon bridge relay, session tab groups, and CDP.
 * The daemon WebSocket itself lives in the offscreen document (see offscreen/), so a blocked
 * socket cannot stall request handling here.
 * All Chrome listeners are registered synchronously at top level (MV3 requirement).
 */

import { CdpManager } from "./cdp.js";
import {
  PORT_KEY,
  TOKEN_KEY,
  loadConfig,
  type PopupActionResult,
  type PopupCloseResult,
  type PopupRequest,
  type PopupState,
  type PopupStopResult,
} from "./config.js";
import { ensureOffscreenDocument } from "./offscreen-client.js";
import { handleRequest } from "./ops.js";
import { BRIDGE_PORT_NAME } from "./relay-protocol.js";
import { BridgeRelay } from "./relay.js";
import { PageController } from "./snapshot/controller.js";
import { StoppedSessions } from "./stopped.js";
import { TabManager } from "./tabs.js";

const KEEPALIVE_ALARM = "v2-bridge-keepalive";

const cdp = new CdpManager();
const page = new PageController({
  send: (tabId, method, params) => cdp.send(tabId, method, params),
  isMac: () => chrome.runtime.getPlatformInfo().then((info) => info.os === "mac"),
});
const stopped = new StoppedSessions();
const tabs = new TabManager((event) => {
  bridge.sendEvent(event);
});
const bridge: BridgeRelay = new BridgeRelay({
  loadConfig,
  ensureOffscreen: ensureOffscreenDocument,
  handleRequest: (req) => handleRequest(req, { tabs, cdp, page }),
  onWelcome: async () => {
    const groups = await tabs.reconcile();
    bridge.sendEvent({ type: "event", event: "groups", groups });
  },
});

chrome.tabs.onCreated.addListener((tab) => {
  void tabs.handleTabCreated(tab).catch((err) => console.warn("[v2] adopt failed:", err));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  cdp.forgetTab(tabId);
  page.forget(tabId);
  void tabs.handleTabRemoved(tabId).catch((err) => console.warn("[v2] tab removal failed:", err));
});
chrome.windows.onRemoved.addListener((windowId) => {
  void tabs.handleWindowRemoved(windowId);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  void tabs.handleWindowFocused(windowId).catch(() => undefined);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  cdp.handleDetach(source, reason);
  if (typeof source.tabId === "number") page.forget(source.tabId);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  // A new top-level document makes the tab's snapshot (and its node handles) meaningless.
  if (method === "Page.frameNavigated") {
    const frame = (params as { frame?: { parentId?: string } } | undefined)?.frame;
    if (frame && !frame.parentId) page.forget(source.tabId);
  }
  cdp.handleEvent(source.tabId, method, params);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (TOKEN_KEY in changes || PORT_KEY in changes)) void bridge.pushConfig(true);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === BRIDGE_PORT_NAME) bridge.attach(port);
});
chrome.runtime.onStartup.addListener(() => void bridge.ensure());
chrome.runtime.onInstalled.addListener(() => void bridge.ensure());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void bridge.ensure();
});
void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });

chrome.runtime.onMessage.addListener((message: PopupRequest, _sender, sendResponse) => {
  if (message?.type === "v2:get_state") {
    void Promise.all([
      loadConfig(),
      tabs
        .listSessionGroups()
        .then((sessions) => stopped.annotate(sessions))
        .catch(() => []),
      tabs.listFinished().catch(() => []),
    ]).then(([config, sessions, finished]) => {
      const state: PopupState = {
        status: bridge.status,
        port: config.port,
        token_set: config.token !== null,
        sessions,
        finished,
      };
      sendResponse(state);
    });
    return true;
  }
  if (message?.type === "v2:stop") {
    void stopFromPopup(message.short_id).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:close_session_tabs") {
    void closeStoppedTabs(message.short_id).then(sendResponse);
    return true;
  }
  // The remaining popup actions are direct user clicks, so focusing a window is allowed there.
  if (message?.type === "v2:show_session") {
    void popupAction(() => tabs.showSession(String(message.short_id))).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:open_finished") {
    void popupAction(() => tabs.openFinished(message.group_id)).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:close_finished") {
    void popupClose(() => tabs.closeFinished(message.group_id)).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:close_all_finished") {
    void popupClose(() => tabs.closeAllFinished()).then(sendResponse);
    return true;
  }
  return false;
});

async function stopFromPopup(shortId: string | null): Promise<PopupStopResult> {
  const sent = bridge.sendEvent({ type: "event", event: "stop", short_id: shortId });
  if (!sent) return { ok: false, error: "not connected to the daemon" };
  const ids = shortId !== null ? [shortId] : (await tabs.listSessionGroups().catch(() => [])).map((s) => s.short_id);
  await stopped.add(ids).catch(() => undefined);
  return { ok: true };
}

async function popupAction(fn: () => Promise<void>): Promise<PopupActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function popupClose(fn: () => Promise<{ closed_tabs: number }>): Promise<PopupCloseResult> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Closing tabs from the popup is a user action, offered only for sessions the user stopped. */
async function closeStoppedTabs(shortId: unknown): Promise<PopupCloseResult> {
  if (typeof shortId !== "string" || !(await stopped.has(shortId))) {
    return { ok: false, error: "only a stopped session's tabs can be closed here" };
  }
  try {
    return { ok: true, ...(await tabs.closeSessionTabsLocally(shortId)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

void bridge.ensure();
