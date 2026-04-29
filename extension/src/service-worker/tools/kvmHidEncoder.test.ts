import { describe, expect, it } from "vitest";
import {
  HID_KEY,
  HID_MOUSE_BUTTON,
  HID_MOUSE_MOVE,
  HID_MOUSE_RELATIVE,
  HID_MOUSE_WHEEL,
  COORD_MIN,
  COORD_MAX,
  clampInt8,
  encodeInt16BE,
  encodeKeyEvent,
  encodeMouseButton,
  encodeMouseMove,
  encodeMouseRelative,
  encodeMouseWheel,
  mapToAbsolute,
} from "./kvmHidEncoder.js";

// ---------------------------------------------------------------------------
// Helper: read a signed 8-bit value from an unsigned byte
// ---------------------------------------------------------------------------
function toInt8(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}

// ---------------------------------------------------------------------------
// clampInt8
// ---------------------------------------------------------------------------
describe("clampInt8", () => {
  it("passes values within range", () => {
    expect(clampInt8(0)).toBe(0);
    expect(clampInt8(50)).toBe(50);
    expect(clampInt8(-50)).toBe(-50);
    expect(clampInt8(127)).toBe(127);
    expect(clampInt8(-128)).toBe(-128);
  });

  it("clamps values above 127", () => {
    expect(clampInt8(128)).toBe(127);
    expect(clampInt8(255)).toBe(127);
    expect(clampInt8(1000)).toBe(127);
  });

  it("clamps values below -128", () => {
    expect(clampInt8(-129)).toBe(-128);
    expect(clampInt8(-256)).toBe(-128);
    expect(clampInt8(-1000)).toBe(-128);
  });

  it("rounds fractional values", () => {
    expect(clampInt8(1.4)).toBe(1);
    expect(clampInt8(1.6)).toBe(2);
    expect(clampInt8(-0.5)).toBe(-0); // Math.round(-0.5) === -0 in JS
  });
});

// ---------------------------------------------------------------------------
// encodeInt16BE
// ---------------------------------------------------------------------------
describe("encodeInt16BE", () => {
  it("encodes zero", () => {
    expect(encodeInt16BE(0)).toEqual([0x00, 0x00]);
  });

  it("encodes positive values", () => {
    expect(encodeInt16BE(1)).toEqual([0x00, 0x01]);
    expect(encodeInt16BE(256)).toEqual([0x01, 0x00]);
    expect(encodeInt16BE(32767)).toEqual([0x7f, 0xff]);
  });

  it("encodes negative values as two's complement", () => {
    // -1 = 0xFFFF
    expect(encodeInt16BE(-1)).toEqual([0xff, 0xff]);
    // -32768 = 0x8000
    expect(encodeInt16BE(-32768)).toEqual([0x80, 0x00]);
    // -256 = 0xFF00
    expect(encodeInt16BE(-256)).toEqual([0xff, 0x00]);
  });
});

// ---------------------------------------------------------------------------
// encodeKeyEvent
// ---------------------------------------------------------------------------
describe("encodeKeyEvent", () => {
  it("encodes a key-down event", () => {
    const packet = encodeKeyEvent("KeyA", true);
    expect(packet[0]).toBe(HID_KEY);
    expect(packet[1]).toBe(1); // down
    // Remaining bytes are ASCII "KeyA"
    const name = new TextDecoder().decode(packet.slice(2));
    expect(name).toBe("KeyA");
  });

  it("encodes a key-up event", () => {
    const packet = encodeKeyEvent("Enter", false);
    expect(packet[0]).toBe(HID_KEY);
    expect(packet[1]).toBe(0); // up
    const name = new TextDecoder().decode(packet.slice(2));
    expect(name).toBe("Enter");
  });

  it("encodes modifier key names", () => {
    const packet = encodeKeyEvent("ShiftLeft", true);
    expect(packet[0]).toBe(HID_KEY);
    expect(packet[1]).toBe(1);
    expect(packet.length).toBe(2 + "ShiftLeft".length);
    const name = new TextDecoder().decode(packet.slice(2));
    expect(name).toBe("ShiftLeft");
  });

  it("has correct total length", () => {
    const packet = encodeKeyEvent("F12", true);
    expect(packet.length).toBe(2 + 3); // header + "F12"
  });
});

