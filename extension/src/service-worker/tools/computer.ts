/**
 * computer tool - primary browser interaction tool.
 *
 * Actions:
 *   screenshot - Capture the visible viewport as a base64 JPEG image.
 *   click      - Left-click at (x, y) in screenshot coordinates.
 *   double_click - Double-click at (x, y) in screenshot coordinates.
 *   right_click  - Right-click at (x, y) in screenshot coordinates.
 *   type       - Insert text at the current focus (uses Input.insertText).
 *   key        - Press a key or key combo (e.g. "ctrl+a", "Enter", "shift+Tab").
 *   scroll     - Scroll in a direction at (x, y) in screenshot coordinates.
 *   drag       - Drag from (startX, startY) to (endX, endY) in screenshot coordinates.
 *   move       - Move the mouse to (x, y) in screenshot coordinates without clicking.
 *   move_path  - Move the mouse through multiple screenshot-coordinate points.
 *
 * Coordinate system:
 *   All (x, y) values refer to positions in the most recently captured screenshot.
 *   The coordinateMapper translates these to viewport coordinates for CDP dispatch.
 */

import type { ToolHandler, ToolResult, ToolContext } from "../../types/messages.js";
import { cdpManager } from "../cdp.js";
import {
  calculateScreenshotDimensions,
  screenshotToViewport,
  type ViewportSize,
  type ScreenshotDimensions,
} from "../coordinateMapper.js";

// --- Types ---

type Action =
  | "screenshot"
  | "click"
  | "double_click"
  | "right_click"
  | "type"
  | "key"
  | "scroll"
  | "drag"
  | "move"
  | "move_path";

type ScrollDirection = "up" | "down" | "left" | "right";
type ScreenshotOverlay = "none" | "temporary-grid";

/** Pixels to scroll per "click" of the wheel */
const SCROLL_AMOUNT = 100;

/** Delay between mousePressed and mouseReleased for clicks (ms) */
const CLICK_DELAY_MS = 50;

/** Keep CDP attached briefly so Chrome's debugger infobar does not resize the page between actions. */
const COMPUTER_CDP_IDLE_DETACH_DELAY_MS = 3000;

/** Maximum repeated clicks allowed in one request */
const MAX_CLICK_COUNT = 100;

/** Maximum mouse move waypoints allowed in one request */
const MAX_MOVE_PATH_POINTS = 200;

/** Delay between drag steps (ms) */
const DRAG_STEP_DELAY_MS = 16;

/** Number of intermediate steps in a drag operation */
const DRAG_STEPS = 10;

const pendingDetachTimers = new Map<number, ReturnType<typeof setTimeout>>();

const TEMPORARY_GRID_OVERLAY_ID = "chromeuse-grid-overlay";

function cancelPendingDetach(tabId: number): void {
  const timer = pendingDetachTimers.get(tabId);
  if (timer === undefined) return;

  clearTimeout(timer);
  pendingDetachTimers.delete(tabId);
}

function scheduleIdleDetach(tabId: number): void {
  cancelPendingDetach(tabId);
  pendingDetachTimers.set(
    tabId,
    setTimeout(() => {
      pendingDetachTimers.delete(tabId);
      void cdpManager.detach(tabId);
    }, COMPUTER_CDP_IDLE_DETACH_DELAY_MS),
  );
}

