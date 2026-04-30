import {
  encodeMouseButton,
  encodeMouseMove,
  encodeMouseWheel,
  mapToAbsolute,
} from "./kvmHidEncoder.js";
import {
  resolveCachedGlkvmFrameDescriptor,
  type GlkvmFrameDescriptor,
} from "./glkvmFrame.js";

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

export type MouseCoordinateSpace =
  | "glkvm_screenshot_pixels"
  | "intrinsic_remote_frame_pixels"
  | "normalized_remote_frame";

export interface CoordinateDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly axis?: "x" | "y";
  readonly input?: number;
  readonly output?: number;
  readonly frameId?: string;
}

export interface ResolvedMouseCoordinates {
  readonly input: {
    readonly coordinateSpace: MouseCoordinateSpace;
    readonly point: MousePoint;
    readonly frameId?: string;
  };
  readonly intrinsic: MousePoint & { width: number; height: number };
  readonly screenshot?: MousePoint & { width: number; height: number };
  readonly normalized?: MousePoint;
  readonly diagnostics: CoordinateDiagnostic[];
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
    coordinateSpace?: MouseCoordinateSpace;
    frameId?: string;
    frame?: GlkvmFrameDescriptor;
    button?: unknown;
  }
  | {
    action: "drag";
    start: MousePoint;
    end: MousePoint;
    size: { width: number; height: number };
    coordinateSpace?: MouseCoordinateSpace;
    frameId?: string;
    frame?: GlkvmFrameDescriptor;
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

function frameSourceSize(
  frame: GlkvmFrameDescriptor | undefined,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  return {
    width: frame?.source?.width ?? fallback.width,
    height: frame?.source?.height ?? fallback.height,
  };
}

function resolveFrameDescriptor(
  frame: GlkvmFrameDescriptor | undefined,
  frameId: string | undefined,
): GlkvmFrameDescriptor | undefined {
  if (frame !== undefined) {
    if (frameId !== undefined && frame.frameId !== frameId) {
      throw new Error(
        `GLKVM frameId mismatch: requested ${frameId} but descriptor is ${frame.frameId}.`,
      );
    }
    return frame;
  }
  if (frameId === undefined) {
    return undefined;
  }
  const resolved = resolveCachedGlkvmFrameDescriptor(frameId);
  if (resolved === undefined) {
    throw new Error(
      `Unknown or stale GLKVM frameId ${frameId}. Capture a fresh glkvm_screenshot before sending screenshot-coordinate mouse input.`,
    );
  }
  return resolved;
}

function clampCoordinate(
  axis: "x" | "y",
  value: number,
  min: number,
  max: number,
  diagnostics: CoordinateDiagnostic[],
): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid GLKVM mouse ${axis}: expected a finite number.`);
  }
  const clamped = Math.min(max, Math.max(min, value));
  if (clamped !== value) {
    diagnostics.push({
      code: "coordinate_clamped",
      message: `Mouse ${axis} coordinate ${value} was outside ${min}..${max} and was clamped to ${clamped}.`,
      axis,
      input: value,
      output: clamped,
    });
  }
  return clamped;
}

export function resolveMouseInputCoordinates(options: {
  point: MousePoint;
  size: { width: number; height: number };
  coordinateSpace?: MouseCoordinateSpace;
  frameId?: string;
  frame?: GlkvmFrameDescriptor;
}): ResolvedMouseCoordinates {
  const coordinateSpace = options.coordinateSpace ?? "glkvm_screenshot_pixels";
  const frame = resolveFrameDescriptor(options.frame, options.frameId);
  const source = frameSourceSize(frame, options.size);
  const diagnostics: CoordinateDiagnostic[] = [];
  let intrinsicX: number;
  let intrinsicY: number;
  let screenshot: ResolvedMouseCoordinates["screenshot"];
  let normalized: MousePoint | undefined;

  if (coordinateSpace === "normalized_remote_frame") {
    normalized = { x: options.point.x, y: options.point.y };
    intrinsicX = options.point.x * source.width;
    intrinsicY = options.point.y * source.height;
  } else if (coordinateSpace === "intrinsic_remote_frame_pixels") {
    intrinsicX = options.point.x;
    intrinsicY = options.point.y;
  } else {
    const output = frame?.output ?? {
      width: options.size.width,
      height: options.size.height,
      coordinateSpace: "glkvm_screenshot_pixels" as const,
    };
    const crop = frame?.crop ?? {
      x: 0,
      y: 0,
      width: source.width,
      height: source.height,
      coordinateSpace: "intrinsic_remote_frame_pixels" as const,
    };
    const scaleX = crop.width / output.width;
    const scaleY = crop.height / output.height;
    intrinsicX = crop.x + options.point.x * scaleX;
    intrinsicY = crop.y + options.point.y * scaleY;
    screenshot = {
      x: options.point.x,
      y: options.point.y,
      width: output.width,
      height: output.height,
    };
    if (frame !== undefined) {
      diagnostics.push({
        code: "mapped_from_screenshot_output",
        message:
          "Mapped GLKVM screenshot-output coordinates through frame crop/downscale metadata to intrinsic remote-frame pixels.",
        frameId: frame.frameId,
      });
    }
  }

  const clampedX = normalizeZero(
    clampCoordinate("x", intrinsicX, 0, source.width, diagnostics),
  );
  const clampedY = normalizeZero(
    clampCoordinate("y", intrinsicY, 0, source.height, diagnostics),
  );

  return {
    input: {
      coordinateSpace,
      point: { x: options.point.x, y: options.point.y },
      ...(frame?.frameId ?? options.frameId
        ? { frameId: frame?.frameId ?? options.frameId }
        : {}),
    },
    intrinsic: {
      x: clampedX,
      y: clampedY,
      width: source.width,
      height: source.height,
    },
    ...(screenshot ? { screenshot } : {}),
    ...(normalized ? { normalized } : {}),
    diagnostics,
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

function formatResolvedCoordinates(
  resolved: ResolvedMouseCoordinates,
  mapped: MappedMousePoint,
): Record<string, unknown> {
  return {
    input: resolved.input,
    ...(resolved.screenshot ? { screenshot: resolved.screenshot } : {}),
    ...(resolved.normalized ? { normalized: resolved.normalized } : {}),
    intrinsic: resolved.intrinsic,
    absolute: { x: mapped.absoluteX, y: mapped.absoluteY },
    diagnostics: resolved.diagnostics,
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
    const startResolved = resolveMouseInputCoordinates({
      point: input.start,
      size: input.size,
      coordinateSpace: input.coordinateSpace,
      frameId: input.frameId,
      frame: input.frame,
    });
    const endResolved = resolveMouseInputCoordinates({
      point: input.end,
      size: input.size,
      coordinateSpace: input.coordinateSpace,
      frameId: input.frameId,
      frame: input.frame,
    });
    const start = mapMousePoint(startResolved.intrinsic, startResolved.intrinsic);
    const end = mapMousePoint(endResolved.intrinsic, endResolved.intrinsic);
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
      input: {
        coordinateSpace: input.coordinateSpace ?? "glkvm_screenshot_pixels",
        ...(input.frame?.frameId ?? input.frameId
          ? { frameId: input.frame?.frameId ?? input.frameId }
          : {}),
      },
      intrinsic: {
        start: startResolved.intrinsic,
        end: endResolved.intrinsic,
      },
      screenshot: { width: input.size.width, height: input.size.height },
      diagnostics: [
        ...startResolved.diagnostics,
        ...endResolved.diagnostics,
      ],
    };
    return { packets, response };
  }

  const resolved = resolveMouseInputCoordinates({
    point: input.point,
    size: input.size,
    coordinateSpace: input.coordinateSpace,
    frameId: input.frameId,
    frame: input.frame,
  });
  const point = mapMousePoint(resolved.intrinsic, resolved.intrinsic);
  packets.push(encodeMouseMove(point.absoluteX, point.absoluteY));
  response.coordinates = {
    screenshot: {
      x: point.x,
      y: point.y,
      width: input.size.width,
      height: input.size.height,
    },
    absolute: { x: point.absoluteX, y: point.absoluteY },
    ...formatResolvedCoordinates(resolved, point),
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
