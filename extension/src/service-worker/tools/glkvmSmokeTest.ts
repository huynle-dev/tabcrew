import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
import {
  getVideoMetadata,
  requireOwnedGlkvmTabForDirectControl,
  type GlkvmVideoMetadata,
} from "../glkvmTab.js";
import {
  captureGlkvmFrame,
  type GlkvmFrame,
  type GlkvmFrameCropOptions,
} from "./glkvmFrame.js";
import { GlkvmAttachTool } from "./glkvmAttach.js";
import { GlkvmOpenTool } from "./glkvmOpen.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STABILITY_DURATION_MS = 1_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 1;
const MAX_POLL_INTERVAL_MS = 5_000;
const MIN_STABILITY_DURATION_MS = 1;
const MAX_STABILITY_DURATION_MS = 10_000;

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

function streamStatus(video: GlkvmVideoMetadata): { available: boolean; status: string } {
  if (!video.visible) return { available: false, status: "hidden" };
  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    return { available: false, status: "no_frame" };
  }
  return { available: true, status: "ready" };
}

function parseCalibration(args: Record<string, unknown>): {
  requested: boolean;
  approved: boolean;
} {
  const raw = args.calibration;
  if (raw === true) return { requested: true, approved: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { requested: false, approved: false };
  }

  const calibration = raw as Record<string, unknown>;
  return {
    requested: calibration.enabled === true,
    approved: calibration.approved === true,
  };
}

function defaultCropFor(video: GlkvmVideoMetadata): GlkvmFrameCropOptions {
  const width = Math.max(1, Math.min(320, video.videoWidth));
  const height = Math.max(1, Math.min(180, video.videoHeight));
  return {
    x: Math.max(0, Math.floor((video.videoWidth - width) / 2)),
    y: Math.max(0, Math.floor((video.videoHeight - height) / 2)),
    width,
    height,
  };
}

function summarizeFrame(frame: GlkvmFrame): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    tabId: frame.tabId,
    hash: frame.hash,
  };
  if (frame.hashAlgorithm !== undefined) summary.hashAlgorithm = frame.hashAlgorithm;
  if (frame.width !== undefined) summary.width = frame.width;
  if (frame.height !== undefined) summary.height = frame.height;
  if (frame.source !== undefined) summary.source = frame.source;
  if (frame.crop !== undefined) {
    summary.crop = frame.crop;
    summary.region = frame.crop;
  }
  if (frame.output !== undefined) summary.output = frame.output;
  return summary;
}

