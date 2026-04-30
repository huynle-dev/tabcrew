import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
import { getVideoMetadata, validateOwnedGlkvmTab } from "../glkvmTab.js";
import { captureGlkvmFrame, formatGlkvmFrameMetadata, type GlkvmFrame } from "./glkvmFrame.js";
import { encodeKeyEvent } from "./kvmHidEncoder.js";
import { buildKeySteps, buildMouseInputPlan, buildTextFallbackSteps, frameSize, type KeyAction, type MouseAction, type MouseCoordinateSpace, type MouseInputPlan } from "./kvmInputHidSteps.js";
import { cleanupSession, connect, send, withTabHidOperationLock, type CleanupOutcome, type GlkvmReconnectDiagnostics, type GlkvmSession } from "./kvmHidTransport.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 1;
const MAX_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STABILITY_DURATION_MS = 1_000;

type SequenceLogEntry = Record<string, unknown>;

class SequenceWaitTimeout extends Error {
  constructor(stepIndex: number, timeoutMs: number) {
    super(`GLKVM sequence step ${stepIndex} wait timed out after ${timeoutMs}ms`);
    this.name = "SequenceWaitTimeout";
  }
}

function json(success: boolean, value: Record<string, unknown>): ToolResult {
  return { success, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function elapsedSince(startedAt: number): number { return Date.now() - startedAt; }
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function formatCleanup(outcome: CleanupOutcome | undefined): Record<string, unknown> | undefined {
  if (!outcome) return undefined;
  return { ok: outcome.ok, ...(outcome.cleanupFailed ? { cleanupFailed: outcome.cleanupFailed } : {}), ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}), ...(outcome.releasedKeys !== undefined ? { releasedKeys: outcome.releasedKeys } : {}), ...(outcome.releasedButtons !== undefined ? { releasedButtons: outcome.releasedButtons } : {}) };
}

function formatReconnect(reconnect: GlkvmReconnectDiagnostics | undefined): Record<string, unknown> | undefined {
  if (!reconnect) return undefined;
  return { requestedSessionId: reconnect.requestedSessionId, action: reconnect.action, ...(reconnect.readyState !== undefined ? { readyState: reconnect.readyState } : {}), ...(reconnect.error ? { error: reconnect.error } : {}), ...(reconnect.errorCode ? { errorCode: reconnect.errorCode } : {}), ...(reconnect.reconnected !== undefined ? { reconnected: reconnect.reconnected } : {}), ...(reconnect.replacementSessionId ? { replacementSessionId: reconnect.replacementSessionId } : {}) };
}

function errorReconnect(error: unknown): Record<string, unknown> | undefined {
  const reconnect = (error as { reconnect?: GlkvmReconnectDiagnostics } | undefined)?.reconnect;
  return formatReconnect(reconnect);
}

function frameMetadata(frame: GlkvmFrame, includeData = false): Record<string, unknown> {
  return { ...formatGlkvmFrameMetadata(frame), ...(includeData ? { data: frame.data } : {}) };
}

function finalFrameMetadata(log: SequenceLogEntry[], frame: GlkvmFrame): Record<string, unknown> {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (entry.action === "capture" && entry.status === "ok" && typeof entry.frame === "object" && entry.frame !== null) {
      return entry.frame as Record<string, unknown>;
    }
  }

  return frameMetadata(frame);
}

function requireTabId(args: Record<string, unknown>): number {
  if (typeof args.tabId !== "number" || !Number.isInteger(args.tabId)) throw new Error('The "tabId" argument is required for GLKVM sequence');
  return args.tabId;
}

function requiredString(step: Record<string, unknown>, name: string): string {
  const value = step[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`The "${name}" argument is required for GLKVM sequence ${String(step.action)} step`);
  return value;
}

function requiredNumber(step: Record<string, unknown>, name: string): number {
  const value = step[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`The "${name}" argument is required for GLKVM sequence ${String(step.action)} step`);
  return value;
}