function temporaryGridExpression(
  viewport: ViewportSize,
  screenshot: ScreenshotDimensions,
): string {
  const scaleX = viewport.width / screenshot.width;
  const scaleY = viewport.height / screenshot.height;
  const minorGridX = 50 * scaleX;
  const minorGridY = 50 * scaleY;
  const majorGridX = 250 * scaleX;
  const majorGridY = 250 * scaleY;

  return `(() => {
    const screenshotWidth = ${screenshot.width};
    const screenshotHeight = ${screenshot.height};
    const scaleX = ${scaleX};
    const scaleY = ${scaleY};
    document.getElementById(${JSON.stringify(TEMPORARY_GRID_OVERLAY_ID)})?.remove();
    const overlay = document.createElement("div");
    overlay.id = ${JSON.stringify(TEMPORARY_GRID_OVERLAY_ID)};
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none",
      backgroundImage: "linear-gradient(to right, rgba(255,255,255,.18) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.18) 1px, transparent 1px), linear-gradient(to right, rgba(255,0,0,.55) 2px, transparent 2px), linear-gradient(to bottom, rgba(255,0,0,.55) 2px, transparent 2px)",
      backgroundSize: "${minorGridX}px ${minorGridY}px, ${minorGridX}px ${minorGridY}px, ${majorGridX}px ${majorGridY}px, ${majorGridX}px ${majorGridY}px"
    });
    for (let sx = 0; sx < screenshotWidth; sx += 250) {
      const label = document.createElement("div");
      label.textContent = "x" + sx;
      Object.assign(label.style, {
        position: "fixed",
        left: (sx * scaleX + 4) + "px",
        top: "4px",
        color: "#fff",
        background: "rgba(220,38,38,.8)",
        font: "12px monospace",
        padding: "2px 4px",
        borderRadius: "4px"
      });
      overlay.appendChild(label);
    }
    for (let sy = 0; sy < screenshotHeight; sy += 250) {
      const label = document.createElement("div");
      label.textContent = "y" + sy;
      Object.assign(label.style, {
        position: "fixed",
        left: "4px",
        top: (sy * scaleY + 4) + "px",
        color: "#fff",
        background: "rgba(220,38,38,.8)",
        font: "12px monospace",
        padding: "2px 4px",
        borderRadius: "4px"
      });
      overlay.appendChild(label);
    }
    document.documentElement.appendChild(overlay);
    return new Promise((resolve) => requestAnimationFrame(() => resolve(true)));
  })()`;
}

function removeTemporaryGridExpression(): string {
  return `(() => {
    document.getElementById(${JSON.stringify(TEMPORARY_GRID_OVERLAY_ID)})?.remove();
  })()`;
}

// --- Key Mapping ---

/**
 * Map readable key names to CDP key event properties.
 * CDP requires `key`, `code`, `windowsVirtualKeyCode`, etc.
 */
const KEY_DEFINITIONS: Record<
  string,
  { key: string; code: string; keyCode: number; text?: string }
> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  capslock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  caps: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 },
  f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 },
  f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 },
  f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
  f12: { key: "F12", code: "F12", keyCode: 123 },
};

const DIGIT_SHIFT_KEYS: Record<string, string> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
};

const PUNCTUATION_DEFINITIONS: Record<
  string,
  { key: string; shiftedKey: string; code: string; keyCode: number }
> = {
  "`": { key: "`", shiftedKey: "~", code: "Backquote", keyCode: 192 },
  "-": { key: "-", shiftedKey: "_", code: "Minus", keyCode: 189 },
  "=": { key: "=", shiftedKey: "+", code: "Equal", keyCode: 187 },
  "[": { key: "[", shiftedKey: "{", code: "BracketLeft", keyCode: 219 },
  "]": { key: "]", shiftedKey: "}", code: "BracketRight", keyCode: 221 },
  "\\": { key: "\\", shiftedKey: "|", code: "Backslash", keyCode: 220 },
  ";": { key: ";", shiftedKey: ":", code: "Semicolon", keyCode: 186 },
  "'": { key: "'", shiftedKey: '"', code: "Quote", keyCode: 222 },
  ",": { key: ",", shiftedKey: "<", code: "Comma", keyCode: 188 },
  ".": { key: ".", shiftedKey: ">", code: "Period", keyCode: 190 },
  "/": { key: "/", shiftedKey: "?", code: "Slash", keyCode: 191 },
};

