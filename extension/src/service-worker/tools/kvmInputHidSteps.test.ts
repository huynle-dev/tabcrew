import { describe, expect, it } from "vitest";

import {
  buildKeySteps,
  buildMouseInputPlan,
  buildTextFallbackSteps,
  mapMousePoint,
  resolveMouseInputCoordinates,
  resolveKvmdKeyName,
} from "./kvmInputHidSteps.js";

function toInt8(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}

function decodeButtonPacket(packet: Uint8Array): {
  down: boolean;
  button: string;
} {
  return {
    down: packet[1] === 1,
    button: new TextDecoder().decode(packet.slice(2)),
  };
}

describe("kvmInputHidSteps", () => {
  it("builds reusable hotkey steps with reverse key release order", () => {
    expect(buildKeySteps("ctrl+alt+delete", "hotkey")).toEqual([
      { key: "ControlLeft", down: true },
      { key: "AltLeft", down: true },
      { key: "Delete", down: true },
      { key: "Delete", down: false },
      { key: "AltLeft", down: false },
      { key: "ControlLeft", down: false },
    ]);

    expect(buildKeySteps("ShiftLeft", "down")).toEqual([
      { key: "ShiftLeft", down: true },
    ]);
    expect(buildKeySteps("ShiftLeft", "up")).toEqual([
      { key: "ShiftLeft", down: false },
    ]);
  });

  it("builds reusable text fallback key steps for simple characters", () => {
    expect(buildTextFallbackSteps("a 2\n\t")).toEqual([
      { key: "KeyA", down: true },
      { key: "KeyA", down: false },
      { key: "Space", down: true },
      { key: "Space", down: false },
      { key: "Digit2", down: true },
      { key: "Digit2", down: false },
      { key: "Enter", down: true },
      { key: "Enter", down: false },
      { key: "Tab", down: true },
      { key: "Tab", down: false },
    ]);

    expect(() => buildTextFallbackSteps("!")).toThrow(
      "cannot be typed through key-event fallback",
    );
  });

  it("maps key aliases and screenshot mouse points for reuse", () => {
    expect(resolveKvmdKeyName("cmd")).toBe("MetaLeft");
    expect(mapMousePoint({ x: 480, y: 270 }, { width: 960, height: 540 })).toEqual(
      { x: 480, y: 270, absoluteX: 0, absoluteY: 0 },
    );
  });

  it("builds reusable mouse click and scroll HID packet plans", () => {
    const click = buildMouseInputPlan({
      action: "click",
      point: { x: 480, y: 270 },
      size: { width: 960, height: 540 },
      button: "right",
    });

    expect(click.packets).toHaveLength(3);
    expect(click.packets[0][0]).toBe(0x03);
    expect(decodeButtonPacket(click.packets[1])).toEqual({
      down: true,
      button: "right",
    });
    expect(decodeButtonPacket(click.packets[2])).toEqual({
      down: false,
      button: "right",
    });
    expect(click.response).toMatchObject({
      action: "click",
      button: "right",
      coordinates: {
        screenshot: { x: 480, y: 270, width: 960, height: 540 },
        absolute: { x: 0, y: 0 },
      },
    });

    const scroll = buildMouseInputPlan({
      action: "scroll",
      direction: "down",
      amount: 3,
    });

    expect(scroll.packets).toHaveLength(1);
    expect(scroll.packets[0][0]).toBe(0x05);
    expect(toInt8(scroll.packets[0][3])).toBe(-3);
    expect(scroll.response).toEqual({
      action: "scroll",
      direction: "down",
      amount: 3,
    });
  });

  it("maps crop-relative downscaled screenshot pixels back to intrinsic frame pixels", () => {
    const frame = {
      frameId: "frame-crop-downscale",
      capturedAt: "2026-04-30T12:00:00.000Z",
      tabId: 42,
      source: {
        width: 1920,
        height: 1080,
        coordinateSpace: "intrinsic_remote_frame_pixels" as const,
      },
      crop: {
        x: 100,
        y: 50,
        width: 800,
        height: 450,
        coordinateSpace: "intrinsic_remote_frame_pixels" as const,
      },
      output: {
        width: 400,
        height: 225,
        coordinateSpace: "glkvm_screenshot_pixels" as const,
      },
    };

    const plan = buildMouseInputPlan({
      action: "click",
      point: { x: 200, y: 112.5 },
      size: { width: 400, height: 225 },
      coordinateSpace: "glkvm_screenshot_pixels",
      frame,
    });

    expect(plan.response.coordinates).toMatchObject({
      input: {
        coordinateSpace: "glkvm_screenshot_pixels",
        point: { x: 200, y: 112.5 },
        frameId: "frame-crop-downscale",
      },
      intrinsic: { x: 500, y: 275, width: 1920, height: 1080 },
      screenshot: { x: 200, y: 112.5, width: 400, height: 225 },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "mapped_from_screenshot_output",
          frameId: "frame-crop-downscale",
        }),
      ]),
    });
    expect(plan.response.coordinates).toMatchObject({
      absolute: { x: expect.any(Number), y: expect.any(Number) },
    });
  });

  it("maps normalized remote-frame boundaries and clamps out-of-bounds points with diagnostics", () => {
    expect(
      resolveMouseInputCoordinates({
        point: { x: 1, y: 0 },
        size: { width: 1920, height: 1080 },
        coordinateSpace: "normalized_remote_frame",
      }),
    ).toMatchObject({
      intrinsic: { x: 1920, y: 0 },
      normalized: { x: 1, y: 0 },
      diagnostics: [],
    });

    const outOfBounds = buildMouseInputPlan({
      action: "move",
      point: { x: 1.25, y: -0.5 },
      size: { width: 1920, height: 1080 },
      coordinateSpace: "normalized_remote_frame",
    });

    expect(outOfBounds.response.coordinates).toMatchObject({
      input: {
        coordinateSpace: "normalized_remote_frame",
        point: { x: 1.25, y: -0.5 },
      },
      intrinsic: { x: 1920, y: 0, width: 1920, height: 1080 },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "coordinate_clamped",
          axis: "x",
          input: 2400,
          output: 1920,
        }),
        expect.objectContaining({
          code: "coordinate_clamped",
          axis: "y",
          input: -540,
          output: 0,
        }),
      ]),
    });
  });

  it("rejects screenshot coordinates without a matching frame descriptor", () => {
    expect(() =>
      buildMouseInputPlan({
        action: "move",
        point: { x: 10, y: 10 },
        size: { width: 400, height: 225 },
        coordinateSpace: "glkvm_screenshot_pixels",
        frameId: "missing-frame",
      }),
    ).toThrow("Unknown or stale GLKVM frameId missing-frame");
  });
});
