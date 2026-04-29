import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
import { getVideoMetadata } from "../glkvmTab.js";
import { captureGlkvmFrame, type GlkvmFrame } from "./glkvmFrame.js";
import { encodeKeyEvent } from "./kvmHidEncoder.js";
import { buildKeySteps, buildMouseInputPlan, buildTextFallbackSteps, frameSize, type KeyAction, type MouseAction, type MouseInputPlan } from "./kvmInputHidSteps.js";
import { cleanupSession, connect, send, type CleanupOutcome, type GlkvmSession } from "./kvmHidTransport.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 1;
const MAX_POLL_INTERVAL_MS = 5_000;

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

function frameMetadata(frame: GlkvmFrame): Record<string, unknown> {
  return { tabId: frame.tabId, hash: frame.hash, ...(frame.width !== undefined ? { width: frame.width } : {}), ...(frame.height !== undefined ? { height: frame.height } : {}) };
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

function stepErrorLog(index: number, action: unknown, startedAt: number, error: unknown): SequenceLogEntry {
  return { index, action: typeof action === "string" ? action : String(action), status: "error", durationMs: elapsedSince(startedAt), error: error instanceof Error ? error.message : String(error) };
}

async function sendPacketsInOrder(session: GlkvmSession, packets: Uint8Array[]): Promise<void> {
  for (const packet of packets) await send({ session, packets: [packet] });
}

async function waitForFrameChange(tabId: number, step: Record<string, unknown>): Promise<{ log: SequenceLogEntry; frame: GlkvmFrame }> {
  const timeoutMs = clampNumber(step.timeout, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const pollIntervalMs = clampNumber(step.pollInterval, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const initialFrame = await captureGlkvmFrame({ tabId });
  let currentFrame = initialFrame;
  let polls = 0;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
    polls += 1;
    currentFrame = await captureGlkvmFrame({ tabId });
    if (currentFrame.hash !== initialFrame.hash) return { frame: currentFrame, log: { action: "wait", status: "ok", changed: true, timedOut: false, tabId: currentFrame.tabId, initialHash: initialFrame.hash, currentHash: currentFrame.hash, polls, durationMs: elapsedSince(startedAt), timeoutMs, pollIntervalMs } };
  }
  return { frame: currentFrame, log: { action: "wait", status: "timeout", changed: false, timedOut: true, reason: "timeout", tabId: currentFrame.tabId, initialHash: initialFrame.hash, currentHash: currentFrame.hash, polls, durationMs: elapsedSince(startedAt), timeoutMs, pollIntervalMs } };
}

async function buildMousePlan(tabId: number, step: Record<string, unknown>, action: MouseAction): Promise<MouseInputPlan> {
  if (action === "scroll") {
    const direction = step.direction === "up" ? "up" : step.direction === "down" ? "down" : undefined;
    if (!direction) throw new Error('The "direction" argument is required for GLKVM sequence scroll step');
    const amount = step.amount === undefined ? 1 : requiredNumber(step, "amount");
    return buildMouseInputPlan({ action, direction, amount });
  }
  const size = frameSize(await getVideoMetadata(tabId));
  if (action === "drag") return buildMouseInputPlan({ action, start: { x: requiredNumber(step, "startX"), y: requiredNumber(step, "startY") }, end: { x: requiredNumber(step, "endX"), y: requiredNumber(step, "endY") }, size, button: step.button });
  return buildMouseInputPlan({ action, point: { x: requiredNumber(step, "x"), y: requiredNumber(step, "y") }, size, button: step.button });
}

function sessionMetadata(session: GlkvmSession): Record<string, unknown> {
  return { tabId: session.tabId, sessionId: session.sessionId, createdAt: session.createdAt };
}

export class GlkvmSequenceTool implements ToolHandler {
  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
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
      for (let index = 0; index < args.steps.length; index += 1) {
        const rawStep = args.steps[index];
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
            const plan = await buildMousePlan(tabId, step, maybeMouseAction);
            await sendPacketsInOrder(await ensureSession(), plan.packets);
            log.push({ index, ...plan.response, status: "ok", durationMs: elapsedSince(stepStartedAt), sent: plan.packets.length });
            continue;
          }
          if (action === "wait") {
            const wait = await waitForFrameChange(tabId, step);
            finalFrame = wait.frame;
            log.push({ index, ...wait.log });
            if (wait.log.timedOut) throw new SequenceWaitTimeout(index, wait.log.timeoutMs as number);
            continue;
          }
          if (action === "capture") {
            finalFrame = await captureGlkvmFrame({ tabId });
            log.push({ index, action, status: "ok", durationMs: elapsedSince(stepStartedAt), frame: frameMetadata(finalFrame) });
            continue;
          }
          throw new Error(`Unsupported GLKVM sequence action: ${String(action)}`);
        } catch (error) {
          if (!(error instanceof SequenceWaitTimeout)) log.push(stepErrorLog(index, action, stepStartedAt, error));
          throw error;
        }
      }
      cleanup = session ? await cleanupSession(session, { releaseAll: true }) : undefined;
      return json(true, { completed: true, tabId, ...(session ? { session: sessionMetadata(session) } : {}), log, cleanup: formatCleanup(cleanup), finalFrame: finalFrame ? frameMetadata(finalFrame) : undefined, elapsedMs: elapsedSince(sequenceStartedAt) });
    } catch (error) {
      cleanup = session ? await cleanupSession(session, { releaseAll: true }) : undefined;
      return json(false, { completed: false, errorType: error instanceof SequenceWaitTimeout ? "sequence_wait_timeout" : "sequence_error", error: error instanceof Error ? error.message : String(error), tabId, ...(session ? { session: sessionMetadata(session) } : {}), cleanup: formatCleanup(cleanup), log, finalFrame: finalFrame ? frameMetadata(finalFrame) : undefined, elapsedMs: elapsedSince(sequenceStartedAt) });
    }
  }
}
