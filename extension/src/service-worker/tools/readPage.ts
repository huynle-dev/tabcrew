/**
 * read_page tool - reads the current page content in one of several formats.
 *
 * Uses chrome.tabs.sendMessage to communicate with the accessibility tree
 * content script. Falls back to programmatic injection via
 * chrome.scripting.executeScript when the content script isn't loaded.
 *
 * Formats:
 *   - "accessibility" (default): Compact a11y tree with refs, roles, names, states
 *   - "text": Plain text content only (no refs or roles)
 *   - "html": Raw outerHTML of the page body (via executeScript)
 *
 * Args:
 *   tabId (number, required): The tab to read content from.
 *   format (string, optional): Output format. Default: "accessibility".
 */

import type {
  ToolHandler,
  ToolResult,
  ToolContext,
} from "../../types/messages.js";

type ReadPageFormat = "accessibility" | "text" | "html";

const VALID_FORMATS: ReadonlySet<string> = new Set([
  "accessibility",
  "text",
  "html",
]);

/** Maximum HTML size to return (chars). Truncate beyond this. */
const MAX_HTML_SIZE = 200_000;

export class ReadPageTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    try {
      // Validate tabId
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      if (tabId === undefined) {
        return {
          success: false,
          content: [
            { type: "text", text: "Missing required argument: tabId (number)" },
          ],
        };
      }

      // Validate format
      const formatArg =
        typeof args.format === "string" ? args.format : "accessibility";
      if (!VALID_FORMATS.has(formatArg)) {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: `Invalid format: "${formatArg}". Must be one of: accessibility, text, html`,
            },
          ],
        };
      }
      const format = formatArg as ReadPageFormat;

      // Verify tab exists
      try {
        await chrome.tabs.get(tabId);
      } catch {
        return {
          success: false,
          content: [{ type: "text", text: `Tab ${tabId} not found` }],
        };
      }

      // Handle HTML format separately - no content script needed
      if (format === "html") {
        return this.getHtml(tabId);
      }

      // For accessibility and text formats, send message to content script
      return this.getFromContentScript(tabId, format);
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `Failed to read page: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  /**
   * Get page content from the accessibility tree content script.
   * The content script is registered in manifest.json and should be
   * loaded on all pages. Falls back to programmatic injection if
   * the content script isn't available.
   */
  private async getFromContentScript(
    tabId: number,
    format: ReadPageFormat,
  ): Promise<ToolResult> {
    try {
      // Try sending message to the content script
      const response = (await chrome.tabs.sendMessage(tabId, {
        action: "get_accessibility_tree",
        format,
      })) as { success: boolean; data?: string; error?: string };

      if (!response || !response.success) {
        // Content script may not be loaded - try programmatic injection
        return this.injectAndRead(tabId, format);
      }

      const data = response.data ?? "";
      if (!data) {
        return {
          success: true,
          content: [{ type: "text", text: "(empty page)" }],
        };
      }

      return {
        success: true,
        content: [{ type: "text", text: data }],
      };
    } catch {
      // Content script not available, inject programmatically
      return this.injectAndRead(tabId, format);
    }
  }

  /**
   * Fallback: programmatically inject the content script and read the tree.
   * Handles pages where the content script wasn't loaded at page load
   * (e.g., tabs opened before the extension was installed).
   */
  private async injectAndRead(
    tabId: number,
    format: ReadPageFormat,
  ): Promise<ToolResult> {
    try {
      // Inject the content script
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["dist/content-scripts/accessibilityTree.js"],
      });

      // Small delay to let the script initialize
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now send the message
      const response = (await chrome.tabs.sendMessage(tabId, {
        action: "get_accessibility_tree",
        format,
      })) as { success: boolean; data?: string; error?: string };

      if (!response || !response.success) {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: `Failed to build accessibility tree: ${response?.error ?? "unknown error"}`,
            },
          ],
        };
      }

      return {
        success: true,
        content: [{ type: "text", text: response.data ?? "(empty page)" }],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `Failed to inject content script: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  /**
   * Get raw HTML of the page body using chrome.scripting.executeScript.
   * Truncates to MAX_HTML_SIZE to prevent excessively large responses.
   */
  private async getHtml(tabId: number): Promise<ToolResult> {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.body?.outerHTML ?? "",
      });

      let html = (result?.result as string) ?? "";
      let truncated = false;
      const originalLength = html.length;

      if (html.length > MAX_HTML_SIZE) {
        html = html.slice(0, MAX_HTML_SIZE);
        truncated = true;
      }

      if (!html) {
        return {
          success: true,
          content: [{ type: "text", text: "(empty page)" }],
        };
      }

      const suffix = truncated
        ? `\n\n[Truncated: showing first ${MAX_HTML_SIZE.toLocaleString()} of ${originalLength.toLocaleString()} characters]`
        : "";

      return {
        success: true,
        content: [{ type: "text", text: html + suffix }],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `Failed to read HTML: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}
