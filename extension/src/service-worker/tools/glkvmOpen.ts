import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
import { waitForGlkvmOpenAttachReadiness } from "../glkvmTab.js";
import { tabGroupManager } from "../tabGroups.js";

function json(success: boolean, value: Record<string, unknown>): ToolResult {
  return {
    success,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function normalizeGlkvmUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
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

export class GlkvmOpenTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const url = normalizeGlkvmUrl(args.url);
      if (!url) {
        return json(false, {
          errorType: "invalid_url",
          error: "glkvm_open requires a valid http(s) GLKVM URL.",
        });
      }
      const active = typeof args.active === "boolean" ? args.active : true;

      const tab = await chrome.tabs.create({ url, active });
      if (tab.id === undefined) {
        return json(false, {
          errorType: "tab_not_found",
          error: "Chrome did not return a tab ID for the newly opened GLKVM tab.",
        });
      }

      let groupId: number;
      try {
        groupId = await tabGroupManager.addTabToGroup(
          tab.id,
          context.sessionScope,
        );
      } catch (groupError) {
        return json(false, {
          errorType: "group_api_error",
          error: `Failed to move tab ${tab.id} into OpenCode group.`,
          groupError:
            groupError instanceof Error ? groupError.message : String(groupError),
          tab: {
            tabId: tab.id,
            title: tab.title ?? "",
            url: tab.url ?? tab.pendingUrl ?? url,
          },
        });
      }

      const readiness = await waitForGlkvmOpenAttachReadiness(tab.id, {
        timeoutMs: normalizeDurationArg(args.timeout),
        pollIntervalMs: normalizeDurationArg(args.pollInterval),
        fallbackUrl: url,
      });

      if (!readiness.ready) {
        return json(false, {
          errorType: "glkvm_not_ready_timeout",
          error: `GLKVM tab ${tab.id} did not become ready before timeout.`,
          tabId: tab.id,
          groupId,
          tab: readiness.tab,
          video: readiness.video,
          status: buildReadinessStatus(readiness),
          timeoutMs: readiness.timeoutMs,
          elapsedMs: readiness.elapsedMs,
        });
      }

      return json(true, {
        tabId: tab.id,
        groupId,
        tab: readiness.tab,
        video: readiness.video,
        status: buildReadinessStatus(readiness),
      });
    } catch (error) {
      return json(false, {
        errorType: "glkvm_open_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
