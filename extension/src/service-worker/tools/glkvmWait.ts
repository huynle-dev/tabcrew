import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "../../types/messages.js";
import { requireOwnedGlkvmTabForDirectControl } from "../glkvmTab.js";
import { captureGlkvmFrame, formatGlkvmFrameMetadata } from "./glkvmFrame.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 5_000;

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GlkvmWaitTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const validationOptions = {
        ...("tabId" in args ? { tabId: args.tabId } : {}),
        ...(typeof args.target === "string" ? { target: args.target } : {}),
      };
      const validated = await requireOwnedGlkvmTabForDirectControl(
        validationOptions,
        context.sessionScope,
      );
      const timeoutMs = clampNumber(
        args.timeout,
        DEFAULT_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      const pollIntervalMs = clampNumber(
        args.pollInterval,
        DEFAULT_POLL_INTERVAL_MS,
        MIN_POLL_INTERVAL_MS,
        MAX_POLL_INTERVAL_MS,
      );

      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      const captureOptions = {
        tabId: validated.tabId,
        sessionScope: context.sessionScope,
      };
      const initialFrame = await captureGlkvmFrame(captureOptions);
      let currentFrame = initialFrame;
      let polls = 0;

      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
        polls += 1;

        currentFrame = await captureGlkvmFrame(captureOptions);
        if (currentFrame.hash !== initialFrame.hash) {
          return this.json(true, {
            changed: true,
            timedOut: false,
            tabId: currentFrame.tabId,
            initialHash: initialFrame.hash,
            currentHash: currentFrame.hash,
            initialFrame: formatGlkvmFrameMetadata(initialFrame),
            currentFrame: formatGlkvmFrameMetadata(currentFrame),
            polls,
            elapsedMs: Date.now() - startedAt,
          });
        }
      }

      return this.json(true, {
        changed: false,
        timedOut: true,
        reason: "timeout",
        tabId: currentFrame.tabId,
        initialHash: initialFrame.hash,
        currentHash: currentFrame.hash,
        initialFrame: formatGlkvmFrameMetadata(initialFrame),
        currentFrame: formatGlkvmFrameMetadata(currentFrame),
        polls,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
        pollIntervalMs,
      });
    } catch (error) {
      return this.json(false, {
        changed: false,
        timedOut: false,
        errorType: "capture_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private json(success: boolean, value: Record<string, unknown>): ToolResult {
    return {
      success,
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
  }
}
