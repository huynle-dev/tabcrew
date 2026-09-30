import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The module registers a chrome.runtime listener at import time, so `chrome`
// must exist before it loads. Imports are hoisted, hence the dynamic import.
let OBSERVED_INPUT_EVENTS: readonly string[];
let OVERLAY_STYLE_DECLARATIONS: readonly string[];

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
  });
  const mod = await import("./visualIndicator.js");
  OBSERVED_INPUT_EVENTS = mod.OBSERVED_INPUT_EVENTS;
  OVERLAY_STYLE_DECLARATIONS = mod.OVERLAY_STYLE_DECLARATIONS;
});

/**
 * Regression tests for the automation indicator blocking the automation.
 *
 * The indicator used to install capture-phase `stopImmediatePropagation()`
 * handlers on window for click/keydown/mousedown/etc., and gave its
 * full-viewport border `pointer-events: auto`.
 *
 * Events synthesized by CDP (Input.dispatchMouseEvent /
 * Input.dispatchKeyEvent) arrive with isTrusted === true, so they are
 * indistinguishable from human input and were blocked along with it. The
 * observable result was that `computer key Enter` reported success while no
 * keydown ever reached the focused field, making form submission impossible,
 * and `click` only moved focus when it raced ahead of the overlay mount.
 *
 * These tests exist because the module had no test file, which is how the
 * bug survived.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("./visualIndicator.ts", import.meta.url)),
  "utf8",
);

/** Strip block and line comments so prose cannot satisfy a code assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("overlay must not intercept input", () => {
  it("declares pointer-events: none", () => {
    expect(OVERLAY_STYLE_DECLARATIONS).toContain("pointer-events: none");
  });

  it("never declares pointer-events: auto", () => {
    // The overlay spans the viewport at max z-index; `auto` swallows every
    // click the agent dispatches.
    expect(OVERLAY_STYLE_DECLARATIONS).not.toContain("pointer-events: auto");
  });

  it("still covers the viewport at max z-index (indicator remains visible)", () => {
    // The fix must not have been achieved by shrinking or hiding the
    // indicator — it is a safety affordance and must stay visible.
    expect(OVERLAY_STYLE_DECLARATIONS).toContain("position: fixed");
    expect(OVERLAY_STYLE_DECLARATIONS).toContain("z-index: 2147483647");
    for (const side of ["top: 0", "left: 0", "right: 0", "bottom: 0"]) {
      expect(OVERLAY_STYLE_DECLARATIONS).toContain(side);
    }
  });
});

describe("input observation scope", () => {
  it("observes only keydown", () => {
    expect([...OBSERVED_INPUT_EVENTS]).toEqual(["keydown"]);
  });

  it("does not observe mouse or pointer events", () => {
    const forbidden = [
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
      "mousedown",
      "mouseup",
      "mousemove",
      "pointerdown",
      "pointerup",
      "pointermove",
      "wheel",
      "touchstart",
      "touchend",
      "touchmove",
    ];
    for (const evt of forbidden) {
      expect([...OBSERVED_INPUT_EVENTS]).not.toContain(evt);
    }
  });

  it("does not observe keypress or keyup", () => {
    expect([...OBSERVED_INPUT_EVENTS]).not.toContain("keypress");
    expect([...OBSERVED_INPUT_EVENTS]).not.toContain("keyup");
  });
});

describe("stop hotkey is preserved", () => {
  it("still handles Escape to stop automation", () => {
    expect(SOURCE).toMatch(/key === 'Escape'/);
    expect(SOURCE).toMatch(/stopAutomation\(\)/);
  });

  it("only calls stopImmediatePropagation inside the Escape branch", () => {
    // A blanket swallow anywhere else reintroduces the bug. Count call sites
    // in code only — the file header documents the old behaviour in prose.
    const code = stripComments(SOURCE);
    const calls = code.match(/stopImmediatePropagation\(\)/g) ?? [];
    expect(calls).toHaveLength(1);

    const handler = code.slice(
      code.indexOf("function handleStopHotkey"),
      code.indexOf("function installInputBlockers"),
    );
    expect(handler).toMatch(/Escape/);
    expect(handler).toMatch(/stopImmediatePropagation/);
  });

  it("has no blanket preventDefault outside the Escape branch", () => {
    const code = stripComments(SOURCE);
    const handler = code.slice(
      code.indexOf("function handleStopHotkey"),
      code.indexOf("function installInputBlockers"),
    );
    // Exactly one preventDefault, for Escape.
    expect(handler.match(/preventDefault\(\)/g) ?? []).toHaveLength(1);
  });
});