function keyAction(value: unknown): KeyAction {
  if (value === undefined) return "press";
  if (value === "press" || value === "down" || value === "up" || value === "hotkey" || value === "chord") return value;
  throw new Error(`Unsupported GLKVM sequence keyAction: ${String(value)}`);
}

function mouseAction(value: unknown): MouseAction | undefined {
  if (value === "click" || value === "move" || value === "drag" || value === "scroll") return value;
  return undefined;
}

function coordinateSpace(value: unknown): MouseCoordinateSpace | undefined {
  if (value === undefined) return undefined;
  if (value === "glkvm_screenshot_pixels" || value === "intrinsic_remote_frame_pixels" || value === "normalized_remote_frame") return value;
  throw new Error(`Unsupported GLKVM sequence coordinateSpace: ${String(value)}`);
}

function frameId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error("GLKVM sequence frameId must be a non-empty string when provided");
}

function intrinsicFrameSize(video: {
  videoWidth: number;
  videoHeight: number;
  visible: boolean;
  displayRect: { width: number; height: number };
}): { width: number; height: number } {
  frameSize(video);
  return { width: video.videoWidth, height: video.videoHeight };
}

function mouseCoordinateSize(
  video: {
    videoWidth: number;
    videoHeight: number;
    visible: boolean;
    displayRect: { width: number; height: number };
  },
  space: MouseCoordinateSpace | undefined,
  cachedFrameId: string | undefined,
): { width: number; height: number } {
  if (space !== undefined || cachedFrameId !== undefined) return intrinsicFrameSize(video);
  return frameSize(video);
}

function stepErrorLog(index: number, action: unknown, startedAt: number, error: unknown): SequenceLogEntry {
  return { index, action: typeof action === "string" ? action : String(action), status: "error", durationMs: elapsedSince(startedAt), error: error instanceof Error ? error.message : String(error) };
}

async function sendPacketsInOrder(session: GlkvmSession, packets: Uint8Array[]): Promise<void> {
  for (const packet of packets) await send({ session, packets: [packet] });
}

