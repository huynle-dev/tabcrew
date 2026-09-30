/**
 * MCP Server that exposes Chrome browser tools for ChromeUse MCP.
 *
 * Registers 16 tool schemas via the MCP protocol and forwards
 * tool calls to the Chrome extension through WebSocket-first browser transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ContentBlock as McpContentBlock,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_NAMES } from "@chromeuse/shared";
import { SocketClient } from "./socketClient.js";
import type { BrowserTransport, ToolRequestMetadata, ToolRequestResult } from "./transport.js";
import { WebSocketBridge } from "./webSocketBridge.js";
import { getAiProvider, type AiProvider } from "./aiProvider.js";
import { AI_TOOL_SCHEMAS, AI_TOOL_NAMES, handleAiTool } from "./aiTools.js";

const NO_EXTENSION_CONNECTED_MESSAGE =
  "No extension connected. Open the ChromeUse side panel and click Connect, or keep a native host session running for fallback.";

type ClosableTransport = BrowserTransport & {
  close?: () => void | Promise<void>;
};

export class WebSocketFirstTransport implements BrowserTransport {
  private lastWebSocketError: Error | null = null;
  private lastNativeError: Error | null = null;

  constructor(
    private readonly webSocket: BrowserTransport = new WebSocketBridge(),
    private readonly native: BrowserTransport = new SocketClient()
  ) {}

  get connected(): boolean {
    return this.webSocket.connected || this.native.connected;
  }

  async connect(): Promise<void> {
    try {
      await this.webSocket.connect();
      this.lastWebSocketError = null;
    } catch (error) {
      this.lastWebSocketError = toError(error);
    }

    if (this.webSocket.connected || this.native.connected) return;

    try {
      await this.native.connect();
      this.lastNativeError = null;
    } catch (error) {
      this.lastNativeError = toError(error);
    }
  }

  async sendToolRequest(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    metadata?: ToolRequestMetadata
  ): Promise<ToolRequestResult> {
    if (this.webSocket.connected) {
      return metadata
        ? this.webSocket.sendToolRequest(tool, args, timeoutMs, metadata)
        : this.webSocket.sendToolRequest(tool, args, timeoutMs);
    }

    if (this.native.connected) {
      return metadata
        ? this.native.sendToolRequest(tool, args, timeoutMs, metadata)
        : this.native.sendToolRequest(tool, args, timeoutMs);
    }

    throw new Error(this.unavailableMessage());
  }

  disconnect(): void {
    this.webSocket.disconnect();
    this.native.disconnect();
  }

  async close(): Promise<void> {
    await Promise.all([
      closeTransport(this.webSocket),
      closeTransport(this.native),
    ]);
  }

  private unavailableMessage(): string {
    const details = [
      this.lastWebSocketError?.message,
      this.lastNativeError?.message,
    ].filter(Boolean);

    if (details.length === 0) return NO_EXTENSION_CONNECTED_MESSAGE;
    return `${NO_EXTENSION_CONNECTED_MESSAGE} (${details.join("; ")})`;
  }
}

// ---------------------------------------------------------------------------
// Tool schema definitions
// ---------------------------------------------------------------------------

const INTERACTION_POLICY =
  "Default workflow: start with tabs_context to choose the target tab, read visible page text for understanding, use accessibility/read_page or find for user-visible controls, use javascript_tool only for exact state or geometry, then use computer for last-mile visual mouse/keyboard actions.";

const TOOL_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.NAVIGATE,
    description: "Navigate to a URL, go back/forward, or reload",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["goto", "back", "forward", "reload"],
          description: "Navigation action to perform",
        },
        url: {
          type: "string",
          description: 'URL to navigate to (required for "goto" action)',
        },
        tabId: {
          type: "number",
          description: "Target tab ID (optional, defaults to active tab)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: TOOL_NAMES.COMPUTER,
    description:
      `Last-mile visual interaction tool for screenshots, mouse, keyboard, scroll, and drag. Prefer read_page/find refs before coordinates when possible; use count or move_path for repeated/precise mouse-heavy interactions instead of parallel calls. Coordinates are in screenshot pixel space. ${INTERACTION_POLICY}`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "click",
            "double_click",
            "right_click",
            "type",
            "key",
            "scroll",
            "drag",
            "move",
            "move_path",
          ],
          description: "The action to perform",
        },
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        x: {
          type: "number",
          description: "X coordinate in screenshot pixel space",
        },
        y: {
          type: "number",
          description: "Y coordinate in screenshot pixel space",
        },
        ref: {
          type: "string",
          description: "Element reference from read_page/find for ref-based clicks",
        },
        overlay: {
          type: "string",
          enum: ["none", "temporary-grid"],
          description:
            'Optional overlay for screenshot action. "temporary-grid" injects a coordinate grid only during capture, then removes it before returning.',
        },
        text: {
          type: "string",
          description: 'Text to type (for "type" action)',
        },
        key: {
          type: "string",
          description:
            'Key name or combo like "Enter", "ctrl+a" (for "key" action)',
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction",
        },
        amount: {
          type: "number",
          description: "Scroll distance in pixels",
        },
        count: {
          type: "number",
          description: "Number of repeated click actions to perform in one serialized request (max 100)",
        },
        startX: {
          type: "number",
          description: 'Start X coordinate for "drag" action',
        },
        startY: {
          type: "number",
          description: 'Start Y coordinate for "drag" action',
        },
        endX: {
          type: "number",
          description: 'End X coordinate for "drag" action',
        },
        endY: {
          type: "number",
          description: 'End Y coordinate for "drag" action',
        },
        points: {
          type: "array",
          description: 'Ordered screenshot-coordinate waypoints for "move_path" action',
          items: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["x", "y"],
          },
        },
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: TOOL_NAMES.READ_PAGE,
    description:
      `Read the current page content as an accessibility tree, HTML, or plain text. Use accessibility for controls/refs before clicking, text for visible content, and HTML only when structure matters. ${INTERACTION_POLICY}`,
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        format: {
          type: "string",
          enum: ["accessibility", "html", "text"],
          description:
            'Output format (default: "accessibility"). The accessibility tree includes element references for targeting.',
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: TOOL_NAMES.FIND,
    description:
      `Find a user-visible element by natural language. Prefer this before computer coordinate clicks; it returns refs and bounds for buttons, links, inputs, menus, and other controls. ${INTERACTION_POLICY}`,
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        query: {
          type: "string",
          description:
            'Natural language description of the element (e.g. "the search button", "email input field")',
        },
        maxResults: {
          type: "number",
          description: "Maximum number of matching elements to return (default: 5)",
        },
      },
      required: ["tabId", "query"],
    },
  },
  {
    name: TOOL_NAMES.FORM_INPUT,
    description:
      "Set form field values by element reference. Works with text inputs, selects, checkboxes, radio buttons.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        ref: {
          type: "string",
          description:
            "Element reference from accessibility tree (e.g. ref_42)",
        },
        value: {
          type: "string",
          description: "Value to set on the form element",
        },
      },
      required: ["tabId", "ref", "value"],
    },
  },
  {
    name: TOOL_NAMES.GET_PAGE_TEXT,
    description:
      `Read first for most pages: extract visible text content without markup to understand headings, labels, articles, prompts, blockers, and login/cookie states before acting. ${INTERACTION_POLICY}`,
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        maxLength: {
          type: "number",
          description: "Maximum characters to return (default: 100000, max: 500000)",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: TOOL_NAMES.JAVASCRIPT,
    description:
      `Execute JavaScript in the page context for exact state, DOM geometry, counters, selected values, hidden app state, or verification. Do not use as the first read when visible text/accessibility is enough. ${INTERACTION_POLICY}`,
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        code: {
          type: "string",
          description: "JavaScript code to execute in the page context",
        },
        awaitPromise: {
          type: "boolean",
          description: "Whether to await Promise results (default: true)",
        },
        timeout: {
          type: "number",
          description: "Evaluation timeout in milliseconds (default: 30000)",
        },
      },
      required: ["tabId", "code"],
    },
  },
  {
    name: TOOL_NAMES.FILE_UPLOAD,
    description: "Upload a file to a file input element on the page",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        selector: {
          type: "string",
          description: "CSS selector for the file input element",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to upload",
        },
      },
      required: ["tabId", "selector", "files"],
    },
  },
  {
    name: TOOL_NAMES.READ_CONSOLE,
    description:
      "Read browser console messages captured via CDP. Messages include level, text, timestamp, source URL, and line number. Captured since CDP attachment.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The tab to read console messages from",
        },
        clear: {
          type: "boolean",
          description:
            "If true, clears stored messages after returning them (default: false)",
        },
        level: {
          type: "string",
          enum: ["log", "debug", "info", "warning", "error"],
          description: "Filter by log level. Returns all levels if omitted.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of messages to return, most recent first (default: 100)",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: TOOL_NAMES.READ_NETWORK,
    description:
      "Read captured network requests via CDP. Shows URL, method, resource type, status, mimeType, and response timing.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The tab to read network requests from",
        },
        clear: {
          type: "boolean",
          description:
            "If true, clears stored requests after returning them (default: false)",
        },
        urlPattern: {
          type: "string",
          description: "Filter requests by URL substring match",
        },
        method: {
          type: "string",
          description:
            'Filter by HTTP method (e.g., "GET", "POST"). Case-insensitive.',
        },
        limit: {
          type: "number",
          description:
            "Maximum number of requests to return, most recent first (default: 100)",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: TOOL_NAMES.RESIZE_WINDOW,
    description: "Resize the browser window to specific dimensions",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID whose window should be resized",
        },
        width: { type: "number", description: "Window width in pixels" },
        height: { type: "number", description: "Window height in pixels" },
      },
      required: ["tabId", "width", "height"],
    },
  },
  {
    name: TOOL_NAMES.TABS_CONTEXT,
    description:
      `Start here: get all open tabs and tab groups so you choose the right target tab before reading or acting. Returns tab IDs, titles, URLs, and group assignments. ${INTERACTION_POLICY}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: TOOL_NAMES.TABS_CREATE,
    description: "Create a new browser tab, optionally with a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open in the new tab" },
        active: {
          type: "boolean",
          description: "Whether to make the tab active (default: true)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: TOOL_NAMES.TABS_CLOSE,
    description: "Close a browser tab by its ID",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "ID of the tab to close" },
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "IDs of tabs to close; takes precedence over tabId",
        },
      },
    },
  },
  {
    name: TOOL_NAMES.GIF_CREATOR,
    description:
      'Record browser actions as an animated GIF. Use "start" to begin recording, "screenshot" to capture frames, and "stop" to finish and return the GIF.',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "screenshot", "stop"],
          description: "Recording action to perform",
        },
        tabId: {
          type: "number",
          description: "Target tab ID for the recording session",
        },
        delay: {
          type: "number",
          description: "Frame delay in centiseconds for stop action (default: 50)",
        },
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: TOOL_NAMES.MARKDOWN_RENDER,
    description:
      "Render markdown text or accessible workspace file content to safe HTML. Raw HTML is disabled by default.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description:
            "Markdown text to render. Provide this, filePath, or url.",
        },
        filePath: {
          type: "string",
          description:
            "Workspace file path containing markdown to render when file access is available.",
        },
        url: {
          type: "string",
          description:
            "Accessible file: or extension-accessible URL containing markdown to render when direct workspace file access is unavailable.",
        },
        allowRawHtml: {
          type: "boolean",
          description:
            "Allow raw HTML in markdown input. Disabled by default; unsafe HTML is escaped unless explicitly enabled by the handler.",
        },
      },
    },
  },
  {
    name: TOOL_NAMES.WORKSPACE_LIST_FILES,
    description:
      "List files and directories under the workspace selected in the ChromeUse side panel. Requires current File System Access permission for the selected workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative directory path to list. Defaults to the workspace root.",
        },
        depth: {
          type: "number",
          description:
            "Maximum recursive directory depth to include. Defaults to 1.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of entries to return before truncating the listing.",
        },
      },
    },
  },
  {
    name: TOOL_NAMES.WORKSPACE_READ_FILE,
    description:
      "Read a text-like file from the workspace selected in the ChromeUse side panel. Requires current File System Access permission for the selected workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to the file to read.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of characters to return before truncating file content.",
        },
        encoding: {
          type: "string",
          enum: ["utf-8"],
          description: "Text encoding to use when reading the file. Defaults to utf-8.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: TOOL_NAMES.WORKSPACE_WRITE_FILE,
    description:
      "Write a file to the selected workspace using the File System Access API. Requires current readwrite permission for the selected workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to write inside the selected workspace.",
        },
        dataUrl: {
          type: "string",
          description: "Data URL containing the file content to write.",
        },
        createDirectories: {
          type: "boolean",
          description:
            "Create parent directories if they do not exist. Defaults to true.",
        },
      },
      required: ["path", "dataUrl"],
    },
  },
  {
    name: TOOL_NAMES.HEALTH_CHECK,
    description: "Check health and connectivity of the ChromeUse extension tools.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: TOOL_NAMES.SAVE_RESOURCE,
    description:
      "Save a resource from a URL. Fetches the resource using the page's authentication context (cookies), writes to the selected workspace when outputPath is provided, or downloads to the browser's Downloads folder when omitted. Supports all file types: images, PDFs, documents, archives, etc.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID for authentication context",
        },
        url: {
          type: "string",
          description: "URL of the resource to download",
        },
        outputPath: {
          type: "string",
          description:
            "Optional: workspace-relative path where to save the file. Can be a directory (ending with /) or full file path. If omitted, saves to the browser's Downloads folder.",
        },
        filename: {
          type: "string",
          description:
            "Optional: filename to use. If omitted, extracts from URL or uses 'download' as fallback.",
        },
      },
      required: ["tabId", "url"],
    },
  },
  {
    name: TOOL_NAMES.WAIT_FOR,
    description:
      "Wait until a page condition holds before continuing, instead of guessing a delay. Use after a click/navigation to synchronize the next step. Conditions: a CSS selector becomes visible, a selector becomes hidden/absent, page text appears, network goes idle, or a console message matches a pattern.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID" },
        for: {
          type: "string",
          enum: ["selector", "selector_hidden", "text", "network_idle", "console"],
          description:
            "Condition to wait for: 'selector' (visible), 'selector_hidden', 'text' (present in body), 'network_idle', or 'console' (message matches pattern).",
        },
        selector: {
          type: "string",
          description: "CSS selector. Required for 'selector' and 'selector_hidden'.",
        },
        text: {
          type: "string",
          description: "Text to wait for in the page body. Required for 'text'.",
        },
        pattern: {
          type: "string",
          description: "JavaScript regex source matched against console output. Required for 'console'.",
        },
        timeoutMs: {
          type: "number",
          description: "Overall timeout in milliseconds (default 10000).",
        },
        idleMs: {
          type: "number",
          description: "Idle window in milliseconds for 'network_idle' (default 500).",
        },
        pollMs: {
          type: "number",
          description: "Poll interval in milliseconds (default 200).",
        },
      },
      required: ["tabId", "for"],
    },
  },
  {
    name: TOOL_NAMES.NETWORK_INTERCEPT,
    description:
      "Mock or block network requests for a tab via the Chrome DevTools Fetch domain. Use 'mock' to return a canned status/body for matching requests (stub an API, force an error), 'block' to fail them, 'list' to see active rules, and 'clear' to remove all rules. Rules match by URL substring, or glob when the pattern contains '*', plus an optional HTTP method.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID" },
        action: {
          type: "string",
          enum: ["mock", "block", "list", "clear"],
          description: "Interception action to perform.",
        },
        urlPattern: {
          type: "string",
          description: "URL substring (or glob with '*') to match. Required for mock/block.",
        },
        method: {
          type: "string",
          description: "Optional HTTP method to match (e.g. GET, POST).",
        },
        status: {
          type: "number",
          description: "Response status code for 'mock' (default 200).",
        },
        body: {
          type: "string",
          description: "Response body for 'mock'.",
        },
        contentType: {
          type: "string",
          description: "Content-Type header for 'mock' (default application/json).",
        },
        headers: {
          type: "object",
          description: "Extra response headers for 'mock' as a name->value map.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: TOOL_NAMES.COOKIES,
    description:
      "Inspect and mutate browser cookies. 'get' lists cookies for a url or domain, 'set' creates/updates one, 'delete' removes one by url+name, 'clear' removes all for a url or domain. Useful for exporting an authenticated session or resetting state between runs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "delete", "clear"], description: "Cookie action." },
        url: { type: "string", description: "Cookie URL (required for set/delete; usable for get/clear)." },
        domain: { type: "string", description: "Domain filter for get/clear (alternative to url)." },
        name: { type: "string", description: "Cookie name (required for set/delete)." },
        value: { type: "string", description: "Cookie value (for set)." },
        path: { type: "string", description: "Cookie path (for set)." },
        secure: { type: "boolean", description: "Secure flag (for set)." },
        httpOnly: { type: "boolean", description: "HttpOnly flag (for set)." },
        expirationDate: { type: "number", description: "Expiry as a UNIX timestamp in seconds (for set)." },
        sameSite: { type: "string", enum: ["no_restriction", "lax", "strict"], description: "SameSite policy (for set)." },
      },
      required: ["action"],
    },
  },
  {
    name: TOOL_NAMES.STORAGE,
    description:
      "Read or write a tab's localStorage or sessionStorage. 'get' returns one key (or all entries when key is omitted), 'set' assigns a key, 'remove' deletes a key, 'clear' empties the store. Use 'area' to choose local (default) or session.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        action: { type: "string", enum: ["get", "set", "remove", "clear"], description: "Storage action." },
        area: { type: "string", enum: ["local", "session"], description: "Storage area (default local)." },
        key: { type: "string", description: "Storage key (required for set/remove; optional for get)." },
        value: { type: "string", description: "Value to store (required for set)." },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: TOOL_NAMES.EMULATE,
    description:
      "Emulate device and environment conditions for a tab (responsive/edge-case testing). Actions: 'device' (viewport + mobile/touch, via preset or explicit width/height), 'user_agent', 'geolocation', 'color_scheme' (light/dark), 'network' (online/offline/slow-3g/fast-3g), 'cpu' (slowdown multiplier), and 'reset' to clear all overrides.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        action: {
          type: "string",
          enum: ["device", "user_agent", "geolocation", "color_scheme", "network", "cpu", "reset"],
          description: "Emulation action.",
        },
        preset: {
          type: "string",
          enum: ["iphone-12", "pixel-5", "ipad", "desktop"],
          description: "Device preset for 'device'.",
        },
        width: { type: "number", description: "Viewport width for 'device' (if no preset)." },
        height: { type: "number", description: "Viewport height for 'device' (if no preset)." },
        deviceScaleFactor: { type: "number", description: "Device scale factor for 'device' (default 1)." },
        mobile: { type: "boolean", description: "Mobile mode for 'device'." },
        touch: { type: "boolean", description: "Touch emulation for 'device'." },
        userAgent: { type: "string", description: "User-Agent string for 'user_agent'." },
        latitude: { type: "number", description: "Latitude for 'geolocation'." },
        longitude: { type: "number", description: "Longitude for 'geolocation'." },
        accuracy: { type: "number", description: "Accuracy in meters for 'geolocation' (default 100)." },
        scheme: { type: "string", enum: ["light", "dark", "no-preference"], description: "prefers-color-scheme for 'color_scheme'." },
        profile: { type: "string", enum: ["online", "offline", "slow-3g", "fast-3g"], description: "Network profile for 'network'." },
        offline: { type: "boolean", description: "Offline flag for 'network' (if no profile)." },
        latency: { type: "number", description: "Latency ms for 'network' (if no profile)." },
        downloadThroughput: { type: "number", description: "Download bytes/sec for 'network' (if no profile; -1 = unlimited)." },
        uploadThroughput: { type: "number", description: "Upload bytes/sec for 'network' (if no profile; -1 = unlimited)." },
        rate: { type: "number", description: "CPU slowdown multiplier for 'cpu' (>= 1)." },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: TOOL_NAMES.PERFORMANCE_METRICS,
    description:
      "Capture page load timings (TTFB, DOMContentLoaded, load), Core Web Vitals (FCP, LCP, CLS), a resource transfer summary, and runtime metrics (JS heap, DOM nodes) for a tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number", description: "Target tab ID." } },
      required: ["tabId"],
    },
  },
  {
    name: TOOL_NAMES.SCREENSHOT_ELEMENT,
    description:
      "Screenshot a single element by CSS selector (scrolls it into view and clips to its bounds), instead of the whole viewport. Returns a PNG image.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        selector: { type: "string", description: "CSS selector of the element to capture." },
        padding: { type: "number", description: "Extra pixels around the element (default 0)." },
      },
      required: ["tabId", "selector"],
    },
  },
  {
    name: TOOL_NAMES.PRINT_TO_PDF,
    description:
      "Render the page to PDF (Page.printToPDF) and save it. When outputPath is provided it is written to the selected workspace; otherwise the PDF is saved to the browser's Downloads folder.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        outputPath: { type: "string", description: "Optional workspace-relative path to save the PDF." },
        filename: { type: "string", description: "Filename for the Downloads fallback (default page.pdf)." },
        landscape: { type: "boolean", description: "Landscape orientation (default false)." },
        printBackground: { type: "boolean", description: "Print background graphics (default true)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: TOOL_NAMES.EXTRACT_STRUCTURED,
    description:
      "Extract a table or a repeated list into structured JSON. Point selector at a <table> (returns headers + rows) or at a repeated element set (returns a list of text). Optionally save the JSON to the selected workspace via outputPath.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        selector: { type: "string", description: "CSS selector of the table or repeated elements." },
        as: { type: "string", enum: ["auto", "table", "list"], description: "Extraction mode (default auto)." },
        outputPath: { type: "string", description: "Optional workspace-relative path to save the JSON." },
      },
      required: ["tabId", "selector"],
    },
  },
  {
    name: TOOL_NAMES.TAB_SESSION,
    description:
      "Save and restore named sets of tabs (a 'project'). 'save' snapshots a window's tabs and group membership under a name, 'restore' opens them in a new window recreating groups, 'list' shows saved sessions, 'delete' removes one.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "restore", "list", "delete"], description: "Session action." },
        name: { type: "string", description: "Session name (required for save/restore/delete)." },
        windowId: { type: "number", description: "Window to save (defaults to the last focused window)." },
      },
      required: ["action"],
    },
  },
  {
    name: TOOL_NAMES.HISTORY_SEARCH,
    description:
      "Search the browser's history by text and time window. Returns matching pages with title, url, last visit time, and visit count.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match (empty matches everything)." },
        maxResults: { type: "number", description: "Maximum results (default 50)." },
        days: { type: "number", description: "Only include visits from the last N days." },
      },
    },
  },
  {
    name: TOOL_NAMES.BOOKMARKS,
    description:
      "Search, list, or create bookmarks. 'search' finds bookmarks matching a query, 'list' returns children of a folder (root when id omitted), 'create' adds a bookmark (with url) or folder (title only).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "list", "create"], description: "Bookmark action." },
        query: { type: "string", description: "Search text (required for search)." },
        id: { type: "string", description: "Folder id for 'list'." },
        parentId: { type: "string", description: "Parent folder id for 'create'." },
        title: { type: "string", description: "Title for 'create'." },
        url: { type: "string", description: "URL for 'create' (omit to create a folder)." },
      },
      required: ["action"],
    },
  },
  {
    name: TOOL_NAMES.COVERAGE,
    description:
      "Measure JavaScript and CSS coverage to find unused code. Call with action 'start', interact with the page, then 'stop' to get per-URL used vs total functions (JS, function-level) and used vs total rules (CSS), with overall percentages.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        action: { type: "string", enum: ["start", "stop"], description: "Begin or end coverage tracking." },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: TOOL_NAMES.ACCESSIBILITY_AUDIT,
    description:
      "Run an axe-core accessibility audit on a tab and return WCAG violations (id, impact, help, affected node count, sample targets). Optionally scope to a selector or filter by rule tags like wcag2a/wcag2aa.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        tags: { type: "array", items: { type: "string" }, description: "Rule tags to run, e.g. [\"wcag2a\",\"wcag2aa\"]. Default: all." },
        selector: { type: "string", description: "Scope the audit to a CSS selector." },
        maxViolations: { type: "number", description: "Maximum violations to return (default 50)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: TOOL_NAMES.CLIPBOARD,
    description:
      "Read from or write to the system clipboard. 'write' copies text; 'read' returns clipboard text (may fail when the browser blocks unfocused clipboard reads).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write"], description: "Clipboard action." },
        text: { type: "string", description: "Text to copy (required for write)." },
      },
      required: ["action"],
    },
  },
  {
    name: TOOL_NAMES.DEBUG_INSPECT,
    description:
      "Set a one-shot breakpoint and capture program state when it is hit, then resume. Breaks at urlRegex + lineNumber (0-based), optionally only when 'condition' is truthy. Returns the top call frame, its local variables, and an optional 'expression' evaluated in that frame. The page is always resumed afterward.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID." },
        urlRegex: { type: "string", description: "Regex matching the script URL, e.g. \"app\\\\.js\"." },
        lineNumber: { type: "number", description: "0-based line number for the breakpoint." },
        columnNumber: { type: "number", description: "Optional 0-based column." },
        condition: { type: "string", description: "Only break when this expression is truthy." },
        expression: { type: "string", description: "Expression to evaluate in the paused frame." },
        timeoutMs: { type: "number", description: "How long to wait for the breakpoint to hit (default 15000)." },
      },
      required: ["tabId", "urlRegex", "lineNumber"],
    },
  },
  {
    name: TOOL_NAMES.MACRO,
    description:
      "Record, replay, and schedule UI interaction macros. 'record_start' (tabId) injects a recorder that captures clicks, input changes, and navigations; 'record_stop' (tabId, name) saves them. 'replay' (name, tabId) re-runs the steps; 'schedule' (name, periodMinutes) replays on a recurring alarm in a background tab; 'list'/'get'/'delete'/'unschedule' manage macros.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["record_start", "record_stop", "list", "get", "delete", "replay", "schedule", "unschedule"],
          description: "Macro action.",
        },
        name: { type: "string", description: "Macro name (required for record_stop/get/delete/replay/schedule/unschedule)." },
        tabId: { type: "number", description: "Target tab (required for record_start/record_stop/replay)." },
        periodMinutes: { type: "number", description: "Replay interval in minutes for 'schedule' (>= 1)." },
      },
      required: ["action"],
    },
  },
];

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and configure the MCP server.
 *
 * The server registers all tool schemas and forwards tool/call requests
 * to the Chrome extension via WebSocket-first browser transport.
 *
 * @param browserTransport - Optional pre-configured browser transport (for testing).
 *   If not provided, the server will create one and attempt to connect.
 */
