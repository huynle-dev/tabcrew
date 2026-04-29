import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({ captureGlkvmFrame: vi.fn() }));
const tabMock = vi.hoisted(() => ({
  getVideoMetadata: vi.fn(),
  resolveGlkvmTab: vi.fn(),
  validateOwnedGlkvmTab: vi.fn(),
}));
const transportMock = vi.hoisted(() => ({ cleanupSession: vi.fn(), connect: vi.fn(), send: vi.fn() }));

vi.mock("./glkvmFrame.js", () => frameMock);
vi.mock("../glkvmTab.js", () => tabMock);
vi.mock("./kvmHidTransport.js", () => transportMock);

const { GlkvmSequenceTool } = await import("./glkvmSequence.js");

function parseJsonResult(result: Awaited<ReturnType<InstanceType<typeof GlkvmSequenceTool>["execute"]>>) {
  const block = result.content[0];
  expect(block.type).toBe("text");
  if (block.type !== "text") throw new Error("Expected text content");
  return JSON.parse(block.text);
}

describe("GlkvmSequenceTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    tabMock.getVideoMetadata.mockResolvedValue({ visible: true, videoWidth: 1280, videoHeight: 720, displayRect: { x: 0, y: 0, width: 1280, height: 720 } });
    tabMock.validateOwnedGlkvmTab.mockResolvedValue({
      tabId: 42,
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      ownership: { ok: true, tabId: 42, groupId: 101 },
    });
    transportMock.connect.mockResolvedValue({ tabId: 42, sessionId: "session-1", createdAt: 123 });
    transportMock.cleanupSession.mockResolvedValue({ ok: true, releasedKeys: 0, releasedButtons: 0 });
    transportMock.send.mockResolvedValue(undefined);
  });

  it("executes accepted sequence actions over one explicit tab session and logs outcomes", async () => {
    frameMock.captureGlkvmFrame
      .mockResolvedValueOnce({ tabId: 42, hash: "before", data: "aaa" })
      .mockResolvedValueOnce({ tabId: 42, hash: "after", data: "bbb", width: 1280, height: 720 })
      .mockResolvedValueOnce({ tabId: 42, hash: "final", data: "ccc", width: 1280, height: 720 });
    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [
      { action: "key", key: "Shift", keyAction: "down" },
      { action: "type", text: "a\n" },
      { action: "move", x: 10, y: 20 },
      { action: "click", x: 30, y: 40, button: "left" },
      { action: "drag", startX: 50, startY: 60, endX: 70, endY: 80 },
      { action: "scroll", direction: "down", amount: 2 },
      { action: "wait", timeout: 1000, pollInterval: 1 },
      { action: "capture" },
    ] }, {});
    expect(result.success).toBe(true);
    expect(tabMock.validateOwnedGlkvmTab).toHaveBeenCalledWith(42, undefined);
    expect(tabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(transportMock.connect).toHaveBeenCalledTimes(1);
    expect(transportMock.connect).toHaveBeenCalledWith({ tabId: 42 });
    expect(transportMock.send).toHaveBeenCalledTimes(14);
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledWith({ tabId: 42 });
    expect(transportMock.cleanupSession).toHaveBeenCalledWith({ tabId: 42, sessionId: "session-1", createdAt: 123 }, { releaseAll: true });
    expect(parseJsonResult(result)).toMatchObject({ completed: true, tabId: 42, session: { sessionId: "session-1", tabId: 42 }, cleanup: { ok: true, releasedKeys: 0, releasedButtons: 0 }, finalFrame: { tabId: 42, hash: "final", width: 1280, height: 720 }, log: [
      { index: 0, action: "key", status: "ok", key: "Shift", keyAction: "down", sent: 1 },
      { index: 1, action: "type", status: "ok", method: "key_fallback", textLength: 2, sent: 4 },
      { index: 2, action: "move", status: "ok", sent: 1 },
      { index: 3, action: "click", status: "ok", button: "left", sent: 3 },
      { index: 4, action: "drag", status: "ok", button: "left", sent: 4 },
      { index: 5, action: "scroll", status: "ok", direction: "down", amount: 2, sent: 1 },
      { index: 6, action: "wait", status: "ok", changed: true, timedOut: false, initialHash: "before", currentHash: "after", polls: 1 },
      { index: 7, action: "capture", status: "ok", frame: { hash: "final", width: 1280, height: 720 } },
    ] });
  });

  it("requires explicit tabId before resolving or connecting", async () => {
    const result = await new GlkvmSequenceTool().execute({ steps: [{ action: "key", key: "Shift", keyAction: "down" }] }, {});
    expect(result.success).toBe(false);
    expect(tabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({ completed: false, errorType: "sequence_error", error: 'The "tabId" argument is required for GLKVM sequence', log: [] });
  });

  it("requires the explicit tabId to belong to the current OpenCode session", async () => {
    tabMock.validateOwnedGlkvmTab.mockRejectedValueOnce(new Error("Tab 42 is not owned by this session"));
    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [{ action: "key", key: "A" }] }, { sessionScope: "scope-a" });
    expect(result.success).toBe(false);
    expect(tabMock.validateOwnedGlkvmTab).toHaveBeenCalledWith(42, "scope-a");
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({ completed: false, errorType: "sequence_error", error: "Tab 42 is not owned by this session", tabId: 42, log: [] });
  });

  it("releases held inputs and returns a clear error when a sequence wait times out", async () => {
    frameMock.captureGlkvmFrame.mockResolvedValue({ tabId: 42, hash: "same", data: "aaa" });
    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [{ action: "key", key: "Shift", keyAction: "down" }, { action: "wait", timeout: 100, pollInterval: 50 }] }, {});
    expect(result.success).toBe(false);
    expect(transportMock.cleanupSession).toHaveBeenCalledWith({ tabId: 42, sessionId: "session-1", createdAt: 123 }, { releaseAll: true });
    expect(parseJsonResult(result)).toMatchObject({ completed: false, errorType: "sequence_wait_timeout", error: "GLKVM sequence step 1 wait timed out after 100ms", cleanup: { ok: true, releasedKeys: 0, releasedButtons: 0 }, log: [
      { index: 0, action: "key", status: "ok", key: "Shift", keyAction: "down" },
      { index: 1, action: "wait", status: "timeout", changed: false, timedOut: true, reason: "timeout", initialHash: "same", currentHash: "same" },
    ] });
  });

  it("logs the failing step and cleans up when HID send fails", async () => {
    transportMock.send.mockRejectedValueOnce(new Error("socket closed"));
    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [{ action: "key", key: "A" }] }, {});
    expect(result.success).toBe(false);
    expect(transportMock.cleanupSession).toHaveBeenCalledWith({ tabId: 42, sessionId: "session-1", createdAt: 123 }, { releaseAll: true });
    expect(parseJsonResult(result)).toMatchObject({ completed: false, errorType: "sequence_error", error: "socket closed", log: [{ index: 0, action: "key", status: "error", error: "socket closed" }] });
  });

  it("cleans up an established HID session when a later capture step fails", async () => {
    frameMock.captureGlkvmFrame.mockRejectedValueOnce(new Error("tab capture failed"));
    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [{ action: "key", key: "Shift", keyAction: "down" }, { action: "capture" }] }, {});
    expect(result.success).toBe(false);
    expect(transportMock.connect).toHaveBeenCalledTimes(1);
    expect(transportMock.cleanupSession).toHaveBeenCalledWith({ tabId: 42, sessionId: "session-1", createdAt: 123 }, { releaseAll: true });
    expect(parseJsonResult(result)).toMatchObject({ completed: false, errorType: "sequence_error", error: "tab capture failed", cleanup: { ok: true, releasedKeys: 0, releasedButtons: 0 }, log: [
      { index: 0, action: "key", status: "ok", key: "Shift", keyAction: "down", sent: 1 },
      { index: 1, action: "capture", status: "error", error: "tab capture failed" },
    ] });
  });
});
