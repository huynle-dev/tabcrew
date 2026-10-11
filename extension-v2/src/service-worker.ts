/**
 * ChromeUse v2 service worker: wires the daemon bridge, session tab groups, and CDP.
 * All Chrome listeners are registered synchronously at top level (MV3 requirement).
 */

import { Bridge, type SocketLike } from "./bridge.js";
import { CdpManager } from "./cdp.js";
import {
  PORT_KEY,
  TOKEN_KEY,
  loadConfig,
  type PopupRequest,
  type PopupState,
  type PopupStopResult,
} from "./config.js";
import { handleRequest } from "./ops.js";
import { PageController } from "./snapshot/controller.js";
import { TabManager } from "./tabs.js";

const KEEPALIVE_ALARM = "v2-bridge-keepalive";

const cdp = new CdpManager();
const page = new PageController({
  send: (tabId, method, params) => cdp.send(tabId, method, params),
  isMac: () => chrome.runtime.getPlatformInfo().then((info) => info.os === "mac"),
});
const tabs = new TabManager((event) => {
  bridge.sendEvent(event);
});
const bridge: Bridge = new Bridge({
  loadConfig,
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  extensionVersion: chrome.runtime.getManifest().version,
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
chrome.debugger.onDetach.addListener((source, reason) => {
  cdp.handleDetach(source, reason);
  if (typeof source.tabId === "number") page.forget(source.tabId);
});
// A new top-level document makes the tab's snapshot (and its node handles) meaningless.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.frameNavigated" || typeof source.tabId !== "number") return;
  const frame = (params as { frame?: { parentId?: string } } | undefined)?.frame;
  if (frame && !frame.parentId) page.forget(source.tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (TOKEN_KEY in changes || PORT_KEY in changes)) void bridge.reconfigure();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void bridge.ensureConnected();
});
void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });

chrome.runtime.onMessage.addListener((message: PopupRequest, _sender, sendResponse) => {
  if (message?.type === "v2:get_state") {
    void Promise.all([loadConfig(), tabs.listSessionGroups().catch(() => [])]).then(([config, sessions]) => {
      const state: PopupState = { status: bridge.status, port: config.port, token_set: config.token !== null, sessions };
      sendResponse(state);
    });
    return true;
  }
  if (message?.type === "v2:stop") {
    const sent = bridge.sendEvent({ type: "event", event: "stop", short_id: message.short_id });
    const result: PopupStopResult = sent ? { ok: true } : { ok: false, error: "not connected to the daemon" };
    sendResponse(result);
    return false;
  }
  return false;
});

void bridge.start();