const PUNCTUATION_ALIASES: Record<string, string> = {
  backquote: "`",
  minus: "-",
  dash: "-",
  equal: "=",
  equals: "=",
  plus: "=",
  bracketleft: "[",
  leftbracket: "[",
  bracketright: "]",
  rightbracket: "]",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  comma: ",",
  period: ".",
  dot: ".",
  slash: "/",
  forwardslash: "/",
};

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the current viewport size from CDP layout metrics.
 */
async function getViewportSize(tabId: number): Promise<ViewportSize> {
  const metrics = await cdpManager.sendCommand<{
    cssLayoutViewport: { clientWidth: number; clientHeight: number };
  }>(tabId, "Page.getLayoutMetrics");
  return {
    width: metrics.cssLayoutViewport.clientWidth,
    height: metrics.cssLayoutViewport.clientHeight,
  };
}

/**
 * Map screenshot coordinates to viewport coordinates using stored dimensions.
 */
function mapCoords(
  x: number,
  y: number,
  viewport: ViewportSize,
  screenshotDims: ScreenshotDimensions,
): { x: number; y: number } {
  return screenshotToViewport({ x, y }, viewport, screenshotDims);
}

/**
 * Parse a key string like "ctrl+shift+a" into modifiers and the base key.
 */
function parseKeyCombo(keyStr: string): {
  modifiers: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  baseKey: string;
} {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;

  const nonModifiers: string[] = [];
  for (const part of parts) {
    switch (part) {
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      case "meta":
      case "cmd":
      case "command":
      case "super":
        meta = true;
        break;
      default:
        nonModifiers.push(part);
    }
  }

  // CDP modifier flags: Alt=1, Ctrl=2, Meta=4, Shift=8
  let modifiers = 0;
  if (alt) modifiers |= 1;
  if (ctrl) modifiers |= 2;
  if (meta) modifiers |= 4;
  if (shift) modifiers |= 8;

  return {
    modifiers,
    ctrl,
    alt,
    shift,
    meta,
    baseKey: nonModifiers.join("+") || "",
  };
}

/**
 * Dispatch a CDP key event (keyDown + keyUp) for a parsed key combo.
 */
async function dispatchKey(tabId: number, keyStr: string): Promise<void> {
  const { modifiers, baseKey, shift, ctrl, alt, meta } = parseKeyCombo(keyStr);

  // Look up the key definition
  const keyDef = KEY_DEFINITIONS[baseKey.toLowerCase()];

  if (keyDef) {
    // Known special key
    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
      modifiers,
      ...(keyDef.text && !hasCommandModifier(ctrl, alt, meta) ? { text: keyDef.text } : {}),
    });

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
      modifiers,
    });
  } else if (/^[a-z]$/i.test(baseKey)) {
    // Single character key
    const char = shift ? baseKey.toUpperCase() : baseKey.toLowerCase();
    const upper = baseKey.toUpperCase();
    const keyCode = upper.charCodeAt(0);

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: char,
      code: `Key${upper}`,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(!hasCommandModifier(ctrl, alt, meta) ? { text: char } : {}),
      modifiers,
    });

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
      code: `Key${upper}`,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  } else if (/^[0-9]$/.test(baseKey)) {
    const keyValue = shift ? DIGIT_SHIFT_KEYS[baseKey] : baseKey;
    const keyCode = baseKey.charCodeAt(0);

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: keyValue,
      code: `Digit${baseKey}`,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(!hasCommandModifier(ctrl, alt, meta) ? { text: keyValue } : {}),
      modifiers,
    });

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyValue,
      code: `Digit${baseKey}`,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  } else if (getPunctuationDefinition(baseKey)) {
    const punctuation = getPunctuationDefinition(baseKey)!;
    const keyValue = shift ? punctuation.shiftedKey : punctuation.key;

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: keyValue,
      code: punctuation.code,
      windowsVirtualKeyCode: punctuation.keyCode,
      nativeVirtualKeyCode: punctuation.keyCode,
      ...(!hasCommandModifier(ctrl, alt, meta) ? { text: keyValue } : {}),
      modifiers,
    });

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyValue,
      code: punctuation.code,
      windowsVirtualKeyCode: punctuation.keyCode,
      nativeVirtualKeyCode: punctuation.keyCode,
      modifiers,
    });
  } else {
    throw new Error(`Unknown key: "${baseKey}"`);
  }
}

