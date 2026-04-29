import { beforeEach, describe, expect, it, vi } from "vitest";

const glkvmTabMock = vi.hoisted(() => ({
  resolveGlkvmTab: vi.fn(),
}));

const transportMock = vi.hoisted(() => ({
  cleanupSession: vi.fn(),
  connect: vi.fn(),
  pasteText: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../glkvmTab.js", () => glkvmTabMock);
vi.mock("./kvmHidTransport.js", () => transportMock);

const { GlkvmInputTool, resolveKvmdKeyName } = await import("./kvmInput.js");

function decodeKeyPacket(packet: Uint8Array): { down: boolean; key: string } {
  return {
    down: packet[1] === 1,
    key: new TextDecoder().decode(packet.slice(2)),
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

    glkvmTabMock.resolveGlkvmTab.mockResolvedValue({
      tabId: 42,
      tab: {
        tabId: 42,
        title: "GLKVM - Lab",
        url: "https://kvm.example.com/#/",
      },
    });

    transportMock.connect.mockResolvedValue({
      tabId: 42,
      sessionId: "__oc_kvm_test",
      createdAt: 123,
    });
    transportMock.send.mockResolvedValue(undefined);
    transportMock.pasteText.mockResolvedValue(undefined);
    transportMock.cleanupSession.mockResolvedValue({ ok: true, releasedKeys: 0, releasedButtons: 0 });
  });

  it("presses a single key as down then up", async () => {
    const result = await new GlkvmInputTool().execute(
      { action: "key", key: "Enter", keyAction: "press" },
      {},
    );

    expect(result.success).toBe(true);
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
      { action: "key", key: "ShiftLeft", keyAction: "down" },
      {},
    );
    await new GlkvmInputTool().execute(
      { action: "key", key: "ShiftLeft", keyAction: "up" },
      {},
    );

    expect(sentKeys()).toEqual([
      { down: true, key: "ShiftLeft" },
      { down: false, key: "ShiftLeft" },
    ]);
  });

  it("presses hotkey chords in down order and releases in reverse order", async () => {
    await new GlkvmInputTool().execute(
      { action: "key", key: "ctrl+alt+delete", keyAction: "hotkey" },
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
      { action: "key", key: "ctrl+a", keyAction: "hotkey" },
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
      { action: "key", key: "Enter" },
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
      { action: "key", key: "Enter" },
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
      { action: "key", key: "Escape", sessionId: "__oc_kvm_existing" },
      {},
    );

    expect(glkvmTabMock.resolveGlkvmTab).toHaveBeenCalledWith(undefined);
    expect(transportMock.connect).toHaveBeenCalledWith({
      tabId: 42,
      sessionId: "__oc_kvm_existing",
    });
  });

  it("types text through the GLKVM paste-as-keys endpoint", async () => {
    const result = await new GlkvmInputTool().execute(
      { action: "type", text: "hello world" },
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
      { action: "type", text: "hello", fallback: "none" },
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
      { action: "type", text: "ab 2" },
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
});
