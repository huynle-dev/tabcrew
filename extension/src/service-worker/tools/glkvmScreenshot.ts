import type {
  ContentBlock,
  ToolContext,
  ToolHandler,
  ToolResult,
} from "../../types/messages.js";
import { requireOwnedGlkvmTabForDirectControl } from "../glkvmTab.js";
import {
  captureGlkvmFrame,
  formatGlkvmFrameMetadata,
  type GlkvmFrame,
  type GlkvmFrameCropOptions,
} from "./glkvmFrame.js";

function jsonText(value: Record<string, unknown>): ContentBlock {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

function frameMetadata(frame: GlkvmFrame): Record<string, unknown> {
  return formatGlkvmFrameMetadata(frame, { mimeType: "image/jpeg" });
}

function optionalPositiveNumber(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive finite pixel dimension.`);
  }
  return value;
}

function optionalRegion(args: Record<string, unknown>): GlkvmFrameCropOptions | undefined {
  if (args.region === undefined) return undefined;
  if (!args.region || typeof args.region !== "object" || Array.isArray(args.region)) {
    throw new Error("Invalid region: expected an object with x, y, width, and height.");
  }

  const region = args.region as Record<string, unknown>;
  const names = ["x", "y", "width", "height"] as const;
  for (const name of names) {
    const value = region[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Invalid region.${name}: expected a finite number in intrinsic remote-frame pixels.`);
    }
  }

  if ((region.x as number) < 0 || (region.y as number) < 0) {
    throw new Error("Invalid region: x and y must be non-negative intrinsic remote-frame pixels.");
  }
  if (names.every((name) => region[name] === 0)) return undefined;
  if ((region.width as number) <= 0) {
    throw new Error("Invalid region.width: expected a positive intrinsic remote-frame pixel dimension.");
  }
  if ((region.height as number) <= 0) {
    throw new Error("Invalid region.height: expected a positive intrinsic remote-frame pixel dimension.");
  }

  return {
    x: region.x as number,
    y: region.y as number,
    width: region.width as number,
    height: region.height as number,
  };
}

export class GlkvmScreenshotTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const validated = await requireOwnedGlkvmTabForDirectControl(
        {
          ...("tabId" in args ? { tabId: args.tabId } : {}),
          ...(typeof args.target === "string" ? { target: args.target } : {}),
        },
        context.sessionScope,
      );
      const crop = optionalRegion(args);
      const maxWidth = optionalPositiveNumber(args, "maxWidth");
      const maxHeight = optionalPositiveNumber(args, "maxHeight");
      const frame = await captureGlkvmFrame({
        tabId: validated.tabId,
        sessionScope: context.sessionScope,
        ...(crop ? { crop } : {}),
        ...(maxWidth !== undefined ? { maxWidth } : {}),
        ...(maxHeight !== undefined ? { maxHeight } : {}),
      });

      const metadata = frameMetadata(frame);

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
