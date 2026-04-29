import { describe, expect, it } from "vitest";

import {
  buildKeySteps,
  buildMouseInputPlan,
  buildTextFallbackSteps,
  mapMousePoint,
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
});
