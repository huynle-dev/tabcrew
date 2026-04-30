import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
import { tabGroupManager } from "../tabGroups.js";

function json(success: boolean, value: Record<string, unknown>): ToolResult {
  return {
    success,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function isGlkvmTab(tab: chrome.tabs.Tab): boolean {
  return /#\//.test(tab.url ?? "") && (tab.title ?? "").includes("GLKVM");
}

export class GlkvmAttachTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const rawTabId = args.tabId;
      if (typeof rawTabId !== "number" || !Number.isInteger(rawTabId)) {
        return json(false, {
          errorType: "invalid_tab_id",
          error: "glkvm_attach requires an integer tabId.",
        });
      }
      const tabId = rawTabId;

      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return json(false, {
          errorType: "tab_not_found",
          error: `Tab ${tabId} was not found. The tab may have been closed.`,
        });
      }
      if (!isGlkvmTab(tab)) {
        return json(false, {
          errorType: "not_glkvm_tab",
          error: `Tab ${tabId} is not a GLKVM tab. Expected a GLKVM page with a /#/ URL and title containing "GLKVM".`,
          tab: {
            tabId,
            title: tab.title ?? "",
            url: tab.url ?? tab.pendingUrl ?? "",
          },
        });
      }

      let groupId: number;
      try {
        groupId = await tabGroupManager.addTabToGroup(
          tabId,
          context.sessionScope,
        );
      } catch (groupError) {
        return json(false, {
          errorType: "group_api_error",
          error: `Failed to move tab ${tabId} into OpenCode group.`,
          groupError:
            groupError instanceof Error ? groupError.message : String(groupError),
          tab: {
            tabId,
            title: tab.title ?? "",
            url: tab.url ?? tab.pendingUrl ?? "",
          },
        });
      }

      return json(true, {
        tabId,
        groupId,
        tab: {
          tabId,
          title: tab.title ?? "",
          url: tab.url ?? tab.pendingUrl ?? "",
        },
        status: {
          glkvm: true,
          owned: true,
        },
      });
    } catch (error) {
      return json(false, {
        errorType: "glkvm_attach_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