export async function createMcpServer(
  browserTransport?: BrowserTransport
): Promise<Server> {
  const server = new Server(
    { name: "chromeuse-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  const client = browserTransport ?? new WebSocketFirstTransport();
  const clientId = `chromeuse-mcp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  if (!browserTransport) await client.connect();

  // AI provider — null when CHROMEUSE_AI_API_KEY is not set
  const aiProvider = getAiProvider();
  const aiToolNames: ReadonlySet<string> = new Set(Object.values(AI_TOOL_NAMES));

  if (aiProvider) {
    console.error(
      `[chromeuse-mcp] AI tools enabled (model: ${aiProvider.config.model})`
    );
  }

  const closeServer = server.close.bind(server);
  let closing = false;
  server.close = async () => {
    if (closing) return;
    closing = true;
    try {
      await closeServer();
    } finally {
      await closeTransport(client);
    }
  };

  // ---------------------------------------------------------------------------
  // tools/list handler
  // ---------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: aiProvider
      ? [...TOOL_SCHEMAS, ...AI_TOOL_SCHEMAS]
      : TOOL_SCHEMAS,
  }));

  // ---------------------------------------------------------------------------
  // tools/call handler
  // ---------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // --- AI tool dispatch (handled locally, not forwarded to extension) ---
    if (aiToolNames.has(name) && aiProvider) {
      return handleAiTool(name, (args ?? {}) as Record<string, unknown>, {
        ai: aiProvider,
        browser: client,
        clientId,
      });
    }

    // Validate tool name
    const validToolNames = TOOL_SCHEMAS.map((t) => t.name);
    if (!validToolNames.includes(name)) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // Ensure transport resources are started and a browser connection is available.
    if (!client.connected) {
      try {
        await client.connect();
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to connect to Chrome extension: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Forward the tool call to the extension via native host
    try {
      const result = await client.sendToolRequest(
        name,
        (args ?? {}) as Record<string, unknown>,
        undefined,
        { clientId }
      );
      return toMcpToolResult(result);
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool execution failed: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Get the list of tool schemas (useful for testing / introspection).
 */
export function getToolSchemas(): readonly Tool[] {
  return TOOL_SCHEMAS;
}

async function closeTransport(transport: BrowserTransport): Promise<void> {
  const closable = transport as ClosableTransport;
  if (typeof closable.close === "function") {
    await closable.close();
  } else {
    transport.disconnect();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toMcpToolResult(result: ToolRequestResult): CallToolResult & Record<string, unknown> {
  return {
    ...result,
    content: result.content.map(toMcpContentBlock),
  };
}

function toMcpContentBlock(content: unknown): McpContentBlock {
  if (isExtensionImageContent(content)) {
    return {
      type: "image",
      data: content.source.data,
      mimeType: content.source.media_type,
    };
  }

  return content as McpContentBlock;
}

function isExtensionImageContent(content: unknown): content is {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly media_type: string;
    readonly data: string;
  };
} {
  if (!isRecord(content) || content.type !== "image") return false;
  if (!isRecord(content.source)) return false;

  return (
    content.source.type === "base64" &&
    typeof content.source.media_type === "string" &&
    typeof content.source.data === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
