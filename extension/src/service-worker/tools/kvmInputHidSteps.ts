import {
  encodeMouseButton,
  encodeMouseMove,
  encodeMouseWheel,
  mapToAbsolute,
} from "./kvmHidEncoder.js";

export type KeyAction = "press" | "down" | "up" | "hotkey" | "chord";

export type MouseAction = "click" | "move" | "drag" | "scroll";

export type MouseButton = "left" | "middle" | "right";

export interface KeyStep {
  key: string;
  down: boolean;
}

export interface MousePoint {
  x: number;
  y: number;
}

export interface MappedMousePoint extends MousePoint {
  absoluteX: number;
  absoluteY: number;
}

export interface MouseInputPlan {
  packets: Uint8Array[];
  response: Record<string, unknown>;
}

export type MouseInputPlanInput =
  | {
    action: "scroll";
    direction: "up" | "down";
    amount: number;
  }
  | {
    action: "click" | "move";
    point: MousePoint;
    size: { width: number; height: number };
    button?: unknown;
  }
  | {
    action: "drag";
    start: MousePoint;
    end: MousePoint;
    size: { width: number; height: number };
    button?: unknown;
  };

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

function fallbackKeyForCharacter(char: string): string {
  if (/^[a-z0-9]$/.test(char)) return char;
  if (char === " ") return "Space";
  if (char === "\n" || char === "\r") return "Enter";
  if (char === "\t") return "Tab";
  throw new Error(
    `Text contains character ${JSON.stringify(char)} that cannot be typed through key-event fallback`,
  );
}

export function buildKeySteps(key: string, action: KeyAction): KeyStep[] {
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

export function buildTextFallbackSteps(text: string): KeyStep[] {
  return Array.from(text).flatMap((char) =>
    buildKeySteps(fallbackKeyForCharacter(char), "press"),
  );
}

export function frameSize(video: {
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

export function mapMousePoint(
  point: MousePoint,
  size: { width: number; height: number },
): MappedMousePoint {
  return {
    ...point,
    absoluteX: normalizeZero(mapToAbsolute(point.x, 0, size.width)),
    absoluteY: normalizeZero(mapToAbsolute(point.y, 0, size.height)),
  };
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function getMouseButton(value: unknown): MouseButton {
  if (value === undefined) return "left";
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new Error(`Unsupported GLKVM mouse button: ${String(value)}`);
}

function formatPoint(point: MappedMousePoint): Record<string, unknown> {
  return {
    screenshot: { x: point.x, y: point.y },
    absolute: { x: point.absoluteX, y: point.absoluteY },
  };
}

export function buildMouseInputPlan(
  input: MouseInputPlanInput,
): MouseInputPlan {
  const packets: Uint8Array[] = [];
  const response: Record<string, unknown> = { action: input.action };

  if (input.action === "scroll") {
    packets.push(
      encodeMouseWheel([
        { dx: 0, dy: input.direction === "down" ? -input.amount : input.amount },
      ]),
    );
    response.direction = input.direction;
    response.amount = input.amount;
    return { packets, response };
  }

  const button = getMouseButton(input.button);

  if (input.action === "drag") {
    const start = mapMousePoint(input.start, input.size);
    const end = mapMousePoint(input.end, input.size);
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
      screenshot: { width: input.size.width, height: input.size.height },
    };
    return { packets, response };
  }

  const point = mapMousePoint(input.point, input.size);
  packets.push(encodeMouseMove(point.absoluteX, point.absoluteY));
  response.coordinates = {
    screenshot: {
      x: point.x,
      y: point.y,
      width: input.size.width,
      height: input.size.height,
    },
    absolute: { x: point.absoluteX, y: point.absoluteY },
  };

  if (input.action === "click") {
    packets.push(
      encodeMouseButton(button, true),
      encodeMouseButton(button, false),
    );
    response.button = button;
  }

  return { packets, response };
}
