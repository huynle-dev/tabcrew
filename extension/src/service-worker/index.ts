/**
 * Service Worker entry point for the ChromeUse MCP extension.
 *
 * Responsibilities:
 * 1. Initialize native messaging connection to the host process
 * 2. Register tool handlers with the message router
 * 3. Initialize CDP manager for debugger connections
 * 4. Set up lifecycle event listeners (install, startup)
 * 5. Wire side panel handler for UI state broadcasting
 *
 * The service worker is the central coordinator: it receives tool requests
 * from the native host (via native messaging), dispatches them to tool
 * handlers, and sends results back.
 */

import { nativeMessaging } from "./nativeMessaging.js";
import { webSocketConnection } from "./webSocketConnection.js";
import { messageRouter } from "./messageRouter.js";
import { updateBadge } from "./badge.js";
import { cdpManager } from "./cdp.js";
import {
  initSidePanelHandler,
  setConnectionStatus,
} from "./sidePanelHandler.js";
import { registerTools } from "./tools/index.js";

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

console.log("[ServiceWorker] ChromeUse MCP extension starting");

// --- Tool registration ---

registerTools(messageRouter);

// --- Side panel handler ---

initSidePanelHandler();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.action === "chromeuse_fetch_directory_listing") {
    const url = typeof message.url === "string" ? message.url : "";
    fetch(url)
      .then(async (response) => {
        if (!response.ok && !isFileUrl(url)) throw new Error(`HTTP ${response.status}`);
        sendResponse({ ok: true, html: await response.text() });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to load files" });
      });

    return true;
  }

  if (message.action !== "chromeuse_fetch_local_file") {
    return false;
  }

  const url = typeof message.url === "string" ? message.url : "";
  const responseType = message.responseType === "arrayBuffer" ? "arrayBuffer" : "text";
  fetch(url)
    .then(async (response) => {
      if (!response.ok && !isFileUrl(url)) throw new Error(`HTTP ${response.status}`);
      if (responseType === "arrayBuffer") {
        sendResponse({ ok: true, arrayBuffer: await response.arrayBuffer() });
        return;
      }
      sendResponse({ ok: true, text: await response.text() });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to load preview" });
    });

  return true;
});

function isFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

// --- CDP manager ---

cdpManager.initialize().catch((err) => {
  console.error("[ServiceWorker] Failed to initialize CDP manager:", err);
});

// --- Browser transport connections ---

function syncBrowserTransportStatus(): void {
  const websocketStatus = webSocketConnection.status;
  const nativeStatus = nativeMessaging.status;

  if (websocketStatus === "connected" || nativeStatus === "connected") {
    setConnectionStatus("connected");
    return;
  }

  if (websocketStatus === "connecting" || nativeStatus === "connecting") {
    setConnectionStatus("connecting");
    return;
  }

  if (websocketStatus === "error" || nativeStatus === "error") {
    setConnectionStatus("error");
    return;
  }

  setConnectionStatus("disconnected");
}

// Keep the side panel showing the combined state across WebSocket and native
// messaging, so managed-Chrome native failures do not hide a live WebSocket.
nativeMessaging.onConnectionStatusChange(syncBrowserTransportStatus);
webSocketConnection.onConnectionStatusChange(syncBrowserTransportStatus);

nativeMessaging.connect();

// ---------------------------------------------------------------------------
// Lifecycle Events
// ---------------------------------------------------------------------------

/**
 * Handle extension install/update events.
 */
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[ServiceWorker] Installed:", details.reason);

  if (details.reason === "install") {
    // First install - show disconnected status
    updateBadge("disconnected");
  }
});

/**
 * Handle service worker startup (e.g., after being suspended).
 * Re-establish native messaging connection.
 */
chrome.runtime.onStartup.addListener(() => {
  console.log("[ServiceWorker] Starting up");
  nativeMessaging.connect();
});
