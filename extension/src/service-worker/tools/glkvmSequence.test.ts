import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({ captureGlkvmFrame: vi.fn(), formatGlkvmFrameMetadata: vi.fn(), resolveCachedGlkvmFrameDescriptor: vi.fn() }));
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

function makeFrame(frameId: string, hash: string, data: string) {
  return {
    frameId,
    capturedAt: `2026-04-30T00:00:0${frameId.slice(-1)}.000Z`,
    tabId: 42,
    hash,
    hashAlgorithm: "fnv1a-32",
    data,
    width: 640,
    height: 360,
    source: { width: 1280, height: 720, coordinateSpace: "intrinsic_remote_frame_pixels" },
    crop: null,
    output: { width: 640, height: 360, coordinateSpace: "glkvm_screenshot_pixels" },
    scale: { x: 0.5, y: 0.5 },
  };
}

function expectedFrameMetadata(frame: ReturnType<typeof makeFrame>) {
  return {
    frameId: frame.frameId,
    timestamp: frame.capturedAt,
    capturedAt: frame.capturedAt,
    tabId: frame.tabId,
    hash: frame.hash,
    hashAlgorithm: frame.hashAlgorithm,
    hashMetadata: { value: frame.hash, algorithm: frame.hashAlgorithm },
    width: frame.width,
    height: frame.height,
    source: frame.source,
    region: frame.crop,
    crop: frame.crop,
    output: frame.output,
    scale: frame.scale,
  };
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
    frameMock.formatGlkvmFrameMetadata.mockImplementation((frame: ReturnType<typeof makeFrame>) => expectedFrameMetadata(frame));
    frameMock.resolveCachedGlkvmFrameDescriptor.mockReturnValue(undefined);
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
    ] }, { sessionScope: "scope-a" });
    expect(result.success).toBe(true);
    expect(tabMock.validateOwnedGlkvmTab).toHaveBeenCalledWith(42, "scope-a");
    expect(tabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(transportMock.connect).toHaveBeenCalledTimes(1);
    expect(transportMock.connect).toHaveBeenCalledWith({ tabId: 42 });
    expect(transportMock.send).toHaveBeenCalledTimes(14);
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(1, { tabId: 42, sessionScope: "scope-a" });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(2, { tabId: 42, sessionScope: "scope-a" });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(3, { tabId: 42, sessionScope: "scope-a" });
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

  it("reuses forwarded sessionId and supports schema-advertised waitFrameChange and capture includeData options", async () => {
    frameMock.captureGlkvmFrame
      .mockResolvedValueOnce({ tabId: 42, hash: "before", data: "before-jpeg", width: 1280, height: 720 })
      .mockResolvedValueOnce({ tabId: 42, hash: "after", data: "after-jpeg", width: 1280, height: 720 })
      .mockResolvedValueOnce({ tabId: 42, hash: "capture", data: "capture-jpeg", width: 1280, height: 720 });

    const result = await new GlkvmSequenceTool().execute({ tabId: 42, sessionId: "existing-session", steps: [
      { action: "key", key: "A" },
      { action: "waitFrameChange", timeout: 1000, pollInterval: 1 },
      { action: "capture", includeData: true },
    ] }, { sessionScope: "scope-a" });

    expect(result.success).toBe(true);
    expect(transportMock.connect).toHaveBeenCalledWith({ tabId: 42, sessionId: "existing-session" });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(1, { tabId: 42, sessionScope: "scope-a" });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(2, { tabId: 42, sessionScope: "scope-a" });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(3, { tabId: 42, sessionScope: "scope-a" });
    expect(parseJsonResult(result)).toMatchObject({ completed: true, tabId: 42, session: { sessionId: "session-1", tabId: 42 }, finalFrame: { tabId: 42, hash: "capture", width: 1280, height: 720, data: "capture-jpeg" }, log: [
      { index: 0, action: "key", status: "ok", key: "A", sent: 2 },
      { index: 1, action: "waitFrameChange", status: "ok", changed: true, timedOut: false, initialHash: "before", currentHash: "after", polls: 1 },
      { index: 2, action: "capture", status: "ok", frame: { hash: "capture", width: 1280, height: 720, data: "capture-jpeg" } },
    ] });
  });

  it("supports waitFrameStable by waiting until the frame hash remains unchanged for the requested stability duration", async () => {
    frameMock.captureGlkvmFrame
      .mockResolvedValueOnce({ tabId: 42, hash: "initial", data: "aaa" })
      .mockResolvedValueOnce({ tabId: 42, hash: "changed", data: "bbb" })
      .mockResolvedValueOnce({ tabId: 42, hash: "changed", data: "bbb" });

    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [
      { action: "waitFrameStable", timeout: 1000, pollInterval: 1, stabilityDuration: 1 },
    ] }, { sessionScope: "scope-a" });

    expect(result.success).toBe(true);
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledTimes(3);
    expect(parseJsonResult(result)).toMatchObject({ completed: true, log: [
      { index: 0, action: "waitFrameStable", status: "ok", stable: true, timedOut: false, initialHash: "initial", currentHash: "changed" },
    ], finalFrame: { tabId: 42, hash: "changed" } });
  });

  it("returns canonical frame metadata for sequence capture and finalFrame outputs", async () => {
    const captured = makeFrame("frame-3", "capture", "capture-jpeg");
    frameMock.captureGlkvmFrame.mockResolvedValueOnce(captured);

    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [
      { action: "capture", includeData: true },
    ] }, { sessionScope: "scope-a" });

    expect(result.success).toBe(true);
    const body = parseJsonResult(result);
    expect(body.log[0]).toMatchObject({
      index: 0,
      action: "capture",
      status: "ok",
      frame: { ...expectedFrameMetadata(captured), data: "capture-jpeg" },
    });
    expect(body.finalFrame).toMatchObject({ ...expectedFrameMetadata(captured), data: "capture-jpeg" });
  });

  it("maps sequence screenshot coordinates through frameId crop and downscale metadata before HID input", async () => {
    frameMock.resolveCachedGlkvmFrameDescriptor.mockReturnValueOnce({
      frameId: "frame-crop",
      capturedAt: "2026-04-30T00:00:00.000Z",
      tabId: 42,
      source: { width: 1920, height: 1080, coordinateSpace: "intrinsic_remote_frame_pixels" },
      crop: { x: 100, y: 50, width: 800, height: 400, coordinateSpace: "intrinsic_remote_frame_pixels" },
      output: { width: 400, height: 200, coordinateSpace: "glkvm_screenshot_pixels" },
      width: 400,
      height: 200,
    });

    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [
      { action: "click", x: 200, y: 100, coordinateSpace: "glkvm_screenshot_pixels", frameId: "frame-crop" },
    ] }, {});

    expect(result.success).toBe(true);
    expect(frameMock.resolveCachedGlkvmFrameDescriptor).toHaveBeenCalledWith("frame-crop");
    expect(transportMock.send).toHaveBeenCalledTimes(3);
    expect(parseJsonResult(result)).toMatchObject({ completed: true, log: [
      {
        index: 0,
        action: "click",
        status: "ok",
        coordinates: {
          input: { coordinateSpace: "glkvm_screenshot_pixels", point: { x: 200, y: 100 }, frameId: "frame-crop" },
          screenshot: { x: 200, y: 100, width: 400, height: 200 },
          intrinsic: { x: 500, y: 250, width: 1920, height: 1080 },
          diagnostics: [{ code: "mapped_from_screenshot_output", frameId: "frame-crop" }],
        },
      },
    ] });
  });

  it("maps sequence normalized remote-frame boundary coordinates to intrinsic edges", async () => {
    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [
      { action: "drag", startX: 0, startY: 0, endX: 1, endY: 1, coordinateSpace: "normalized_remote_frame" },
    ] }, {});

    expect(result.success).toBe(true);
    expect(transportMock.send).toHaveBeenCalledTimes(4);
    expect(parseJsonResult(result)).toMatchObject({ completed: true, log: [
      {
        index: 0,
        action: "drag",
        status: "ok",
        coordinates: {
          input: { coordinateSpace: "normalized_remote_frame" },
          intrinsic: {
            start: { x: 0, y: 0, width: 1280, height: 720 },
            end: { x: 1280, y: 720, width: 1280, height: 720 },
          },
          diagnostics: [],
        },
      },
    ] });
  });

  it("rejects unknown or stale sequence frameId before opening a HID session or sending packets", async () => {
    frameMock.resolveCachedGlkvmFrameDescriptor.mockReturnValueOnce(undefined);

    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [
      { action: "move", x: 1, y: 2, coordinateSpace: "glkvm_screenshot_pixels", frameId: "missing-frame" },
    ] }, {});

    expect(result.success).toBe(false);
    expect(frameMock.resolveCachedGlkvmFrameDescriptor).toHaveBeenCalledWith("missing-frame");
    expect(transportMock.connect).not.toHaveBeenCalled();
    expect(transportMock.send).not.toHaveBeenCalled();
    expect(transportMock.cleanupSession).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      completed: false,
      errorType: "sequence_error",
      error: expect.stringContaining("Unknown or stale GLKVM frameId missing-frame"),
      log: [{ index: 0, action: "move", status: "error", error: expect.stringContaining("Unknown or stale GLKVM frameId missing-frame") }],
    });
  });

  it("returns explicit coordinate clamp diagnostics for out-of-bounds sequence mouse input", async () => {
    const result = await new GlkvmSequenceTool().execute({ tabId: 42, steps: [
      { action: "move", x: -10, y: 999, coordinateSpace: "intrinsic_remote_frame_pixels" },
    ] }, {});

    expect(result.success).toBe(true);
    expect(parseJsonResult(result)).toMatchObject({ completed: true, log: [
      {
        index: 0,
        action: "move",
        status: "ok",
        coordinates: {
          input: { coordinateSpace: "intrinsic_remote_frame_pixels", point: { x: -10, y: 999 } },
          intrinsic: { x: 0, y: 720, width: 1280, height: 720 },
          diagnostics: [
            { code: "coordinate_clamped", axis: "x", input: -10, output: 0 },
            { code: "coordinate_clamped", axis: "y", input: 999, output: 720 },
          ],
        },
      },
    ] });
  });
});
