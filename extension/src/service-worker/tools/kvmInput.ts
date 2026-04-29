import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "../../types/messages.js";
import { getVideoMetadata, resolveGlkvmTab } from "../glkvmTab.js";
import {
  encodeKeyEvent,
  encodeMouseButton,
  encodeMouseMove,
  encodeMouseWheel,
  mapToAbsolute,
} from "./kvmHidEncoder.js";
import {
  cleanupSession,
  connect,
  pasteText,
  send,
  type CleanupOutcome,
  type GlkvmSession,
} from "./kvmHidTransport.js";

type KeyAction = "press" | "down" | "up" | "hotkey" | "chord";

type MouseAction = "click" | "move" | "drag" | "scroll";

type MouseButton = "left" | "middle" | "right";

type FallbackMode = "keys" | "none";

interface MousePoint {
  x: number;
  y: number;
}

interface MappedMousePoint extends MousePoint {
  absoluteX: number;
  absoluteY: number;
}

interface KeyStep {
  key: string;
  down: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  alt: "AltLeft",
  option: "AltLeft",
  backspace: "Backspace",
  capslock: "CapsLock",
  cmd: "MetaLeft",
  command: "MetaLeft",
  control: "ControlLeft",
  ctrl: "ControlLeft",
  delete: "Delete",
  del: "Delete",
  down: "ArrowDown",
  end: "End",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  insert: "Insert",
  ins: "Insert",
  left: "ArrowLeft",
  meta: "MetaLeft",
  optionleft: "AltLeft",
  pagedown: "PageDown",
  pageup: "PageUp",
  return: "Enter",
  right: "ArrowRight",
  shift: "ShiftLeft",
  space: "Space",
  spacebar: "Space",
  super: "MetaLeft",
  tab: "Tab",
  up: "ArrowUp",
};

const PRINTABLE_KEY_CODES: Record<string, string> = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
};

const EXPLICIT_CODE_PATTERN = /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|(?:Control|Shift|Alt|Meta)(?:Left|Right)|Arrow(?:Up|Down|Left|Right)|Backspace|Tab|Enter|Escape|Space|CapsLock|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

const MAX_PASTE_TEXT_LENGTH = 4096;

const MOUSE_METADATA_ERROR =
  "GLKVM video metadata is stale or unavailable. Capture a fresh glkvm_screenshot before sending mouse input.";

export function resolveKvmdKeyName(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("Key is required");
  }

  if (EXPLICIT_CODE_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias) return alias;

  if (/^[a-z]$/i.test(trimmed)) {
    return `Key${trimmed.toUpperCase()}`;
  }

  if (/^[0-9]$/.test(trimmed)) {
    return `Digit${trimmed}`;
  }

  const printable = PRINTABLE_KEY_CODES[trimmed];
  if (printable) return printable;

  throw new Error(`Unsupported GLKVM key: ${key}`);
}

function parseKeyList(key: string): string[] {
  return key
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(resolveKvmdKeyName);
}

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

