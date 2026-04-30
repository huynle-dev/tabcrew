import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
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
      if (tab.id === undefined) throw new Error("Chrome returned no tab ID");

      const groupId = await tabGroupManager.addTabToGroup(
        tab.id,
        context.sessionScope,
      );

      return json(true, {
        tabId: tab.id,
        groupId,
        tab: {
          tabId: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? tab.pendingUrl ?? url,
        },
        status: {
          glkvm: true,
          owned: true,
        },
      });
    } catch (error) {
      return json(false, {
        errorType: "glkvm_open_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
