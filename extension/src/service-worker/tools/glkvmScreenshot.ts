import type {
  ContentBlock,
  ToolContext,
  ToolHandler,
  ToolResult,
} from "../../types/messages.js";
import { captureGlkvmFrame } from "./glkvmFrame.js";

function jsonText(value: Record<string, unknown>): ContentBlock {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

export class GlkvmScreenshotTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    try {
      if ("tabId" in args) {
        throw new Error(
          "glkvm_screenshot does not accept browser tabId. Use target so the service worker can resolve an OpenCode-owned GLKVM tab.",
        );
      }

      const target = typeof args.target === "string" ? args.target : undefined;
      const frame = await captureGlkvmFrame(target ? { target } : undefined);

      const metadata: Record<string, unknown> = {
        tabId: frame.tabId,
        mimeType: "image/jpeg",
        hash: frame.hash,
      };
      if (frame.width !== undefined) metadata.width = frame.width;
      if (frame.height !== undefined) metadata.height = frame.height;

      return {
        success: true,
        content: [
          { type: "image", data: frame.data, mimeType: "image/jpeg" },
          jsonText(metadata),
        ],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          jsonText({
            errorType: "capture_error",
            error: error instanceof Error ? error.message : String(error),
          }),
        ],
      };
    }
  }
}