function getMouseButton(value: unknown): MouseButton {
  if (value === undefined) return "left";
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new Error(`Unsupported GLKVM mouse button: ${String(value)}`);
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

function fallbackKeyForCharacter(char: string): string {
  if (/^[a-z0-9]$/.test(char)) return char;
  if (char === " ") return "Space";
  if (char === "\n" || char === "\r") return "Enter";
  if (char === "\t") return "Tab";
  throw new Error(
    `Text contains character ${JSON.stringify(char)} that cannot be typed through key-event fallback`,
  );
}

function buildTextFallbackSteps(text: string): KeyStep[] {
  return Array.from(text).flatMap((char) =>
    buildKeySteps(fallbackKeyForCharacter(char), "press"),
  );
}

function buildKeySteps(key: string, action: KeyAction): KeyStep[] {
  const keys = parseKeyList(key);
  if (keys.length === 0) {
    throw new Error("Key is required");
  }

  switch (action) {
    case "down":
      return keys.map((name) => ({ key: name, down: true }));
    case "up":
      return [...keys].reverse().map((name) => ({ key: name, down: false }));
    case "press":
    case "hotkey":
    case "chord":
      return [
        ...keys.map((name) => ({ key: name, down: true })),
        ...[...keys].reverse().map((name) => ({ key: name, down: false })),
      ];
  }
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

function frameSize(video: {
  videoWidth: number;
  videoHeight: number;
  visible: boolean;
  displayRect: { width: number; height: number };
}): { width: number; height: number } {
  const width = Math.round(video.displayRect.width);
  const height = Math.round(video.displayRect.height);
  if (
    !video.visible
    || video.videoWidth <= 0
    || video.videoHeight <= 0
    || width <= 0
    || height <= 0
  ) {
    throw new Error(MOUSE_METADATA_ERROR);
  }
  return { width, height };
}

function mapMousePoint(
  point: MousePoint,
  size: { width: number; height: number },
): MappedMousePoint {
  return {
    ...point,
    absoluteX: mapToAbsolute(point.x, 0, size.width),
    absoluteY: mapToAbsolute(point.y, 0, size.height),
  };
}

function formatPoint(point: MappedMousePoint): Record<string, unknown> {
  return {
    screenshot: { x: point.x, y: point.y },
    absolute: { x: point.absoluteX, y: point.absoluteY },
  };
}

function json(success: boolean, value: Record<string, unknown>): ToolResult {
  return {
    success,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export class GlkvmInputTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    let session: GlkvmSession | undefined;
    let cleanup: CleanupOutcome | undefined;
    try {
      if (args.action !== "key") {
        if (args.action !== "type") {
          const mouseAction = getMouseAction(args.action);
          if (mouseAction) return await this.executeMouse(args, mouseAction);
          throw new Error(
            `Unsupported GLKVM input action: ${String(args.action)}`,
          );
        }

        return await this.executeType(args);
      }
      if (typeof args.key !== "string") {
        throw new Error('The "key" argument is required for GLKVM key input');
      }

      const target = typeof args.target === "string" ? args.target : undefined;
      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId : undefined;
      const keyAction = getKeyAction(args.keyAction);
      const steps = buildKeySteps(args.key, keyAction);

      const resolved = await resolveGlkvmTab(target ? { target } : undefined);
      session = await connect({
        tabId: resolved.tabId,
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

  private async executeType(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.text !== "string") {
      throw new Error('The "text" argument is required for GLKVM text input');
    }

    if (args.text.length > MAX_PASTE_TEXT_LENGTH) {
      throw new Error(
        `GLKVM text input is limited to ${MAX_PASTE_TEXT_LENGTH} characters; received ${args.text.length}`,
      );
    }

    const target = typeof args.target === "string" ? args.target : undefined;
    const sessionId =
      typeof args.sessionId === "string" ? args.sessionId : undefined;
    const fallback = getFallbackMode(args.fallback);
    const resolved = await resolveGlkvmTab(target ? { target } : undefined);

    try {
      await pasteText({ tabId: resolved.tabId, text: args.text });
      return json(true, {
        action: "type",
        method: "paste",
        textLength: args.text.length,
      });
    } catch (error) {
      if (fallback === "none") throw error;

      const steps = buildTextFallbackSteps(args.text);
      const session = await connect({
        tabId: resolved.tabId,
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
  ): Promise<ToolResult> {
    let session: GlkvmSession | undefined;
    let cleanup: CleanupOutcome | undefined;
    try {
      const target = typeof args.target === "string" ? args.target : undefined;
      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId : undefined;
      const resolved = await resolveGlkvmTab(target ? { target } : undefined);

      const packets: Uint8Array[] = [];
      const response: Record<string, unknown> = { action };

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
        packets.push(
          encodeMouseWheel([
            { dx: 0, dy: direction === "down" ? -amount : amount },
          ]),
        );
        response.direction = direction;
        response.amount = amount;
      } else {
        const video = await getVideoMetadata(resolved.tabId);
        const size = frameSize(video);
        const button = getMouseButton(args.button);

        if (action === "drag") {
          const start = mapMousePoint(
            {
              x: getRequiredNumber(args, "startX"),
              y: getRequiredNumber(args, "startY"),
            },
            size,
          );
          const end = mapMousePoint(
            {
              x: getRequiredNumber(args, "endX"),
              y: getRequiredNumber(args, "endY"),
            },
            size,
          );
          packets.push(
            encodeMouseMove(start.absoluteX, start.absoluteY),
            encodeMouseButton(button, true),
            encodeMouseMove(end.absoluteX, end.absoluteY),
            encodeMouseButton(button, false),
          );
          response.button = button;
          response.coordinates = {
            start: formatPoint(start),
            end: formatPoint(end),
            screenshot: { width: size.width, height: size.height },
          };
        } else {
          const point = mapMousePoint(
            {
              x: getRequiredNumber(args, "x"),
              y: getRequiredNumber(args, "y"),
            },
            size,
          );
          packets.push(encodeMouseMove(point.absoluteX, point.absoluteY));
          response.coordinates = {
            screenshot: {
              x: point.x,
              y: point.y,
              width: size.width,
              height: size.height,
            },
            absolute: { x: point.absoluteX, y: point.absoluteY },
          };

          if (action === "click") {
            packets.push(
              encodeMouseButton(button, true),
              encodeMouseButton(button, false),
            );
            response.button = button;
          }
        }
      }

      session = await connect({
        tabId: resolved.tabId,
        ...(sessionId ? { sessionId } : {}),
      });

      for (const packet of packets) {
        await send({ session, packets: [packet] });
      }

      cleanup = await cleanupSession(session, { releaseAll: true });
      if (!cleanup.ok) return cleanupFailureResult(cleanup);

      return json(true, {
        ...response,
        sessionId: session.sessionId,
        sent: packets.length,
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
