/**
 * Tool name constants and types for the OpenCode Chrome Extension.
 *
 * These must match the tool schemas registered in the MCP server
 * and the tool handlers in the Chrome extension service worker.
 */

/** All tool names exposed through the MCP server */
export const TOOL_NAMES = {
  /** Take screenshots, click, type, scroll, drag in the browser */
  COMPUTER: "computer",
  /** Navigate to a URL, go back/forward, or reload */
  NAVIGATE: "navigate",
  /** Read the current page as an accessibility tree */
  READ_PAGE: "read_page",
  /** Find an element on the page using natural language description */
  FIND: "find",
  /** Set form field values by element reference */
  FORM_INPUT: "form_input",
  /** Extract all text content from the current page */
  GET_PAGE_TEXT: "get_page_text",
  /** Execute JavaScript in the page context */
  JAVASCRIPT: "javascript_tool",
  /** Upload a file to a file input element */
  FILE_UPLOAD: "file_upload",
  /** Read browser console messages */
  READ_CONSOLE: "read_console_messages",
  /** Read captured network requests */
  READ_NETWORK: "read_network_requests",
  /** Resize the browser window */
  RESIZE_WINDOW: "resize_window",
  /** Get information about open tabs and tab groups */
  TABS_CONTEXT: "tabs_context",
  /** Create a new tab */
  TABS_CREATE: "tabs_create",
  /** Close a tab by ID */
  TABS_CLOSE: "tabs_close",
  /** Record browser actions as a GIF */
  GIF_CREATOR: "gif_creator",
  /** Get GLKVM connection and session status */
  GLKVM_STATUS: "glkvm_status",
  /** Capture a screenshot from a GLKVM target */
  GLKVM_SCREENSHOT: "glkvm_screenshot",
  /** Send keyboard and pointer input to a GLKVM target */
  GLKVM_INPUT: "glkvm_input",
  /** Wait for a GLKVM target's captured video frame to change */
  GLKVM_WAIT: "glkvm_wait",
  /** Execute a batch of GLKVM input, capture, and frame wait steps */
  GLKVM_SEQUENCE: "glkvm_sequence",
  /** Read optional GLKVM OCR text when the device exposes OCR support */
  GLKVM_OCR: "glkvm_ocr",
} as const;

/** Union type of all valid tool name strings */
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** Array of all tool names for iteration / validation */
export const ALL_TOOL_NAMES: readonly ToolName[] = Object.values(TOOL_NAMES);

/**
 * Result of a tool execution, returned by the extension to the native host.
 */
export interface ToolResult {
  readonly success: boolean;
  readonly content: readonly import("./messages.js").ContentBlock[];
}

/**
 * Context provided to tool handlers during execution.
 */
export interface ToolContext {
  readonly sessionScope?: string;
}
