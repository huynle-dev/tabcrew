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
  type PopupRequest,
  type PopupState,
  type PopupStopResult,
} from "./config.js";
import { ensureOffscreenDocument } from "./offscreen-client.js";
import { handleRequest } from "./ops.js";
import { BRIDGE_PORT_NAME } from "./relay-protocol.js";
import { BridgeRelay } from "./relay.js";
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

void bridge.ensure();