function hasCommandModifier(ctrl: boolean, alt: boolean, meta: boolean): boolean {
  return ctrl || alt || meta;
}

function getPunctuationDefinition(baseKey: string) {
  const normalized = PUNCTUATION_ALIASES[baseKey.toLowerCase()] ?? baseKey;
  return PUNCTUATION_DEFINITIONS[normalized];
}

/**
 * Dispatch a mouse event at viewport coordinates.
 */
async function dispatchMouseEvent(
  tabId: number,
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  x: number,
  y: number,
  button: "none" | "left" | "right" | "middle" = "none",
  clickCount = 1,
  modifiers = 0,
): Promise<void> {
  // CDP button enum: left=0, middle=1, right=2
  const buttonMap = { none: "none", left: "left", middle: "middle", right: "right" } as const;
  const buttons = type === "mouseReleased" || button === "none"
    ? 0
    : button === "left"
      ? 1
      : button === "right"
        ? 2
        : 4;

  await cdpManager.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : buttonMap[button],
    clickCount,
    modifiers,
    // buttons bitmask: 1=left, 2=right, 4=middle
    buttons,
  });
}

// --- ComputerTool ---

export class ComputerTool implements ToolHandler {
  /**
   * Stored screenshot dimensions from the last screenshot capture.
   * Used to map incoming (x, y) coordinates from screenshot space
   * to viewport space for subsequent actions.
   */
  private lastScreenshotDims: ScreenshotDimensions | null = null;

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    let tabId: number | undefined;
    let attachedForCall = false;

