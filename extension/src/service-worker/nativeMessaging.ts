/**
 * NativeMessagingConnection manages the connection between the Chrome extension
 * service worker and the native messaging host process.
 *
 * Protocol: Chrome's native messaging API handles the 4-byte length-prefixed
 * JSON framing automatically. We just send/receive plain objects.
 *
 * Reconnection: Uses exponential backoff (1s -> 2s -> 4s -> ... -> 30s max)
 * up to 10 attempts before giving up.
 */

import type {
  NativeMessage,
  ExtensionMessage,
  ToolResult,
} from "@opencode-chrome/shared";
import type { ConnectionStatus } from "../types/messages.js";
import { updateBadge } from "./badge.js";
import { messageRouter } from "./messageRouter.js";
import {
  recordToolStart,
  recordToolComplete,
} from "./sidePanelHandler.js";

/** Native messaging host name — must match the installed manifest JSON filename */
const NATIVE_HOST_NAME = "com.opencode.chrome_bridge";

/** Maximum reconnection attempts before giving up */
const MAX_RECONNECT_ATTEMPTS = 10;

/** Maximum backoff delay in milliseconds (30 seconds) */
const MAX_BACKOFF_MS = 30_000;

/** Keepalive alarm name */
const KEEPALIVE_ALARM = "keepalive";

/** Keepalive interval in minutes (24 seconds = 0.4 minutes) */
const KEEPALIVE_INTERVAL_MINUTES = 0.4;

export class NativeMessagingConnection {
  private port: chrome.runtime.Port | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private _status: ConnectionStatus = "disconnected";
  private onStatusChange: ((status: ConnectionStatus) => void) | null = null;

  get status(): ConnectionStatus {
    return this._status;
  }

  /**
   * Register a callback for connection status changes.
   */
  onConnectionStatusChange(cb: (status: ConnectionStatus) => void): void {
    this.onStatusChange = cb;
  }

  /**
   * Establish a connection to the native messaging host.
   * Sets up message and disconnect listeners, and starts keepalive alarm.
   */
  connect(): void {
    this.setStatus("connecting");

    try {
      this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      this.reconnectAttempts = 0;

      this.port.onMessage.addListener((message: NativeMessage) => {
        this.handleMessage(message);
      });

      this.port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.warn(
          "[NativeMessaging] Disconnected:",
          error?.message ?? "unknown reason",
        );
        this.port = null;
        this.setStatus("disconnected");
        this.scheduleReconnect();
      });

      // Start keepalive alarm to prevent idle disconnection
      chrome.alarms.create(KEEPALIVE_ALARM, {
        periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
      });

      this.setStatus("connected");
    } catch (error) {
      console.error("[NativeMessaging] Failed to connect:", error);
      this.setStatus("error");
      this.scheduleReconnect();
    }
  }

  /**
   * Cleanly disconnect from the native host and cancel any pending reconnect.
   */
  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    chrome.alarms.clear(KEEPALIVE_ALARM);
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
    this.setStatus("disconnected");
  }

  /**
   * Send a message to the native host.
   * Throws if not connected.
   */
  sendMessage(message: ExtensionMessage): void {
    if (!this.port) {
      throw new Error("Not connected to native host");
    }
    this.port.postMessage(message);
  }

  /**
   * Send a tool execution result back to the native host.
   */
  sendToolResponse(result: ToolResult, requestId: string): void {
    if (result.success) {
      this.sendMessage({
        type: "tool_response",
        request_id: requestId,
        result: { content: result.content },
      });
    } else {
      this.sendMessage({
        type: "tool_response",
        request_id: requestId,
        error: { content: result.content },
      });
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * Gives up after MAX_RECONNECT_ATTEMPTS.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[NativeMessaging] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
      );
      this.setStatus("error");
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempts++;

    console.log(
      `[NativeMessaging] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Handle an incoming message from the native host.
   * Routes tool requests to the message router, responds to pings, etc.
   */
  private handleMessage(message: NativeMessage): void {
    switch (message.type) {
      case "tool_request": {
        const toolName = message.params?.tool ?? message.method;
        const entryId = recordToolStart(toolName);

        messageRouter
          .route({
            method: message.method,
            params: message.params,
          })
          .then((result) => {
            recordToolComplete(entryId, result.success);
            this.sendToolResponse(result, message.params.request_id);
          })
          .catch((error) => {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            recordToolComplete(entryId, false, errorMsg);
            this.sendToolResponse(
              {
                success: false,
                content: [
                  {
                    type: "text",
                    text: `Internal error: ${errorMsg}`,
                  },
                ],
              },
              message.params.request_id,
            );
          });
        break;
      }

      case "ping":
        this.sendMessage({ type: "pong", timestamp: Date.now() });
        break;

      case "get_status":
        this.sendMessage({
          type: "status_response",
          version: chrome.runtime.getManifest().version,
        });
        break;

      case "mcp_connected":
        this.setStatus("connected");
        break;

      case "mcp_disconnected":
        // MCP server disconnected, but native host is still alive
        // Keep the connection open — the native host may reconnect to MCP
        console.warn("[NativeMessaging] MCP server disconnected");
        break;

      default:
        console.warn(
          "[NativeMessaging] Unknown message type:",
          (message as Record<string, unknown>).type,
        );
    }
  }

  /**
   * Update connection status and badge indicator.
   */
  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    updateBadge(status);
    this.onStatusChange?.(status);
  }
}

/** Singleton instance */
export const nativeMessaging = new NativeMessagingConnection();