// ---------------------------------------------------------------------------
// encodeMouseButton
// ---------------------------------------------------------------------------
describe("encodeMouseButton", () => {
  it("encodes left button down", () => {
    const packet = encodeMouseButton("left", true);
    expect(packet[0]).toBe(HID_MOUSE_BUTTON);
    expect(packet[1]).toBe(1);
    const name = new TextDecoder().decode(packet.slice(2));
    expect(name).toBe("left");
  });

  it("encodes right button up", () => {
    const packet = encodeMouseButton("right", false);
    expect(packet[0]).toBe(HID_MOUSE_BUTTON);
    expect(packet[1]).toBe(0);
    const name = new TextDecoder().decode(packet.slice(2));
    expect(name).toBe("right");
  });

  it("encodes middle button", () => {
    const packet = encodeMouseButton("middle", true);
    const name = new TextDecoder().decode(packet.slice(2));
    expect(name).toBe("middle");
  });

  it("encodes scroll buttons (up/down)", () => {
    const up = encodeMouseButton("up", true);
    expect(new TextDecoder().decode(up.slice(2))).toBe("up");

    const down = encodeMouseButton("down", true);
    expect(new TextDecoder().decode(down.slice(2))).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// encodeMouseMove (absolute)
// ---------------------------------------------------------------------------
describe("encodeMouseMove", () => {
  it("encodes center (0, 0)", () => {
    const packet = encodeMouseMove(0, 0);
    expect(packet.length).toBe(5);
    expect(packet[0]).toBe(HID_MOUSE_MOVE);
    expect(packet[1]).toBe(0x00); // x high
    expect(packet[2]).toBe(0x00); // x low
    expect(packet[3]).toBe(0x00); // y high
    expect(packet[4]).toBe(0x00); // y low
  });

  it("encodes max positive (32767, 32767)", () => {
    const packet = encodeMouseMove(COORD_MAX, COORD_MAX);
    expect(packet[1]).toBe(0x7f);
    expect(packet[2]).toBe(0xff);
    expect(packet[3]).toBe(0x7f);
    expect(packet[4]).toBe(0xff);
  });

  it("encodes min negative (-32768, -32768)", () => {
    const packet = encodeMouseMove(COORD_MIN, COORD_MIN);
    expect(packet[1]).toBe(0x80);
    expect(packet[2]).toBe(0x00);
    expect(packet[3]).toBe(0x80);
    expect(packet[4]).toBe(0x00);
  });

  it("encodes mixed sign coordinates", () => {
    const packet = encodeMouseMove(-1, 256);
    // -1 -> 0xFFFF
    expect(packet[1]).toBe(0xff);
    expect(packet[2]).toBe(0xff);
    // 256 -> 0x0100
    expect(packet[3]).toBe(0x01);
    expect(packet[4]).toBe(0x00);
  });
});

// ---------------------------------------------------------------------------
// encodeMouseRelative
// ---------------------------------------------------------------------------
describe("encodeMouseRelative", () => {
  it("encodes a single delta (squash=0)", () => {
    const packet = encodeMouseRelative([{ dx: 5, dy: -3 }]);
    expect(packet.length).toBe(4);
    expect(packet[0]).toBe(HID_MOUSE_RELATIVE);
    expect(packet[1]).toBe(0); // no squash
    expect(packet[2]).toBe(5); // dx
    expect(toInt8(packet[3])).toBe(-3); // dy as signed
  });

  it("encodes multiple deltas with squash=1", () => {
    const packet = encodeMouseRelative([
      { dx: 10, dy: -10 },
      { dx: -5, dy: 20 },
    ]);
    expect(packet.length).toBe(6); // 2 header + 2*2 data
    expect(packet[0]).toBe(HID_MOUSE_RELATIVE);
    expect(packet[1]).toBe(1); // squash
    expect(packet[2]).toBe(10);
    expect(toInt8(packet[3])).toBe(-10);
    expect(toInt8(packet[4])).toBe(-5);
    expect(packet[5]).toBe(20);
  });

  it("clamps deltas to Int8 range", () => {
    const packet = encodeMouseRelative([{ dx: 200, dy: -200 }]);
    expect(packet[2]).toBe(127); // clamped from 200
    expect(toInt8(packet[3])).toBe(-128); // clamped from -200
  });

  it("throws on empty deltas", () => {
    expect(() => encodeMouseRelative([])).toThrow(
      "At least one delta pair is required",
    );
  });

  it("encodes three deltas for squash batch", () => {
    const packet = encodeMouseRelative([
      { dx: 1, dy: 2 },
      { dx: 3, dy: 4 },
      { dx: 5, dy: 6 },
    ]);
    expect(packet.length).toBe(8); // 2 + 3*2
    expect(packet[1]).toBe(1); // squash
    expect(packet[2]).toBe(1);
    expect(packet[3]).toBe(2);
    expect(packet[4]).toBe(3);
    expect(packet[5]).toBe(4);
    expect(packet[6]).toBe(5);
    expect(packet[7]).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// encodeMouseWheel
// ---------------------------------------------------------------------------
describe("encodeMouseWheel", () => {
  it("encodes a single scroll event (squash=0)", () => {
    const packet = encodeMouseWheel([{ dx: 0, dy: -1 }]);
    expect(packet.length).toBe(4);
    expect(packet[0]).toBe(HID_MOUSE_WHEEL);
    expect(packet[1]).toBe(0);
    expect(packet[2]).toBe(0); // dx
    expect(toInt8(packet[3])).toBe(-1); // dy
  });

  it("encodes batched scroll events (squash=1)", () => {
    const packet = encodeMouseWheel([
      { dx: 0, dy: -1 },
      { dx: 0, dy: -1 },
    ]);
    expect(packet.length).toBe(6);
    expect(packet[0]).toBe(HID_MOUSE_WHEEL);
    expect(packet[1]).toBe(1); // squash
  });

  it("clamps large wheel deltas", () => {
    const packet = encodeMouseWheel([{ dx: 0, dy: -500 }]);
    expect(toInt8(packet[3])).toBe(-128);
  });

  it("throws on empty deltas", () => {
    expect(() => encodeMouseWheel([])).toThrow(
      "At least one delta pair is required",
    );
  });
});

// ---------------------------------------------------------------------------
// mapToAbsolute
// ---------------------------------------------------------------------------
describe("mapToAbsolute", () => {
  it("maps origin (pos=0, offset=0) to COORD_MIN", () => {
    // At position 0 of a 1920-wide viewport -> -32768
    expect(mapToAbsolute(0, 0, 1920)).toBe(COORD_MIN);
  });

  it("maps end of viewport to COORD_MAX", () => {
    // At position=size -> max
    expect(mapToAbsolute(1920, 0, 1920)).toBe(COORD_MAX);
  });

  it("maps center of viewport to ~0", () => {
    // At midpoint -> should be approximately 0 (midpoint of range)
    const result = mapToAbsolute(960, 0, 1920);
    // (960/1920) * 65535 - 32768 = 32767.5 - 32768 = -0.5 -> round -> -0
    // -0 is equivalent to 0 in binary encoding; both produce 0x0000
    expect(result).toBe(-0);
  });

  it("accounts for letterbox offset", () => {
    // With offset=100, pos=100 should be the left edge (COORD_MIN)
    expect(mapToAbsolute(100, 100, 1920)).toBe(COORD_MIN);
  });

  it("clamps to COORD_MIN when pos is before offset", () => {
    // pos < offset -> negative ratio -> below COORD_MIN -> clamped
    const result = mapToAbsolute(0, 100, 1920);
    expect(result).toBe(COORD_MIN);
  });

  it("clamps to COORD_MAX when pos exceeds range", () => {
    // pos = offset + size + extra -> ratio > 1 -> above COORD_MAX -> clamped
    const result = mapToAbsolute(2200, 0, 1920);
    expect(result).toBe(COORD_MAX);
  });

  it("throws on zero size", () => {
    expect(() => mapToAbsolute(0, 0, 0)).toThrow("Size must be positive");
  });

  it("throws on negative size", () => {
    expect(() => mapToAbsolute(0, 0, -100)).toThrow("Size must be positive");
  });
});
