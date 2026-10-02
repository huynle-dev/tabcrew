/**
 * tabs_create tool - opens a new browser tab and adds it to the
 * session's "ChromeUse" tab group.
 *
 * Args:
 *   url (string, optional): URL to open. Defaults to chrome://newtab.
 *   active (boolean, optional): Whether to focus the new tab. Defaults to true.
 */

import type {
  ToolHandler,
  ToolResult,
  ToolContext,
} from "../../types/messages.js";
import { recordAutomationTab } from "../sidePanelHandler.js";
import { tabGroupManager } from "../tabGroups.js";

const GROUP_MOVE_TIMEOUT_MS = 1_000;
const GROUP_MOVE_POLL_MS = 10;

async function waitForTabWindow(
  tabId: number,
  windowId: number,
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + GROUP_MOVE_TIMEOUT_MS;

  while (true) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === windowId) return tab;

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for tab ${tabId} to move to window ${windowId}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, GROUP_MOVE_POLL_MS));
  }
}

export class TabsCreateTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const url = typeof args.url === "string" ? args.url : undefined;
      const active = typeof args.active === "boolean" ? args.active : true;

      const createProps: chrome.tabs.CreateProperties = { active };
      if (url) {
        createProps.url = url;
      }

      const tab = await chrome.tabs.create(createProps);

      if (tab.id === undefined) {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: "Failed to create tab: no tab ID returned",
            },
          ],
        };
      }

      recordAutomationTab(tab);

      // Add to ChromeUse tab group
      let groupId: number | undefined;
      try {
        groupId = await tabGroupManager.addTabToGroup(
          tab.id,
          context.sessionScope,
        );
      } catch {
        // Tab grouping is best-effort; don't fail the tool if it errors
      }

      let resultTab = tab;
      if (groupId !== undefined) {
        const group = await chrome.tabGroups.get(groupId);
        resultTab = await waitForTabWindow(tab.id, group.windowId);
      }

      if (active && groupId !== undefined) {
        await chrome.windows.update(resultTab.windowId, { focused: true });
        resultTab = {
          ...resultTab,
          ...(await chrome.tabs.update(tab.id, { active: true })),
        };
      }

      const result = {
        tabId: tab.id,
        url: resultTab.url ?? resultTab.pendingUrl ?? url ?? "chrome://newtab",
        windowId: resultTab.windowId,
        active: resultTab.active,
        groupId: groupId ?? null,
      };

      return {
        success: true,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `Failed to create tab: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}
