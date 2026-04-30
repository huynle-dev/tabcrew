import { beforeEach, describe, expect, it, vi } from "vitest";

const cdpManagerMock = vi.hoisted(() => ({
  isAttached: vi.fn(),
  attach: vi.fn(),
  sendCommand: vi.fn(),
}));

const glkvmTabMock = vi.hoisted(() => ({
  getVideoMetadata: vi.fn(),
  resolveGlkvmTab: vi.fn(),
  requireOwnedGlkvmTabForDirectControl: vi.fn(),
}));

const transportMock = vi.hoisted(() => ({
  cleanupSession: vi.fn(),
  connect: vi.fn(),
  pasteText: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../cdp.js", () => ({
  cdpManager: cdpManagerMock,
}));

vi.mock("../glkvmTab.js", () => glkvmTabMock);
vi.mock("./kvmHidTransport.js", () => transportMock);

const { GlkvmInputTool, resolveKvmdKeyName } = await import("./kvmInput.js");
const { captureGlkvmFrame, clearGlkvmFrameCacheForTests } = await import("./glkvmFrame.js");

function mockCanvasCapture(data: string, width: number, height: number) {
  cdpManagerMock.sendCommand.mockResolvedValueOnce({
    result: {
      type: "object",
      value: { data, width, height },
    },
  });
}

function decodeKeyPacket(packet: Uint8Array): { down: boolean; key: string } {
  return {
    down: packet[1] === 1,
    key: new TextDecoder().decode(packet.slice(2)),
  };
}

function toInt8(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}

function decodeMouseButtonPacket(packet: Uint8Array): {
  down: boolean;
  button: string;
} {
  return {
    down: packet[1] === 1,
    button: new TextDecoder().decode(packet.slice(2)),
  };
}

function decodeInt16BE(hi: number, lo: number): number {
  const value = (hi << 8) | lo;
  return value >= 0x8000 ? value - 0x10000 : value;
}

function sentPackets(): Uint8Array[] {
  return transportMock.send.mock.calls.map(
    (call) => call[0].packets[0] as Uint8Array,
  );
}

function sentMouseMove(packet: Uint8Array): { x: number; y: number } {
  expect(packet[0]).toBe(0x03);
  return {
    x: decodeInt16BE(packet[1], packet[2]),
    y: decodeInt16BE(packet[3], packet[4]),
  };
}

function sentKeys(): Array<{ down: boolean; key: string }> {
  return transportMock.send.mock.calls.map((call) => {
    const packet = call[0].packets[0] as Uint8Array;
    return decodeKeyPacket(packet);
  });
}