function parseToolJsonResult(result: ToolResult, step: "open" | "attach"): Record<string, unknown> {
  const first = result.content[0];
  if (first.type !== "text") {
    throw new Error(`GLKVM smoke ${step} step returned non-text content.`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    throw new Error(`GLKVM smoke ${step} step returned invalid JSON.`);
  }

  if (!result.success) {
    throw new Error(
      `GLKVM smoke ${step} step failed: ${typeof payload.error === "string" ? payload.error : first.text}`,
    );
  }

  return payload;
}

function requireStepTabId(payload: Record<string, unknown>, step: "open" | "attach"): number {
  if (typeof payload.tabId !== "number" || !Number.isInteger(payload.tabId)) {
    throw new Error(`GLKVM smoke ${step} step did not return an integer tabId.`);
  }
  return payload.tabId;
}

async function resolveSmokeTarget(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{
  validationOptions: Record<string, unknown>;
  openOrAttach: Record<string, unknown>;
}> {
  if (typeof args.url === "string" && args.url.trim().length > 0) {
    const openResult = await new GlkvmOpenTool().execute(
      {
        url: args.url,
        ...(typeof args.active === "boolean" ? { active: args.active } : {}),
      },
      context,
    );
    const payload = parseToolJsonResult(openResult, "open");
    return {
      validationOptions: { tabId: requireStepTabId(payload, "open") },
      openOrAttach: { mode: "open", result: payload },
    };
  }

  if (args.attach === true) {
    const attachResult = await new GlkvmAttachTool().execute(
      { tabId: args.tabId },
      context,
    );
    const payload = parseToolJsonResult(attachResult, "attach");
    return {
      validationOptions: { tabId: requireStepTabId(payload, "attach") },
      openOrAttach: { mode: "attach", result: payload },
    };
  }

  return {
    validationOptions: {
      ...("tabId" in args ? { tabId: args.tabId } : {}),
      ...(typeof args.target === "string" ? { target: args.target } : {}),
    },
    openOrAttach: { mode: "owned_tab" },
  };
}

async function waitForStableFrame(options: {
  tabId: number;
  sessionScope?: string;
  timeoutMs: number;
  pollIntervalMs: number;
  stabilityDurationMs: number;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let polls = 0;
  const initialFrame = await captureGlkvmFrame({
    tabId: options.tabId,
    sessionScope: options.sessionScope,
  });
  let stableHash = initialFrame.hash;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(options.pollIntervalMs, Math.max(0, remaining)));
    polls += 1;

    const currentFrame = await captureGlkvmFrame({
      tabId: options.tabId,
      sessionScope: options.sessionScope,
    });
    if (currentFrame.hash !== stableHash) {
      stableHash = currentFrame.hash;
      stableSince = Date.now();
    }

    const stableForMs = Date.now() - stableSince;
    if (stableForMs >= options.stabilityDurationMs) {
      return {
        stable: true,
        timedOut: false,
        initialHash: initialFrame.hash,
        stableHash,
        polls,
        stableForMs,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        stabilityDurationMs: options.stabilityDurationMs,
      };
    }

    if (currentFrame.hash === stableHash && polls > 0 && options.pollIntervalMs >= options.stabilityDurationMs) {
      return {
        stable: true,
        timedOut: false,
        initialHash: initialFrame.hash,
        stableHash,
        polls,
        stableForMs: options.pollIntervalMs,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        stabilityDurationMs: options.stabilityDurationMs,
      };
    }
  }

  return {
    stable: false,
    timedOut: true,
    reason: "timeout",
    initialHash: initialFrame.hash,
    stableHash,
    polls,
    elapsedMs: Date.now() - startedAt,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    stabilityDurationMs: options.stabilityDurationMs,
  };
}

export class GlkvmSmokeTestTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const calibration = parseCalibration(args);
    if (calibration.requested && !calibration.approved) {
      return this.json(false, {
        ok: false,
        inputSent: false,
        errorType: "calibration_approval_required",
        error: "HID calibration requires calibration.approved: true and is never part of the default smoke path.",
        calibration: {
          requested: true,
          approved: false,
          status: "blocked",
        },
      });
    }

    try {
      const target = await resolveSmokeTarget(args, context);
      const validated = await requireOwnedGlkvmTabForDirectControl(
        target.validationOptions,
        context.sessionScope,
      );
      const video = await getVideoMetadata(validated.tabId);
      const fullFrame = await captureGlkvmFrame({
        tabId: validated.tabId,
        sessionScope: context.sessionScope,
      });
      const cropFrame = await captureGlkvmFrame({
        tabId: validated.tabId,
        sessionScope: context.sessionScope,
        crop: defaultCropFor(video),
      });
      const stableWait = await waitForStableFrame({
        tabId: validated.tabId,
        sessionScope: context.sessionScope,
        timeoutMs: clampNumber(args.timeout, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        pollIntervalMs: clampNumber(
          args.pollInterval,
          DEFAULT_POLL_INTERVAL_MS,
          MIN_POLL_INTERVAL_MS,
          MAX_POLL_INTERVAL_MS,
        ),
        stabilityDurationMs: clampNumber(
          args.stabilityDuration,
          DEFAULT_STABILITY_DURATION_MS,
          MIN_STABILITY_DURATION_MS,
          MAX_STABILITY_DURATION_MS,
        ),
      });

      return this.json(true, {
        ok: true,
        tabId: validated.tabId,
        inputSent: false,
        openOrAttach: target.openOrAttach,
        readiness: {
          tab: validated.tab,
          video,
          stream: streamStatus(video),
        },
        captures: {
          full: summarizeFrame(fullFrame),
          crop: summarizeFrame(cropFrame),
        },
        stableWait,
        calibration: calibration.requested
          ? {
              requested: true,
              approved: true,
              status: "approved_not_executed",
              reason: "Phase 1 smoke runner records explicit approval but does not execute HID calibration.",
            }
          : {
              requested: false,
              approved: false,
              status: "skipped",
              reason: "calibration_not_requested",
            },
      });
    } catch (error) {
      return this.json(false, {
        ok: false,
        inputSent: false,
        errorType: "smoke_test_error",
        error: error instanceof Error ? error.message : String(error),
        calibration: calibration.requested
          ? { requested: true, approved: true, status: "approved_not_executed" }
          : { requested: false, approved: false, status: "skipped" },
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
