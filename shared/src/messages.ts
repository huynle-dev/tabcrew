/**
 * Wire protocol message types for communication between:
 *   Chrome Extension <-> Native Host <-> MCP Server
 *
 * Messages use length-prefixed JSON encoding (4-byte LE length + UTF-8 JSON).
 * Chrome's native messaging API handles this automatically for the
 * Extension <-> Native Host leg; we handle it manually for
 * Native Host <-> MCP Server over Unix domain sockets.
 */

// ---------------------------------------------------------------------------
// Content blocks (shared by request and response)
// ---------------------------------------------------------------------------

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export type ContentBlock = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Messages sent FROM native host / MCP server TO extension (NativeMessage)
// ---------------------------------------------------------------------------

/** Request the extension to execute a tool */
export interface ToolRequest {
  readonly type: "tool_request";
  readonly method: "execute_tool";
  readonly params: {
    readonly request_id: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly client_id?: string;
    readonly session_scope?: string;
  };
}

/** Heartbeat ping */
export interface PingMessage {
  readonly type: "ping";
  readonly timestamp: number;
}

/** Request extension status */
export interface GetStatusMessage {
  readonly type: "get_status";
}

/** Notify extension that an MCP client has connected */
export interface McpConnectedMessage {
  readonly type: "mcp_connected";
  readonly client_id?: string;
}

/** Notify extension that an MCP client has disconnected */
export interface McpDisconnectedMessage {
  readonly type: "mcp_disconnected";
  readonly client_id?: string;
}

/** Union of all messages the native host sends to the extension */
export type NativeMessage =
  | ToolRequest
  | PingMessage
  | GetStatusMessage
  | McpConnectedMessage
  | McpDisconnectedMessage;

// ---------------------------------------------------------------------------
// Messages sent FROM extension TO native host / MCP server (ExtensionMessage)
// ---------------------------------------------------------------------------

/** Tool execution result (success) */
export interface ToolResponseSuccess {
  readonly type: "tool_response";
  readonly request_id: string;
  readonly result: {
    readonly content: readonly ContentBlock[];
  };
  readonly error?: undefined;
}

/** Tool execution result (error) */
export interface ToolResponseError {
  readonly type: "tool_response";
  readonly request_id: string;
  readonly result?: undefined;
  readonly error: {
    readonly content: readonly ContentBlock[];
  };
}

export type ToolResponse = ToolResponseSuccess | ToolResponseError;

/** Heartbeat pong */
export interface PongMessage {
  readonly type: "pong";
  readonly timestamp: number;
}

/** Extension status response */
export interface StatusResponse {
  readonly type: "status_response";
  readonly version: string;
  readonly tabs?: number;
  readonly activeTab?: number;
}

/** Union of all messages the extension sends to the native host */
export type ExtensionMessage =
  | ToolResponse
  | PongMessage
  | StatusResponse;

// ---------------------------------------------------------------------------
// All wire messages
// ---------------------------------------------------------------------------

export type WireMessage = NativeMessage | ExtensionMessage;
