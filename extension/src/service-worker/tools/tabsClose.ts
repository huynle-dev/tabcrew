/**
 * tabs_close tool - closes one or more browser tabs by their IDs.
 *
 * Args:
 *   tabId (number): Single tab ID to close.
 *   tabIds (number[]): Array of tab IDs to close. Takes precedence over tabId.
 */

import type {
  ToolHandler,
  ToolResult,
  ToolContext,
} from "../../types/messages.js";
import { cleanupSessionsForTab } from "./kvmHidTransport.js";

export class TabsCloseTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    let hidCleanup: Awaited<ReturnType<typeof cleanupSessionsForTab>> = [];
    try {
      let ids: number[];

      if (Array.isArray(args.tabIds)) {
        ids = args.tabIds.filter((id): id is number => typeof id === "number");
      } else if (typeof args.tabId === "number") {
        ids = [args.tabId];
      } else {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: "Missing required argument: tabId (number) or tabIds (number[])",
            },
          ],
        };
      }

      if (ids.length === 0) {
        return {
          success: false,
          content: [{ type: "text", text: "No valid tab IDs provided" }],
        };
      }

      hidCleanup = (
        await Promise.all(
          ids.map((id) =>
            cleanupSessionsForTab(id, { releaseAll: true, close: true }),
          ),
        )
      ).flat();

      await chrome.tabs.remove(ids);

      return {
        success: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                closed: ids,
                count: ids.length,
                ...(hidCleanup.length > 0 ? { hidCleanup } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                errorType: "tab_close_error",
                error: `Failed to close tab(s): ${error instanceof Error ? error.message : String(error)}`,
                ...(hidCleanup.length > 0 ? { hidCleanup } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  }
}
