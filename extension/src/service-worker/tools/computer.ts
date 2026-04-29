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
 *
 * Coordinate system:
 *   All (x, y) values refer to positions in the most recently captured screenshot.
 *   The coordinateMapper translates these to viewport coordinates for CDP dispatch.
 */

import type { ToolHandler, ToolResult, ToolContext } from "../../types/messages.js";
import { cdpManager } from "../cdp.js";
import {
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
  | "move";

type ScrollDirection = "up" | "down" | "left" | "right";

/** Pixels to scroll per "click" of the wheel */
const SCROLL_AMOUNT = 100;

/** Delay between mousePressed and mouseReleased for clicks (ms) */
const CLICK_DELAY_MS = 50;

/** Delay between drag steps (ms) */
const DRAG_STEP_DELAY_MS = 16;

/** Number of intermediate steps in a drag operation */
const DRAG_STEPS = 10;

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
  const { modifiers, baseKey } = parseKeyCombo(keyStr);

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
      ...(keyDef.text ? { text: keyDef.text } : {}),
    });

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
      modifiers,
    });
  } else if (baseKey.length === 1) {
    // Single character key
    const char = baseKey;
    const upper = char.toUpperCase();
    const keyCode = upper.charCodeAt(0);

    await cdpManager.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: char,
      code: `Key${upper}`,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      text: char,
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
  } else {
    throw new Error(`Unknown key: "${baseKey}"`);
  }
}

/**
 * Dispatch a mouse event at viewport coordinates.
 */
async function dispatchMouseEvent(
  tabId: number,
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
  clickCount = 1,
  modifiers = 0,
): Promise<void> {
  // CDP button enum: left=0, middle=1, right=2
  const buttonMap = { left: "left", middle: "middle", right: "right" } as const;

  await cdpManager.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: buttonMap[button],
    clickCount,
    modifiers,
    // buttons bitmask: 1=left, 2=right, 4=middle
    ...(type === "mousePressed" || type === "mouseMoved"
      ? {
          buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
        }
      : {}),
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
    try {
      const action = args.action as Action | undefined;
      if (!action) {
        return this.error("Missing required argument: action");
      }

      const tabId = args.tabId as number | undefined;
      if (typeof tabId !== "number") {
        return this.error("Missing required argument: tabId (number)");
      }

      // Ensure CDP is attached
      if (!cdpManager.isAttached(tabId)) {
        await cdpManager.attach(tabId);
      }

      switch (action) {
        case "screenshot":
          return await this.screenshot(tabId);
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
        default:
          return this.error(
            `Unknown action: "${action}". Valid actions: screenshot, click, double_click, right_click, type, key, scroll, drag, move`,
          );
      }
    } catch (error) {
      return this.error(
        `computer tool failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- Actions ---

  private async screenshot(tabId: number): Promise<ToolResult> {
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
      const { data, dimensions } = await cdpManager.captureScreenshot(tabId, {
        format: "jpeg",
        quality: 80,
      });

      // Store dimensions for coordinate mapping in subsequent actions
      this.lastScreenshotDims = dimensions;

      return {
        success: true,
        content: [
          {
            type: "image",
            data,
            mimeType: "image/jpeg",
          },
          {
            type: "text",
            text: JSON.stringify({
              screenshot: {
                width: dimensions.width,
                height: dimensions.height,
              },
            }),
          },
        ],
      };
    } finally {
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
    let coords = this.extractCoords(args);

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
          const viewport = await getViewportSize(tabId);
          await dispatchMouseEvent(tabId, "mouseMoved", coords.x, coords.y);
          await dispatchMouseEvent(tabId, "mousePressed", coords.x, coords.y, button, clickCount);
          await sleep(CLICK_DELAY_MS);
          await dispatchMouseEvent(tabId, "mouseReleased", coords.x, coords.y, button, clickCount);
          return this.success(
            `${button === "right" ? "Right-clicked" : clickCount === 2 ? "Double-clicked" : "Clicked"} element ${args.ref} at (${coords.x}, ${coords.y})`,
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

    // Move to position first
    await dispatchMouseEvent(
      tabId,
      "mouseMoved",
      viewportCoords.x,
      viewportCoords.y,
    );

    // Press
    await dispatchMouseEvent(
      tabId,
      "mousePressed",
      viewportCoords.x,
      viewportCoords.y,
      button,
      clickCount,
    );

    await sleep(CLICK_DELAY_MS);

    // Release
    await dispatchMouseEvent(
      tabId,
      "mouseReleased",
      viewportCoords.x,
      viewportCoords.y,
      button,
      clickCount,
    );

    return this.success(
      `${button === "right" ? "Right-clicked" : clickCount === 2 ? "Double-clicked" : "Clicked"} at (${coords.x}, ${coords.y})`,
    );
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

  // --- Utilities ---

  private extractCoords(
    args: Record<string, unknown>,
  ): { x: number; y: number } | null {
    if (typeof args.x === "number" && typeof args.y === "number") {
      return { x: args.x, y: args.y };
    }
    return null;
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
