/**
 * TabCrew offscreen document: holds the daemon WebSocket so a slow `WebSocket.send` cannot
 * stall the service worker. Everything chrome.* stays in the service worker.
 */

import type { SocketLike } from "../bridge.js";
import { BRIDGE_PORT_NAME, BRIDGE_STATS_MESSAGE } from "../relay-protocol.js";
import { OffscreenHost } from "./host.js";

declare const __EXTENSION_VERSION__: string;

const host = new OffscreenHost({
  connect: () => chrome.runtime.connect({ name: BRIDGE_PORT_NAME }),
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  extensionVersion: __EXTENSION_VERSION__,
});

chrome.runtime.onMessage.addListener((message: { type?: unknown }, _sender, sendResponse) => {
  if (message?.type !== BRIDGE_STATS_MESSAGE) return false;
  sendResponse(host.stats());
  return false;
});

host.start();