    try {
      const action = args.action as Action | undefined;
      if (!action) {
        return this.error("Missing required argument: action");
      }

      tabId = args.tabId as number | undefined;
      if (typeof tabId !== "number") {
        return this.error("Missing required argument: tabId (number)");
      }

      cancelPendingDetach(tabId);

      // Ensure CDP is attached
      if (!cdpManager.isAttached(tabId)) {
        await cdpManager.attach(tabId);
        attachedForCall = true;
      }

      switch (action) {
        case "screenshot":
          return await this.screenshotWithArgs(tabId, args);
        case "click":
          return await this.click(tabId, args, "left", 1);
        case "double_click":
          return await this.click(tabId, args, "left", 2);
        case "right_click":
          return await this.click(tabId, args, "right", 1);
        case "type":
          return await this.type(tabId, args);
        case "key":
          return await this.keyAction(tabId, args);
        case "scroll":
          return await this.scroll(tabId, args);
        case "drag":
          return await this.drag(tabId, args);
        case "move":
          return await this.move(tabId, args);
        case "move_path":
          return await this.movePath(tabId, args);
        default:
          return this.error(
            `Unknown action: "${action}". Valid actions: screenshot, click, double_click, right_click, type, key, scroll, drag, move, move_path`,
          );
      }
    } catch (error) {
      return this.error(
        `computer tool failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (attachedForCall && typeof tabId === "number") {
        scheduleIdleDetach(tabId);
      }
    }
  }

  // --- Actions ---

  private async screenshot(tabId: number): Promise<ToolResult> {
    return this.screenshotWithArgs(tabId, {});
  }

  private async screenshotWithArgs(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const overlay = this.extractScreenshotOverlay(args);
    const viewport = await getViewportSize(tabId);
    const expectedScreenshotDims = calculateScreenshotDimensions(viewport);

    // Hide visual indicators during capture
    let wasVisible = false;
    try {
      const resp = (await chrome.tabs.sendMessage(tabId, {
        action: "pre_screenshot",
      })) as { wasVisible?: boolean } | undefined;
      wasVisible = resp?.wasVisible ?? false;
    } catch {
      // Content script may not be injected - that's fine
    }

    try {
      if (overlay === "temporary-grid") {
        await this.evaluate(
          tabId,
          temporaryGridExpression(viewport, expectedScreenshotDims),
          true,
        );
      }

      const { data, dimensions } = await cdpManager.captureScreenshot(tabId, {
        format: "jpeg",
        quality: 80,
        viewport,
      });

      // Store dimensions for coordinate mapping in subsequent actions
      this.lastScreenshotDims = dimensions;

      return {
        success: true,
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data,
            },
          },
          {
            type: "text",
            text: JSON.stringify(this.createScreenshotMetadata(viewport, dimensions)),
          },
        ],
      };
    } finally {
      if (overlay === "temporary-grid") {
        await this.evaluate(tabId, removeTemporaryGridExpression(), true);
      }

      // Restore visual indicators if they were visible
      if (wasVisible) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            action: "post_screenshot",
            wasVisible: true,
          });
        } catch {
          // Ignore - content script might not be present
        }
      }
    }
  }

  private async click(
    tabId: number,
    args: Record<string, unknown>,
    button: "left" | "right",
    clickCount: number,
  ): Promise<ToolResult> {
    return this.withVisualIndicatorHidden(tabId, async () => {
      let coords = this.extractCoords(args);
      const repeatCount = this.extractClickCount(args);

      // Support ref-based click: resolve element bounds from content script
      if (!coords && typeof args.ref === "string") {
        try {
          const response = (await chrome.tabs.sendMessage(tabId, {
            action: "find_by_ref",
            ref: args.ref,
          })) as {
            success: boolean;
            bounds?: { x: number; y: number; width: number; height: number };
          };
          if (response?.success && response.bounds) {
            // Click at center of element (these are viewport coords, not screenshot coords)
            coords = {
              x: Math.round(response.bounds.x + response.bounds.width / 2),
              y: Math.round(response.bounds.y + response.bounds.height / 2),
            };
            // Skip screenshot coordinate mapping since these are already viewport coords
            await this.performClickSequence(tabId, coords.x, coords.y, button, clickCount, repeatCount);
            return this.success(
              this.formatClickMessage(button, clickCount, repeatCount, `element ${args.ref} at (${coords.x}, ${coords.y})`),
            );
          } else {
            return this.error(`Element not found: ${args.ref}`);
          }
        } catch (err) {
          return this.error(
            `Failed to resolve ref ${args.ref}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (!coords) {
        return this.error("Missing required arguments: x and y (numbers), or ref (string)");
      }

      const viewport = await getViewportSize(tabId);
      const viewportCoords = this.toViewport(coords.x, coords.y, viewport);

      await this.performClickSequence(
        tabId,
        viewportCoords.x,
        viewportCoords.y,
        button,
        clickCount,
        repeatCount,
      );

      return this.success(
        this.formatClickMessage(button, clickCount, repeatCount, `at (${coords.x}, ${coords.y})`),
      );
    });
  }

  private async type(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const text = args.text as string | undefined;
    if (typeof text !== "string") {
      return this.error("Missing required argument: text (string)");
    }

    await cdpManager.sendCommand(tabId, "Input.insertText", { text });

    return this.success(
      `Typed ${text.length} character${text.length === 1 ? "" : "s"}`,
    );
  }

  private async keyAction(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const key = args.key as string | undefined;
    if (typeof key !== "string" || key.length === 0) {
      return this.error(
        'Missing required argument: key (string, e.g. "Enter", "ctrl+a", "shift+Tab")',
      );
    }

    await dispatchKey(tabId, key);

    return this.success(`Pressed key: ${key}`);
  }

  private async scroll(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const direction = args.direction as ScrollDirection | undefined;
    if (!direction || !["up", "down", "left", "right"].includes(direction)) {
      return this.error(
        'Missing required argument: direction ("up", "down", "left", "right")',
      );
    }

    const amount =
      typeof args.amount === "number" ? args.amount : SCROLL_AMOUNT;

    // Default scroll position: center of viewport if no coords given
    const viewport = await getViewportSize(tabId);
    let scrollX: number;
    let scrollY: number;

    if (typeof args.x === "number" && typeof args.y === "number") {
      const mapped = this.toViewport(
        args.x as number,
        args.y as number,
        viewport,
      );
      scrollX = mapped.x;
      scrollY = mapped.y;
    } else {
      scrollX = Math.round(viewport.width / 2);
      scrollY = Math.round(viewport.height / 2);
    }

    // CDP Input.dispatchMouseEvent with mouseWheel
    let deltaX = 0;
    let deltaY = 0;
    switch (direction) {
      case "up":
        deltaY = -amount;
        break;
      case "down":
        deltaY = amount;
        break;
      case "left":
        deltaX = -amount;
        break;
      case "right":
        deltaX = amount;
        break;
    }

    await cdpManager.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: scrollX,
      y: scrollY,
      deltaX,
      deltaY,
    });

    return this.success(`Scrolled ${direction} by ${amount}px`);
  }

  private async drag(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startX = args.startX as number | undefined;
    const startY = args.startY as number | undefined;
    const endX = args.endX as number | undefined;
    const endY = args.endY as number | undefined;

    if (
      typeof startX !== "number" ||
      typeof startY !== "number" ||
      typeof endX !== "number" ||
      typeof endY !== "number"
    ) {
      return this.error(
        "Missing required arguments: startX, startY, endX, endY (all numbers)",
      );
    }

    const viewport = await getViewportSize(tabId);
    const start = this.toViewport(startX, startY, viewport);
    const end = this.toViewport(endX, endY, viewport);

    // Move to start position
    await dispatchMouseEvent(tabId, "mouseMoved", start.x, start.y);
    await sleep(DRAG_STEP_DELAY_MS);

    // Press at start
    await dispatchMouseEvent(
      tabId,
      "mousePressed",
      start.x,
      start.y,
      "left",
      1,
    );
    await sleep(DRAG_STEP_DELAY_MS);

    // Move in steps to end position (smooth drag)
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const t = i / DRAG_STEPS;
      const ix = Math.round(start.x + (end.x - start.x) * t);
      const iy = Math.round(start.y + (end.y - start.y) * t);
      await dispatchMouseEvent(tabId, "mouseMoved", ix, iy, "left", 0);
      await sleep(DRAG_STEP_DELAY_MS);
    }

    // Release at end
    await dispatchMouseEvent(tabId, "mouseReleased", end.x, end.y, "left", 1);

    return this.success(
      `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`,
    );
  }

  private async move(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const coords = this.extractCoords(args);
    if (!coords) {
      return this.error("Missing required arguments: x (number), y (number)");
    }

    const viewport = await getViewportSize(tabId);
    const viewportCoords = this.toViewport(coords.x, coords.y, viewport);

    await dispatchMouseEvent(
      tabId,
      "mouseMoved",
      viewportCoords.x,
      viewportCoords.y,
    );

    return this.success(`Moved mouse to (${coords.x}, ${coords.y})`);
  }

  private async movePath(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const points = this.extractPointPath(args);
    if (!points) {
      return this.error("Missing required argument: points (array of { x, y } objects)");
    }

    const viewport = await getViewportSize(tabId);
    for (const point of points) {
      const viewportCoords = this.toViewport(point.x, point.y, viewport);
      await dispatchMouseEvent(
        tabId,
        "mouseMoved",
        viewportCoords.x,
        viewportCoords.y,
      );
    }

    return this.success(`Moved mouse through ${points.length} points`);
  }

  // --- Utilities ---

  private extractCoords(
    args: Record<string, unknown>,
  ): { x: number; y: number } | null {
    if (typeof args.x === "number" && typeof args.y === "number") {
      return { x: args.x, y: args.y };
    }
    return null;
  }

  private extractClickCount(args: Record<string, unknown>): number {
    if (typeof args.count !== "number") return 1;
    if (!Number.isFinite(args.count)) return 1;
    return Math.max(1, Math.min(MAX_CLICK_COUNT, Math.floor(args.count)));
  }

  private extractScreenshotOverlay(
    args: Record<string, unknown>,
  ): ScreenshotOverlay {
    if (args.overlay === "temporary-grid") return "temporary-grid";
    return "none";
  }

  private createScreenshotMetadata(
    viewport: ViewportSize,
    screenshot: ScreenshotDimensions,
  ) {
    const screenshotToViewportX = viewport.width / screenshot.width;
    const screenshotToViewportY = viewport.height / screenshot.height;

    return {
      screenshot: {
        width: screenshot.width,
        height: screenshot.height,
      },
      viewport: {
        width: viewport.width,
        height: viewport.height,
      },
      scale: {
        screenshotToViewportX,
        screenshotToViewportY,
        viewportToScreenshotX: screenshot.width / viewport.width,
        viewportToScreenshotY: screenshot.height / viewport.height,
      },
      coordinateSpace: "screenshot",
    };
  }

  private async evaluate(
    tabId: number,
    expression: string,
    awaitPromise: boolean,
  ): Promise<void> {
    await cdpManager.sendCommand(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
  }

  private async withVisualIndicatorHidden<T>(
    tabId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    let wasVisible = false;
    try {
      const resp = (await chrome.tabs.sendMessage(tabId, {
        action: "pre_screenshot",
      })) as { wasVisible?: boolean } | undefined;
      wasVisible = resp?.wasVisible ?? false;
    } catch {
      // Content script may not be injected - input dispatch can still proceed.
    }

    try {
      return await fn();
    } finally {
      if (wasVisible) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            action: "post_screenshot",
            wasVisible: true,
          });
        } catch {
          // Ignore - content script might not be present anymore.
        }
      }
    }
  }

  private extractPointPath(
    args: Record<string, unknown>,
  ): Array<{ x: number; y: number }> | null {
    if (!Array.isArray(args.points)) return null;

    const points: Array<{ x: number; y: number }> = [];
    for (const value of args.points.slice(0, MAX_MOVE_PATH_POINTS)) {
      if (!value || typeof value !== "object") return null;
      const point = value as Record<string, unknown>;
      if (typeof point.x !== "number" || typeof point.y !== "number") return null;
      points.push({ x: point.x, y: point.y });
    }

    return points.length > 0 ? points : null;
  }

  private async performClickSequence(
    tabId: number,
    x: number,
    y: number,
    button: "left" | "right",
    clickCount: number,
    repeatCount: number,
  ): Promise<void> {
    await dispatchMouseEvent(tabId, "mouseMoved", x, y);

    for (let i = 0; i < repeatCount; i++) {
      await dispatchMouseEvent(tabId, "mousePressed", x, y, button, clickCount);
      await sleep(CLICK_DELAY_MS);
      await dispatchMouseEvent(tabId, "mouseReleased", x, y, button, clickCount);
    }
  }

  private formatClickMessage(
    button: "left" | "right",
    clickCount: number,
    repeatCount: number,
    target: string,
  ): string {
    const action = button === "right" ? "Right-clicked" : clickCount === 2 ? "Double-clicked" : "Clicked";
    if (repeatCount === 1) return `${action} ${target}`;
    return `${action} ${repeatCount} times ${target}`;
  }

  /**
   * Convert screenshot coordinates to viewport coordinates.
   * Falls back to identity mapping if no screenshot has been taken yet.
   */
  private toViewport(
    x: number,
    y: number,
    viewport: ViewportSize,
  ): { x: number; y: number } {
    if (!this.lastScreenshotDims) {
      // No screenshot taken yet - assume 1:1 mapping
      return { x, y };
    }
    return mapCoords(x, y, viewport, this.lastScreenshotDims);
  }

  private success(message: string): ToolResult {
    return {
      success: true,
      content: [{ type: "text", text: message }],
    };
  }

  private error(message: string): ToolResult {
    return {
      success: false,
      content: [{ type: "text", text: message }],
    };
  }
}