async function waitForFrameChange(tabId: number, step: Record<string, unknown>, actionLabel: string, sessionScope?: string): Promise<{ log: SequenceLogEntry; frame: GlkvmFrame }> {
  const timeoutMs = clampNumber(step.timeout, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const pollIntervalMs = clampNumber(step.pollInterval, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const captureOptions = { tabId, sessionScope };
  const initialFrame = await captureGlkvmFrame(captureOptions);
  let currentFrame = initialFrame;
  let polls = 0;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
    polls += 1;
    currentFrame = await captureGlkvmFrame(captureOptions);
    if (currentFrame.hash !== initialFrame.hash) return { frame: currentFrame, log: { action: actionLabel, status: "ok", changed: true, timedOut: false, tabId: currentFrame.tabId, initialHash: initialFrame.hash, currentHash: currentFrame.hash, polls, durationMs: elapsedSince(startedAt), timeoutMs, pollIntervalMs } };
  }
  return { frame: currentFrame, log: { action: actionLabel, status: "timeout", changed: false, timedOut: true, reason: "timeout", tabId: currentFrame.tabId, initialHash: initialFrame.hash, currentHash: currentFrame.hash, polls, durationMs: elapsedSince(startedAt), timeoutMs, pollIntervalMs } };
}

async function waitForFrameStable(tabId: number, step: Record<string, unknown>, sessionScope?: string): Promise<{ log: SequenceLogEntry; frame: GlkvmFrame }> {
  const timeoutMs = clampNumber(step.timeout, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const pollIntervalMs = clampNumber(step.pollInterval, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  const stabilityDurationMs = clampNumber(step.stabilityDuration, DEFAULT_STABILITY_DURATION_MS, MIN_POLL_INTERVAL_MS, timeoutMs);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const captureOptions = { tabId, sessionScope };
  const initialFrame = await captureGlkvmFrame(captureOptions);
  let currentFrame = initialFrame;
  let stableSince = Date.now();
  let polls = 0;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
    polls += 1;
    const nextFrame = await captureGlkvmFrame(captureOptions);
    if (nextFrame.hash !== currentFrame.hash) stableSince = Date.now();
    currentFrame = nextFrame;
    if (Date.now() - stableSince >= stabilityDurationMs) return { frame: currentFrame, log: { action: "waitFrameStable", status: "ok", stable: true, timedOut: false, tabId: currentFrame.tabId, initialHash: initialFrame.hash, currentHash: currentFrame.hash, polls, durationMs: elapsedSince(startedAt), timeoutMs, pollIntervalMs, stabilityDurationMs } };
  }
  return { frame: currentFrame, log: { action: "waitFrameStable", status: "timeout", stable: false, timedOut: true, reason: "timeout", tabId: currentFrame.tabId, initialHash: initialFrame.hash, currentHash: currentFrame.hash, polls, durationMs: elapsedSince(startedAt), timeoutMs, pollIntervalMs, stabilityDurationMs } };
}

async function buildMousePlan(tabId: number, step: Record<string, unknown>, action: MouseAction): Promise<MouseInputPlan> {
  if (action === "scroll") {
    const direction = step.direction === "up" ? "up" : step.direction === "down" ? "down" : undefined;
    if (!direction) throw new Error('The "direction" argument is required for GLKVM sequence scroll step');
    const amount = step.amount === undefined ? 1 : requiredNumber(step, "amount");
    return buildMouseInputPlan({ action, direction, amount });
  }
  const video = await getVideoMetadata(tabId);
  const space = coordinateSpace(step.coordinateSpace);
  const cachedFrameId = frameId(step.frameId);
  const size = mouseCoordinateSize(video, space, cachedFrameId);
  if (action === "drag") return buildMouseInputPlan({ action, start: { x: requiredNumber(step, "startX"), y: requiredNumber(step, "startY") }, end: { x: requiredNumber(step, "endX"), y: requiredNumber(step, "endY") }, size, coordinateSpace: space, frameId: cachedFrameId, button: step.button });
  return buildMouseInputPlan({ action, point: { x: requiredNumber(step, "x"), y: requiredNumber(step, "y") }, size, coordinateSpace: space, frameId: cachedFrameId, button: step.button });
}

function sessionMetadata(session: GlkvmSession | undefined, reconnect?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!session) return reconnect ? { reconnect } : undefined;
  return { tabId: session.tabId, sessionId: session.sessionId, createdAt: session.createdAt, ...(formatReconnect(session.reconnect) ? { reconnect: formatReconnect(session.reconnect) } : {}) };
}

export class GlkvmSequenceTool implements ToolHandler {
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const sequenceStartedAt = Date.now();
    const log: SequenceLogEntry[] = [];
    let session: GlkvmSession | undefined;
    let cleanup: CleanupOutcome | undefined;
    let tabId: number | undefined;
    let finalFrame: GlkvmFrame | undefined;
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
    const ensureSession = async (): Promise<GlkvmSession> => {
      if (tabId === undefined) throw new Error('The "tabId" argument is required for GLKVM sequence');
      session ??= await connect({ tabId, ...(sessionId ? { sessionId } : {}) });
      return session;
    };
    try {
      tabId = requireTabId(args);
      if (!Array.isArray(args.steps)) throw new Error('The "steps" argument is required for GLKVM sequence');
      const sequenceTabId = tabId;
      const steps = args.steps;
      await validateOwnedGlkvmTab(tabId, context.sessionScope);
      return await withTabHidOperationLock(sequenceTabId, async () => {
        try {
          for (let index = 0; index < steps.length; index += 1) {
            const rawStep = steps[index];
            if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) throw new Error(`GLKVM sequence step ${index} must be an object`);
            const step = rawStep as Record<string, unknown>;
            const action = step.action;
            const stepStartedAt = Date.now();
            try {
              if (action === "key") {
                const key = requiredString(step, "key");
                const actionType = keyAction(step.keyAction);
                const packets = buildKeySteps(key, actionType).map((keyStep) => encodeKeyEvent(keyStep.key, keyStep.down));
                await sendPacketsInOrder(await ensureSession(), packets);
                log.push({ index, action, status: "ok", durationMs: elapsedSince(stepStartedAt), key, keyAction: actionType, sent: packets.length });
                continue;
              }
              if (action === "type") {
                const text = requiredString(step, "text");
                const packets = buildTextFallbackSteps(text).map((keyStep) => encodeKeyEvent(keyStep.key, keyStep.down));
                await sendPacketsInOrder(await ensureSession(), packets);
                log.push({ index, action, status: "ok", durationMs: elapsedSince(stepStartedAt), method: "key_fallback", textLength: text.length, sent: packets.length });
                continue;
              }
              const maybeMouseAction = mouseAction(action);
              if (maybeMouseAction) {
                const plan = await buildMousePlan(sequenceTabId, step, maybeMouseAction);
                await sendPacketsInOrder(await ensureSession(), plan.packets);
                log.push({ index, ...plan.response, status: "ok", durationMs: elapsedSince(stepStartedAt), sent: plan.packets.length });
                continue;
              }
              if (action === "wait" || action === "waitFrameChange") {
                const wait = await waitForFrameChange(sequenceTabId, step, action, context.sessionScope);
                finalFrame = wait.frame;
                log.push({ index, ...wait.log });
                if (wait.log.timedOut) throw new SequenceWaitTimeout(index, wait.log.timeoutMs as number);
                continue;
              }
              if (action === "waitFrameStable") {
                const wait = await waitForFrameStable(sequenceTabId, step, context.sessionScope);
                finalFrame = wait.frame;
                log.push({ index, ...wait.log });
                if (wait.log.timedOut) throw new SequenceWaitTimeout(index, wait.log.timeoutMs as number);
                continue;
              }
              if (action === "capture") {
                const includeData = step.includeData === true;
                finalFrame = await captureGlkvmFrame({ tabId: sequenceTabId, sessionScope: context.sessionScope });
                log.push({ index, action, status: "ok", durationMs: elapsedSince(stepStartedAt), frame: frameMetadata(finalFrame, includeData) });
                continue;
              }
              throw new Error(`Unsupported GLKVM sequence action: ${String(action)}`);
            } catch (error) {
              if (!(error instanceof SequenceWaitTimeout)) log.push(stepErrorLog(index, action, stepStartedAt, error));
              throw error;
            }
          }
          cleanup = session ? await cleanupSession(session, { releaseAll: true }) : undefined;
          return json(true, { completed: true, tabId, ...(sessionMetadata(session) ? { session: sessionMetadata(session) } : {}), log, cleanup: formatCleanup(cleanup), finalFrame: finalFrame ? finalFrameMetadata(log, finalFrame) : undefined, elapsedMs: elapsedSince(sequenceStartedAt) });
        } catch (error) {
          cleanup = session ? await cleanupSession(session, { releaseAll: true }) : undefined;
          const reconnect = errorReconnect(error);
          const metadata = sessionMetadata(session, reconnect);
          return json(false, { completed: false, errorType: error instanceof SequenceWaitTimeout ? "sequence_wait_timeout" : "sequence_error", error: error instanceof Error ? error.message : String(error), tabId, ...(metadata ? { session: metadata } : {}), cleanup: formatCleanup(cleanup), log, finalFrame: finalFrame ? frameMetadata(finalFrame) : undefined, elapsedMs: elapsedSince(sequenceStartedAt) });
        }
      });
    } catch (error) {
      const reconnect = errorReconnect(error);
      const metadata = sessionMetadata(session, reconnect);
      return json(false, { completed: false, errorType: error instanceof SequenceWaitTimeout ? "sequence_wait_timeout" : "sequence_error", error: error instanceof Error ? error.message : String(error), tabId, ...(metadata ? { session: metadata } : {}), cleanup: formatCleanup(cleanup), log, finalFrame: finalFrame ? frameMetadata(finalFrame) : undefined, elapsedMs: elapsedSince(sequenceStartedAt) });
    }
  }
}
