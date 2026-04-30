import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "../../types/messages.js";
import { getVideoMetadata, requireOwnedGlkvmTabForDirectControl } from "../glkvmTab.js";
import { encodeKeyEvent } from "./kvmHidEncoder.js";
import {
  buildKeySteps,
  buildMouseInputPlan,
  buildTextFallbackSteps,
  frameSize,
  type KeyAction,
  type KeyStep,
  type MouseAction,
  type MouseInputPlan,
} from "./kvmInputHidSteps.js";
import {
  cleanupSession,
  connect,
  pasteText,
  send,
  type CleanupOutcome,
  type GlkvmSession,
} from "./kvmHidTransport.js";

type FallbackMode = "keys" | "none";

const MAX_PASTE_TEXT_LENGTH = 4096;

export { resolveKvmdKeyName } from "./kvmInputHidSteps.js";

function getKeyAction(value: unknown): KeyAction {
  if (typeof value !== "string") return "press";
  if (
    value === "press"
    || value === "down"
    || value === "up"
    || value === "hotkey"
    || value === "chord"
  ) {
    return value;
  }
  throw new Error(`Unsupported keyAction: ${value}`);
}

function getFallbackMode(value: unknown): FallbackMode {
  if (typeof value !== "string") return "keys";
  if (value === "keys" || value === "none") return value;
  throw new Error(`Unsupported GLKVM type fallback: ${value}`);
}

function getRequiredNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `The "${name}" argument is required and must be a finite number`,
    );
  }
  return value;
}

function getMouseAction(value: unknown): MouseAction | undefined {
  if (
    value === "click"
    || value === "move"
    || value === "drag"
    || value === "scroll"
  ) {
    return value;
  }
  return undefined;
}

async function sendKeySteps(session: GlkvmSession, steps: KeyStep[]): Promise<void> {
  for (const step of steps) {
    await send({
      session,
      packets: [encodeKeyEvent(step.key, step.down)],
    });
  }
}

function formatCleanup(outcome: CleanupOutcome | undefined): Record<string, unknown> | undefined {
  if (!outcome) return undefined;
  return {
    ok: outcome.ok,
    ...(outcome.cleanupFailed ? { cleanupFailed: outcome.cleanupFailed } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.releasedKeys !== undefined ? { releasedKeys: outcome.releasedKeys } : {}),
    ...(outcome.releasedButtons !== undefined ? { releasedButtons: outcome.releasedButtons } : {}),
  };
}

function cleanupFailureResult(cleanup: CleanupOutcome): ToolResult {
  return json(false, {
    errorType: "cleanup_error",
    error: cleanup.error ?? "GLKVM input sent, but release-all cleanup failed.",
    cleanup: formatCleanup(cleanup),
  });
}

