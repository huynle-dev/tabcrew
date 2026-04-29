/**
 * Binary packet encoders for GLKVM/KVMD HID WebSocket events.
 *
 * Protocol reference: docs/plans/glkvm-control-protocol.md § 2 "HID Packet Formats"
 * All packets are sent as Uint8Array via WebSocket in binary mode.
 *
 * Packet types:
 *   0x01 - Keyboard key (down/up)
 *   0x02 - Mouse button (down/up)
 *   0x03 - Mouse move (absolute, signed 16-bit coordinates)
 *   0x04 - Mouse relative move (signed 8-bit deltas, optional squash)
 *   0x05 - Mouse wheel (signed 8-bit deltas, optional squash)
 */

// --- Constants ---

/** Packet type identifiers */
export const HID_KEY = 0x01;
export const HID_MOUSE_BUTTON = 0x02;
export const HID_MOUSE_MOVE = 0x03;
export const HID_MOUSE_RELATIVE = 0x04;
export const HID_MOUSE_WHEEL = 0x05;

/** Signed 16-bit range for absolute mouse coordinates */
export const COORD_MIN = -32768;
export const COORD_MAX = 32767;

/** Signed 8-bit range for relative deltas */
const INT8_MIN = -128;
const INT8_MAX = 127;

// --- Helpers ---

/** Clamp a value to signed 8-bit range [-128, 127]. */
export function clampInt8(value: number): number {
  if (value < INT8_MIN) return INT8_MIN;
  if (value > INT8_MAX) return INT8_MAX;
  return Math.round(value);
}

/**
 * Encode a signed 16-bit value as two bytes (big-endian).
 * The value is treated as unsigned for byte extraction:
 * the bit pattern of -1 (0xFFFF) yields [0xFF, 0xFF].
 */
export function encodeInt16BE(value: number): [number, number] {
  // Mask to 16-bit unsigned for correct byte extraction
  const u16 = value & 0xffff;
  return [(u16 >> 8) & 0xff, u16 & 0xff];
}

// --- Encoders ---

/**
 * Encode a keyboard key event.
 *
 * Format:
 *   Byte 0: 0x01
 *   Byte 1: state (1 = down, 0 = up)
 *   Byte 2+: ASCII-encoded key name (e.g. "KeyA", "ShiftLeft", "Enter")
 */
export function encodeKeyEvent(
  keyName: string,
  down: boolean,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(keyName);
  const packet = new Uint8Array(2 + nameBytes.length);
  packet[0] = HID_KEY;
  packet[1] = down ? 1 : 0;
  packet.set(nameBytes, 2);
  return packet;
}

/**
 * Encode a mouse button event.
 *
 * Format:
 *   Byte 0: 0x02
 *   Byte 1: state (1 = down, 0 = up)
 *   Byte 2+: ASCII-encoded button name ("left", "middle", "right", "up", "down")
 */
export function encodeMouseButton(
  button: "left" | "middle" | "right" | "up" | "down",
  down: boolean,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(button);
  const packet = new Uint8Array(2 + nameBytes.length);
  packet[0] = HID_MOUSE_BUTTON;
  packet[1] = down ? 1 : 0;
  packet.set(nameBytes, 2);
  return packet;
}

/**
 * Encode an absolute mouse move event.
 *
 * Coordinates are in the KVMD signed range [-32768, 32767].
 * Use {@link mapToAbsolute} to convert viewport-relative positions.
 *
 * Format:
 *   Byte 0: 0x03
 *   Byte 1: x >> 8
 *   Byte 2: x & 0xFF
 *   Byte 3: y >> 8
 *   Byte 4: y & 0xFF
 */
export function encodeMouseMove(x: number, y: number): Uint8Array {
  const [xHi, xLo] = encodeInt16BE(x);
  const [yHi, yLo] = encodeInt16BE(y);
  return new Uint8Array([HID_MOUSE_MOVE, xHi, xLo, yHi, yLo]);
}

/**
 * Encode a relative mouse move event.
 *
 * Deltas are clamped to signed 8-bit range [-128, 127].
 *
 * Format (single):
 *   Byte 0: 0x04
 *   Byte 1: 0 (squash=false)
 *   Byte 2: delta_x (Int8)
 *   Byte 3: delta_y (Int8)
 *
 * Format (squashed / batched):
 *   Byte 0: 0x04
 *   Byte 1: 1 (squash=true)
 *   Byte 2+: pairs of [delta_x, delta_y] (each Int8)
 */
export function encodeMouseRelative(
  deltas: Array<{ dx: number; dy: number }>,
): Uint8Array {
  if (deltas.length === 0) {
    throw new Error("At least one delta pair is required");
  }

  const squash = deltas.length > 1;
  const packet = new Uint8Array(2 + deltas.length * 2);
  packet[0] = HID_MOUSE_RELATIVE;
  packet[1] = squash ? 1 : 0;

  for (let i = 0; i < deltas.length; i++) {
    // Clamp and write as unsigned byte (Int8 bit pattern)
    packet[2 + i * 2] = clampInt8(deltas[i].dx) & 0xff;
    packet[3 + i * 2] = clampInt8(deltas[i].dy) & 0xff;
  }

  return packet;
}

/**
 * Encode a mouse wheel event.
 *
 * Deltas are clamped to signed 8-bit range [-128, 127].
 *
 * Format:
 *   Byte 0: 0x05
 *   Byte 1: squash flag
 *   Byte 2: delta_x (Int8)
 *   Byte 3: delta_y (Int8)
 *   (if squash=1, additional [dx, dy] pairs follow)
 */
export function encodeMouseWheel(
  deltas: Array<{ dx: number; dy: number }>,
): Uint8Array {
  if (deltas.length === 0) {
    throw new Error("At least one delta pair is required");
  }

  const squash = deltas.length > 1;
  const packet = new Uint8Array(2 + deltas.length * 2);
  packet[0] = HID_MOUSE_WHEEL;
  packet[1] = squash ? 1 : 0;

  for (let i = 0; i < deltas.length; i++) {
    packet[2 + i * 2] = clampInt8(deltas[i].dx) & 0xff;
    packet[3 + i * 2] = clampInt8(deltas[i].dy) & 0xff;
  }

  return packet;
}

/**
 * Map a viewport-relative position to KVMD absolute coordinate range.
 *
 * KVMD uses signed 16-bit range [-32768, 32767].
 * Formula: value = round((pos - offset) / size * 65535 + (-32768))
 *
 * @param pos    - Current position in viewport pixels
 * @param offset - Letterbox offset in viewport pixels
 * @param size   - Viewport dimension in pixels (width or height)
 * @returns Signed 16-bit coordinate in [-32768, 32767]
 */
export function mapToAbsolute(
  pos: number,
  offset: number,
  size: number,
): number {
  if (size <= 0) {
    throw new Error("Size must be positive");
  }
  const raw = Math.round(
    ((pos - offset) / size) * (COORD_MAX - COORD_MIN) + COORD_MIN,
  );
  // Clamp to valid range
  if (raw < COORD_MIN) return COORD_MIN;
  if (raw > COORD_MAX) return COORD_MAX;
  return raw;
}