function parseJsonResult(
  result: Awaited<ReturnType<InstanceType<typeof GlkvmInputTool>["execute"]>>,
) {
  expect(result.content[0].type).toBe("text");
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

describe("resolveKvmdKeyName", () => {
  it("maps printable keys to KVMD KeyboardEvent.code names", () => {
    expect(resolveKvmdKeyName("a")).toBe("KeyA");
    expect(resolveKvmdKeyName("A")).toBe("KeyA");
    expect(resolveKvmdKeyName("1")).toBe("Digit1");
    expect(resolveKvmdKeyName("-")).toBe("Minus");
  });

  it("maps aliases and modifiers to KVMD key code names", () => {
    expect(resolveKvmdKeyName("esc")).toBe("Escape");
    expect(resolveKvmdKeyName("ctrl")).toBe("ControlLeft");
    expect(resolveKvmdKeyName("cmd")).toBe("MetaLeft");
    expect(resolveKvmdKeyName("option")).toBe("AltLeft");
  });

  it("preserves explicit KVMD KeyboardEvent.code names", () => {
    expect(resolveKvmdKeyName("KeyQ")).toBe("KeyQ");
    expect(resolveKvmdKeyName("ControlRight")).toBe("ControlRight");
    expect(resolveKvmdKeyName("F12")).toBe("F12");
  });
});

describe("GlkvmInputTool keyboard input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGlkvmFrameCacheForTests();
    cdpManagerMock.isAttached.mockReturnValue(true);
    cdpManagerMock.attach.mockResolvedValue(undefined);

    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockResolvedValue({
      tabId: 42,
      tab: {
        tabId: 42,
        title: "GLKVM - Lab",
        url: "https://kvm.example.com/#/",
      },
    });
    glkvmTabMock.getVideoMetadata.mockResolvedValue({
      videoWidth: 1920,
      videoHeight: 1080,
      displayRect: { x: 20, y: 40, width: 960, height: 540 },
      visible: true,
    });

    transportMock.connect.mockResolvedValue({
      tabId: 42,
      sessionId: "__oc_kvm_test",
      createdAt: 123,
    });
    transportMock.send.mockResolvedValue(undefined);
    transportMock.pasteText.mockResolvedValue(undefined);
    transportMock.cleanupSession.mockResolvedValue({
      ok: true,
      releasedKeys: 0,
      releasedButtons: 0,
    });
  });

  it("presses a single key as down then up", async () => {
    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "Enter", keyAction: "press" },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(sentKeys()).toEqual([
      { down: true, key: "Enter" },
      { down: false, key: "Enter" },
    ]);
    expect(parseJsonResult(result)).toMatchObject({
      action: "key",
      keyAction: "press",
      sessionId: "__oc_kvm_test",
      sent: 2,
      cleanup: { ok: true },
    });
    expect(transportMock.cleanupSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "__oc_kvm_test" }),
      { releaseAll: true },
    );
  });

  it("sends key down and key up actions without implicit extra events", async () => {
    await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "ShiftLeft", keyAction: "down" },
      {},
    );
    await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "ShiftLeft", keyAction: "up" },
      {},
    );

    expect(sentKeys()).toEqual([
      { down: true, key: "ShiftLeft" },
      { down: false, key: "ShiftLeft" },
    ]);
  });

  it("presses hotkey chords in down order and releases in reverse order", async () => {
    await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "ctrl+alt+delete", keyAction: "hotkey" },
      {},
    );

    expect(sentKeys()).toEqual([
      { down: true, key: "ControlLeft" },
      { down: true, key: "AltLeft" },
      { down: true, key: "Delete" },
      { down: false, key: "Delete" },
      { down: false, key: "AltLeft" },
      { down: false, key: "ControlLeft" },
    ]);
  });

  it("runs release-all cleanup when a chord send fails", async () => {
    transportMock.send
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("send failed"));

    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "ctrl+a", keyAction: "hotkey" },
      {},
    );

    expect(result.success).toBe(false);
    expect(sentKeys()).toEqual([
      { down: true, key: "ControlLeft" },
      { down: true, key: "KeyA" },
    ]);
    expect(transportMock.cleanupSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "__oc_kvm_test" }),
      { releaseAll: true },
    );
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "input_error",
      error: "send failed",
      cleanup: { ok: true },
    });
  });

  it("reports cleanup failure separately after primary input failure", async () => {
    transportMock.send.mockRejectedValueOnce(new Error("send failed"));
    transportMock.cleanupSession.mockResolvedValueOnce({
      ok: false,
      cleanupFailed: true,
      error: "release failed",
      errorCode: "PROTOCOL_ERROR",
    });

    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "Enter" },
      {},
    );

    expect(result.success).toBe(false);
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "input_error",
      error: "send failed",
      cleanup: {
        ok: false,
        cleanupFailed: true,
        error: "release failed",
        errorCode: "PROTOCOL_ERROR",
      },
    });
  });

  it("fails the tool when primary input succeeds but release-all cleanup fails", async () => {
    transportMock.cleanupSession.mockResolvedValueOnce({
      ok: false,
      cleanupFailed: true,
      error: "release failed",
    });

    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "Enter" },
      {},
    );

    expect(result.success).toBe(false);
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "cleanup_error",
      error: "release failed",
      cleanup: { ok: false, cleanupFailed: true, error: "release failed" },
    });
  });

  it("reuses an explicit GLKVM session for key input", async () => {
    await new GlkvmInputTool().execute(
      { tabId: 42, action: "key", key: "Escape", sessionId: "__oc_kvm_existing" },
      {},
    );

    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(transportMock.connect).toHaveBeenCalledWith({
      tabId: 42,
      sessionId: "__oc_kvm_existing",
    });
  });

  it("types text through the GLKVM paste-as-keys endpoint", async () => {
    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "type", text: "hello world" },
      {},
    );

    expect(result.success).toBe(true);
    expect(transportMock.pasteText).toHaveBeenCalledWith({
      tabId: 42,
      text: "hello world",
    });
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(transportMock.send).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      action: "type",
      method: "paste",
      textLength: 11,
    });
  });

  it("returns a clear error when paste-as-keys endpoint typing fails", async () => {
    transportMock.pasteText.mockRejectedValueOnce(
      new Error("GLKVM paste-as-keys endpoint returned 503: HID offline"),
    );

    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "type", text: "hello", fallback: "none" },
      {},
    );

    expect(result.success).toBe(false);
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "input_error",
      error: "GLKVM paste-as-keys endpoint returned 503: HID offline",
    });
    expect(transportMock.connect).not.toHaveBeenCalled();
  });

  it("falls back to key events for simple text when paste-as-keys fails", async () => {
    transportMock.pasteText.mockRejectedValueOnce(
      new Error("GLKVM paste-as-keys endpoint returned 404: Not Found"),
    );

    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "type", text: "ab 2" },
      {},
    );

    expect(result.success).toBe(true);
    expect(transportMock.connect).toHaveBeenCalledWith({ tabId: 42 });
    expect(sentKeys()).toEqual([
      { down: true, key: "KeyA" },
      { down: false, key: "KeyA" },
      { down: true, key: "KeyB" },
      { down: false, key: "KeyB" },
      { down: true, key: "Space" },
      { down: false, key: "Space" },
      { down: true, key: "Digit2" },
      { down: false, key: "Digit2" },
    ]);
    expect(parseJsonResult(result)).toMatchObject({
      action: "type",
      method: "key_fallback",
      textLength: 4,
      sessionId: "__oc_kvm_test",
      sent: 8,
      cleanup: { ok: true },
    });
    expect(transportMock.cleanupSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "__oc_kvm_test" }),
      { releaseAll: true },
    );
  });

  it("clicks by mapping screenshot coordinates to GLKVM absolute HID coordinates", async () => {
    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "click", x: 480, y: 270, button: "right" },
      {},
    );

    expect(result.success).toBe(true);
    const packets = sentPackets();
    expect(sentMouseMove(packets[0])).toEqual({ x: 0, y: 0 });
    expect(decodeMouseButtonPacket(packets[1])).toEqual({
      down: true,
      button: "right",
    });
    expect(decodeMouseButtonPacket(packets[2])).toEqual({
      down: false,
      button: "right",
    });
    expect(parseJsonResult(result)).toMatchObject({
      action: "click",
      button: "right",
      coordinates: {
        screenshot: { x: 480, y: 270, width: 960, height: 540 },
        absolute: { x: 0, y: 0 },
      },
      sent: 3,
      cleanup: { ok: true },
    });
  });

  it("maps screenshot-output coordinates with frameId through crop and downscale before direct click HID", async () => {
    mockCanvasCapture("cropped-downscaled", 400, 225);
    const frame = await captureGlkvmFrame({
      tabId: 42,
      crop: { x: 100, y: 50, width: 800, height: 450 },
      maxWidth: 400,
      maxHeight: 225,
    });
    transportMock.send.mockClear();

    const result = await new GlkvmInputTool().execute(
      {
        tabId: 42,
        action: "click",
        x: 200,
        y: 112.5,
        coordinateSpace: "glkvm_screenshot_pixels",
        frameId: frame.frameId,
      },
      {},
    );

    expect(result.success).toBe(true);
    expect(sentMouseMove(sentPackets()[0])).toEqual({ x: -15702, y: -16081 });
    expect(parseJsonResult(result)).toMatchObject({
      action: "click",
      coordinates: {
        input: {
          coordinateSpace: "glkvm_screenshot_pixels",
          point: { x: 200, y: 112.5 },
          frameId: frame.frameId,
        },
        screenshot: { x: 200, y: 112.5, width: 400, height: 225 },
        intrinsic: { x: 500, y: 275, width: 1920, height: 1080 },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "mapped_from_screenshot_output",
            frameId: frame.frameId,
          }),
        ]),
      },
    });
  });

  it("rejects unknown screenshot frameId before direct mouse HID side effects", async () => {
    const result = await new GlkvmInputTool().execute(
      {
        tabId: 42,
        action: "move",
        x: 10,
        y: 10,
        coordinateSpace: "glkvm_screenshot_pixels",
        frameId: "missing-frame",
      },
      {},
    );

    expect(result.success).toBe(false);
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(transportMock.send).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "input_error",
      error: expect.stringContaining("Unknown or stale GLKVM frameId missing-frame"),
    });
  });

  it("maps normalized remote-frame boundary coordinates for direct move", async () => {
    const result = await new GlkvmInputTool().execute(
      {
        tabId: 42,
        action: "move",
        x: 1,
        y: 0,
        coordinateSpace: "normalized_remote_frame",
      },
      {},
    );

    expect(result.success).toBe(true);
    expect(sentMouseMove(sentPackets()[0])).toEqual({ x: 32767, y: -32768 });
    expect(parseJsonResult(result)).toMatchObject({
      action: "move",
      coordinates: {
        input: {
          coordinateSpace: "normalized_remote_frame",
          point: { x: 1, y: 0 },
        },
        normalized: { x: 1, y: 0 },
        intrinsic: { x: 1920, y: 0, width: 1920, height: 1080 },
        diagnostics: [],
      },
    });
  });

  it("returns explicit clamping diagnostics for direct out-of-bounds intrinsic coordinates", async () => {
    const result = await new GlkvmInputTool().execute(
      {
        tabId: 42,
        action: "move",
        x: -10,
        y: 1200,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      {},
    );

    expect(result.success).toBe(true);
    expect(sentMouseMove(sentPackets()[0])).toEqual({ x: -32768, y: 32767 });
    expect(parseJsonResult(result)).toMatchObject({
      action: "move",
      coordinates: {
        input: {
          coordinateSpace: "intrinsic_remote_frame_pixels",
          point: { x: -10, y: 1200 },
        },
        intrinsic: { x: 0, y: 1080, width: 1920, height: 1080 },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "coordinate_clamped",
            axis: "x",
            input: -10,
            output: 0,
          }),
          expect.objectContaining({
            code: "coordinate_clamped",
            axis: "y",
            input: 1200,
            output: 1080,
          }),
        ]),
      },
    });
  });

  it("moves with bounds clamped to the signed absolute HID range", async () => {
    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "move", x: -10, y: 999 },
      {},
    );

    expect(result.success).toBe(true);
    expect(sentMouseMove(sentPackets()[0])).toEqual({ x: -32768, y: 32767 });
    expect(parseJsonResult(result)).toMatchObject({
      action: "move",
      sent: 1,
    });
  });

  it("drags from start to end coordinates with button held", async () => {
    const result = await new GlkvmInputTool().execute(
      {
        action: "drag",
        tabId: 42,
        startX: 0,
        startY: 0,
        endX: 960,
        endY: 540,
        button: "left",
      },
      {},
    );

    expect(result.success).toBe(true);
    const packets = sentPackets();
    expect(sentMouseMove(packets[0])).toEqual({ x: -32768, y: -32768 });
    expect(decodeMouseButtonPacket(packets[1])).toEqual({
      down: true,
      button: "left",
    });
    expect(sentMouseMove(packets[2])).toEqual({ x: 32767, y: 32767 });
    expect(decodeMouseButtonPacket(packets[3])).toEqual({
      down: false,
      button: "left",
    });
    expect(parseJsonResult(result)).toMatchObject({
      action: "drag",
      button: "left",
      sent: 4,
    });
  });

  it("scrolls with signed wheel deltas", async () => {
    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "scroll", direction: "down", amount: 3 },
      {},
    );

    expect(result.success).toBe(true);
    const packet = sentPackets()[0];
    expect(packet[0]).toBe(0x05);
    expect(packet[1]).toBe(0);
    expect(toInt8(packet[2])).toBe(0);
    expect(toInt8(packet[3])).toBe(-3);
    expect(parseJsonResult(result)).toMatchObject({
      action: "scroll",
      direction: "down",
      amount: 3,
      sent: 1,
    });
  });

  it("reports stale or missing video frame metadata before sending mouse input", async () => {
    glkvmTabMock.getVideoMetadata.mockResolvedValueOnce({
      videoWidth: 0,
      videoHeight: 0,
      displayRect: { x: 0, y: 0, width: 0, height: 0 },
      visible: true,
    });

    const result = await new GlkvmInputTool().execute(
      { tabId: 42, action: "click", x: 10, y: 10 },
      {},
    );

    expect(result.success).toBe(false);
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "input_error",
      error:
        "GLKVM video metadata is stale or unavailable. Capture a fresh glkvm_screenshot before sending mouse input.",
    });
  });

  it("rejects missing tabId before keyboard side effects", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. Available OpenCode-owned GLKVM tabs:\n  (none)"),
    );

    const result = await new GlkvmInputTool().execute(
      { action: "key", key: "Enter" },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      {},
      undefined,
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(transportMock.send).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "input_error",
      error: expect.stringContaining("requires an OpenCode-owned tabId"),
    });
  });

  it("rejects non-integer tabId before text side effects", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. Pass an integer tabId"),
    );

    const result = await new GlkvmInputTool().execute(
      { tabId: 42.5, action: "type", text: "hello" },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42.5 },
      undefined,
    );
    expect(transportMock.pasteText).not.toHaveBeenCalled();
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(parseJsonResult(result).error).toContain("integer tabId");
  });

  it("rejects target-only mouse control before metadata or HID side effects", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. URL targets are only for discovery/open/attach."),
    );

    const result = await new GlkvmInputTool().execute(
      { target: "kvm.example.com", action: "click", x: 10, y: 10 },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { target: "kvm.example.com" },
      undefined,
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(glkvmTabMock.getVideoMetadata).not.toHaveBeenCalled();
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(parseJsonResult(result).error).toContain(
      "URL targets are only for discovery/open/attach",
    );
  });
});