function json(success: boolean, value: Record<string, unknown>): ToolResult {
  return {
    success,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function directControlOptions(args: Record<string, unknown>): {
  tabId?: unknown;
  target?: string;
} {
  return {
    ...("tabId" in args ? { tabId: args.tabId } : {}),
    ...(typeof args.target === "string" ? { target: args.target } : {}),
  };
}

export class GlkvmInputTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    let session: GlkvmSession | undefined;
    let cleanup: CleanupOutcome | undefined;
    try {
      if (args.action !== "key") {
        if (args.action !== "type") {
          const mouseAction = getMouseAction(args.action);
          if (mouseAction) return await this.executeMouse(args, mouseAction, context);
          throw new Error(
            `Unsupported GLKVM input action: ${String(args.action)}`,
          );
        }

        return await this.executeType(args, context);
      }
      if (typeof args.key !== "string") {
        throw new Error('The "key" argument is required for GLKVM key input');
      }

      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId : undefined;
      const keyAction = getKeyAction(args.keyAction);
      const steps = buildKeySteps(args.key, keyAction);

      const validated = await requireOwnedGlkvmTabForDirectControl(
        directControlOptions(args),
        context.sessionScope,
      );
      session = await connect({
        tabId: validated.tabId,
        ...(sessionId ? { sessionId } : {}),
      });

      await sendKeySteps(session, steps);
      cleanup = await cleanupSession(session, { releaseAll: true });
      if (!cleanup.ok) return cleanupFailureResult(cleanup);

      return json(true, {
        action: "key",
        keyAction,
        key: args.key,
        sessionId: session.sessionId,
        sent: steps.length,
        cleanup: formatCleanup(cleanup),
      });
    } catch (error) {
      if (session) {
        cleanup = await cleanupSession(session, { releaseAll: true });
      }
      return json(false, {
        errorType: "input_error",
        error: error instanceof Error ? error.message : String(error),
        cleanup: formatCleanup(cleanup),
      });
    }
  }

  private async executeType(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (typeof args.text !== "string") {
      throw new Error('The "text" argument is required for GLKVM text input');
    }

    if (args.text.length > MAX_PASTE_TEXT_LENGTH) {
      throw new Error(
        `GLKVM text input is limited to ${MAX_PASTE_TEXT_LENGTH} characters; received ${args.text.length}`,
      );
    }

    const sessionId =
      typeof args.sessionId === "string" ? args.sessionId : undefined;
    const fallback = getFallbackMode(args.fallback);
    const validated = await requireOwnedGlkvmTabForDirectControl(
      directControlOptions(args),
      context.sessionScope,
    );

    try {
      await pasteText({ tabId: validated.tabId, text: args.text });
      return json(true, {
        action: "type",
        method: "paste",
        textLength: args.text.length,
      });
    } catch (error) {
      if (fallback === "none") throw error;

      const steps = buildTextFallbackSteps(args.text);
      const session = await connect({
        tabId: validated.tabId,
        ...(sessionId ? { sessionId } : {}),
      });

      try {
        await sendKeySteps(session, steps);
      } catch (fallbackError) {
        const cleanup = await cleanupSession(session, { releaseAll: true });
        throw new Error(
          `GLKVM text fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}${cleanup.ok ? "" : `; release-all cleanup failed: ${cleanup.error ?? "unknown error"}`}`,
        );
      }

      const cleanup = await cleanupSession(session, { releaseAll: true });
      if (!cleanup.ok) return cleanupFailureResult(cleanup);

      return json(true, {
        action: "type",
        method: "key_fallback",
        textLength: args.text.length,
        sessionId: session.sessionId,
        sent: steps.length,
        pasteError: error instanceof Error ? error.message : String(error),
        cleanup: formatCleanup(cleanup),
      });
    }
  }

  private async executeMouse(
    args: Record<string, unknown>,
    action: MouseAction,
    context: ToolContext,
  ): Promise<ToolResult> {
    let session: GlkvmSession | undefined;
    let cleanup: CleanupOutcome | undefined;
    try {
      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId : undefined;
      const validated = await requireOwnedGlkvmTabForDirectControl(
        directControlOptions(args),
        context.sessionScope,
      );

      let plan: MouseInputPlan;

      if (action === "scroll") {
        const direction =
          args.direction === "up"
            ? "up"
            : args.direction === "down"
              ? "down"
              : undefined;
        if (!direction) {
          throw new Error(
            'The "direction" argument is required for GLKVM scroll input',
          );
        }
        const amount =
          args.amount === undefined ? 1 : getRequiredNumber(args, "amount");
        plan = buildMouseInputPlan({ action, direction, amount });
      } else {
        const video = await getVideoMetadata(validated.tabId);
        const size = frameSize(video);

        if (action === "drag") {
          plan = buildMouseInputPlan({
            action,
            start: {
              x: getRequiredNumber(args, "startX"),
              y: getRequiredNumber(args, "startY"),
            },
            end: {
              x: getRequiredNumber(args, "endX"),
              y: getRequiredNumber(args, "endY"),
            },
            size,
            button: args.button,
          });
        } else {
          plan = buildMouseInputPlan({
            action,
            point: {
              x: getRequiredNumber(args, "x"),
              y: getRequiredNumber(args, "y"),
            },
            size,
            button: args.button,
          });
        }
      }

      session = await connect({
        tabId: validated.tabId,
        ...(sessionId ? { sessionId } : {}),
      });

      for (const packet of plan.packets) {
        await send({ session, packets: [packet] });
      }

      cleanup = await cleanupSession(session, { releaseAll: true });
      if (!cleanup.ok) return cleanupFailureResult(cleanup);

      return json(true, {
        ...plan.response,
        sessionId: session.sessionId,
        sent: plan.packets.length,
        cleanup: formatCleanup(cleanup),
      });
    } catch (error) {
      if (session) {
        cleanup = await cleanupSession(session, { releaseAll: true });
      }
      return json(false, {
        errorType: "input_error",
        error: error instanceof Error ? error.message : String(error),
        cleanup: formatCleanup(cleanup),
      });
    }
  }
}
