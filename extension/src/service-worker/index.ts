/**
 * Service Worker entry point for the OpenCode Browser extension.
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
import { messageRouter } from "./messageRouter.js";
import { updateBadge } from "./badge.js";
import { cdpManager } from "./cdp.js";
import {
  initSidePanelHandler,
  setConnectionStatus,
} from "./sidePanelHandler.js";
import { registerTools } from "./tools/index.js";
import { initKvmHidCleanup } from "./tools/kvmHidTransport.js";

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

console.log("[ServiceWorker] OpenCode Browser extension starting");

// --- Tool registration ---

registerTools(messageRouter);

// --- Side panel handler ---

initSidePanelHandler();

// --- CDP manager ---

cdpManager.initialize().catch((err) => {
  console.error("[ServiceWorker] Failed to initialize CDP manager:", err);
});

// --- GLKVM HID cleanup ---

initKvmHidCleanup();

// --- Native messaging connection ---

// Forward native host connection status changes to side panel
nativeMessaging.onConnectionStatusChange(setConnectionStatus);

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
