import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({
  captureGlkvmFrame: vi.fn(),
  formatGlkvmFrameMetadata: vi.fn(),
}));

const glkvmTabMock = vi.hoisted(() => ({
  requireOwnedGlkvmTabForDirectControl: vi.fn(),
}));

vi.mock("./glkvmFrame.js", () => frameMock);
vi.mock("../glkvmTab.js", () => glkvmTabMock);

const { GlkvmWaitTool } = await import("./glkvmWait.js");

function parseJsonResult(
  result: Awaited<ReturnType<InstanceType<typeof GlkvmWaitTool>["execute"]>>,
) {
  const block = result.content[0];
  expect(block.type).toBe("text");
  if (block.type !== "text") throw new Error("Expected text content");
  return JSON.parse(block.text);
}

function makeFrame(hash: string) {
  return {
    frameId: `frame-${hash}`,
    timestamp: `2026-04-30T00:00:00.${hash.length}00Z`,
    capturedAt: `2026-04-30T00:00:00.${hash.length}00Z`,
    tabId: 42,
    hash,
    hashAlgorithm: "fnv1a-32",
    data: `${hash}-jpeg`,
    width: 640,
    height: 360,
    source: { width: 1280, height: 720, coordinateSpace: "intrinsic_remote_frame_pixels" },
    crop: null,
    output: { width: 640, height: 360, coordinateSpace: "glkvm_screenshot_pixels" },
    scale: { x: 0.5, y: 0.5 },
  };
}

function expectedMetadata(frame: ReturnType<typeof makeFrame>) {
  return {
    frameId: frame.frameId,
    timestamp: frame.timestamp,
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

describe("GlkvmWaitTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockResolvedValue({
      tabId: 42,
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      ownership: { ok: true, tabId: 42, groupId: 101 },
    });
    frameMock.formatGlkvmFrameMetadata.mockImplementation((frame: ReturnType<typeof makeFrame>) => expectedMetadata(frame));
  });

  it("validates explicit owned tabId before polling KVM frames until the frame hash changes", async () => {
    const before = makeFrame("before");
    const after = makeFrame("after");
    frameMock.captureGlkvmFrame
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    const result = await new GlkvmWaitTool().execute(
      { tabId: 42, timeout: 1000, pollInterval: 1 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledTimes(3);
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(1, {
      tabId: 42,
      sessionScope: "scope-a",
    });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(2, {
      tabId: 42,
      sessionScope: "scope-a",
    });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(3, {
      tabId: 42,
      sessionScope: "scope-a",
    });
    expect(parseJsonResult(result)).toMatchObject({
      changed: true,
      initialHash: "before",
      currentHash: "after",
      initialFrame: expectedMetadata(before),
      currentFrame: expectedMetadata(after),
      polls: 2,
    });
  });

  it("returns a distinct timeout result when the frame stays unchanged", async () => {
    const same = makeFrame("same");
    frameMock.captureGlkvmFrame.mockResolvedValue(same);

    const result = await new GlkvmWaitTool().execute(
      { tabId: 42, timeout: 100, pollInterval: 50 },
      {},
    );

    expect(result.success).toBe(true);
    expect(parseJsonResult(result)).toMatchObject({
      changed: false,
      timedOut: true,
      reason: "timeout",
      initialHash: "same",
      currentHash: "same",
      initialFrame: expectedMetadata(same),
      currentFrame: expectedMetadata(same),
    });
  });

  it("rejects missing tabId before first frame capture", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. Available GLKVM tabs:\n  (none)"),
    );

    const result = await new GlkvmWaitTool().execute(
      { timeout: 100, pollInterval: 50 },
      {},
    );

    expect(result.success).toBe(false);
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      changed: false,
      timedOut: false,
      errorType: "capture_error",
      error: expect.stringContaining("requires an OpenCode-owned tabId"),
    });
  });

  it("rejects target-only wait control before first frame capture", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. URL targets are only for discovery/open/attach."),
    );

    const result = await new GlkvmWaitTool().execute(
      { target: "kvm.example.com", timeout: 100, pollInterval: 50 },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { target: "kvm.example.com" },
      undefined,
    );
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "capture_error",
      error: expect.stringContaining("URL targets are only for discovery/open/attach"),
    });
  });
});
