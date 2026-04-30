import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
import { waitForGlkvmOpenAttachReadiness } from "../glkvmTab.js";
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

function isPotentialGlkvmTab(tab: chrome.tabs.Tab): boolean {
  const url = tab.url ?? tab.pendingUrl ?? "";
  const title = tab.title ?? "";
  const hasGlkvmUrl = /#\//.test(url);
  const hasGlkvmTitle = title.includes("GLKVM");

  return (
    isGlkvmTab(tab) ||
    (hasGlkvmUrl && title.length === 0) ||
    (hasGlkvmTitle && url.length === 0)
  );
}

function normalizeDurationArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildReadinessStatus(readiness: Awaited<ReturnType<typeof waitForGlkvmOpenAttachReadiness>>) {
  return {
    glkvm: readiness.readiness.pagePresent,
    owned: true,
    readiness: readiness.readiness,
  };
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
      if (!isPotentialGlkvmTab(tab)) {
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

      const readiness = await waitForGlkvmOpenAttachReadiness(tabId, {
        timeoutMs: normalizeDurationArg(args.timeout),
        pollIntervalMs: normalizeDurationArg(args.pollInterval),
        fallbackUrl: tab.url ?? tab.pendingUrl ?? "",
      });

      if (!readiness.ready) {
        return json(false, {
          errorType: "glkvm_not_ready_timeout",
          error: `GLKVM tab ${tabId} did not become ready before timeout.`,
          tabId,
          groupId,
          tab: readiness.tab,
          video: readiness.video,
          status: buildReadinessStatus(readiness),
          timeoutMs: readiness.timeoutMs,
          elapsedMs: readiness.elapsedMs,
        });
      }

      return json(true, {
        tabId,
        groupId,
        tab: readiness.tab,
        video: readiness.video,
        status: buildReadinessStatus(readiness),
      });
    } catch (error) {
      return json(false, {
        errorType: "glkvm_attach_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
