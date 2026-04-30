import { beforeEach, describe, expect, it, vi } from "vitest";

const cdpManagerMock = vi.hoisted(() => ({
  isAttached: vi.fn(),
  attach: vi.fn(),
  sendCommand: vi.fn(),
}));

const glkvmTabMock = vi.hoisted(() => ({
  resolveGlkvmTab: vi.fn(),
  requireOwnedGlkvmTabForDirectControl: vi.fn(),
  getVideoMetadata: vi.fn(),
}));

vi.mock("../cdp.js", () => ({
  cdpManager: cdpManagerMock,
}));

vi.mock("../glkvmTab.js", () => glkvmTabMock);

const {
  captureGlkvmFrame,
  clearGlkvmFrameCacheForTests,
  formatGlkvmFrameMetadata,
  getLatestGlkvmFrameMetadata,
  resolveCachedGlkvmFrameDescriptor,
} = await import("./glkvmFrame.js");

function mockCanvasCapture(data: string, width: number, height: number) {
  cdpManagerMock.sendCommand.mockResolvedValueOnce({
    result: {
      type: "object",
      value: {
        data,
        width,
        height,
      },
    },
  });
}

function mockVideoMetadata() {
  glkvmTabMock.getVideoMetadata.mockResolvedValue({
    videoWidth: 1920,
    videoHeight: 1080,
    displayRect: { x: 0, y: 0, width: 960, height: 540 },
    visible: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearGlkvmFrameCacheForTests();
  cdpManagerMock.isAttached.mockReturnValue(true);
  cdpManagerMock.attach.mockResolvedValue(undefined);
  glkvmTabMock.resolveGlkvmTab.mockResolvedValue({
    tabId: 42,
    tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example/#/" },
  });
  glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockResolvedValue({
    tabId: 42,
    tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example/#/" },
    ownership: { ok: true, tabId: 42, groupId: 101 },
  });
  mockVideoMetadata();
});

describe("captureGlkvmFrame", () => {
  it("requires an explicit owned tabId and does not target-resolve direct frame capture", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. URL targets are only for discovery/open/attach."),
    );

    await expect(captureGlkvmFrame({ target: "kvm.example" })).rejects.toThrow(
      "requires an OpenCode-owned tabId",
    );
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { target: "kvm.example" },
      undefined,
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(glkvmTabMock.getVideoMetadata).not.toHaveBeenCalled();
    expect(cdpManagerMock.sendCommand).not.toHaveBeenCalled();
  });

  it("captures a full intrinsic remote frame with expanded metadata and legacy fields", async () => {
    mockCanvasCapture("full-frame-jpeg", 1920, 1080);

    const frame = await captureGlkvmFrame({ tabId: 42, sessionScope: "scope-a" });

    expect(frame).toMatchObject({
      frameId: expect.stringMatching(/^glkvm-frame-/),
      capturedAt: expect.any(String),
      tabId: 42,
      data: "full-frame-jpeg",
      width: 1920,
      height: 1080,
      source: {
        width: 1920,
        height: 1080,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      crop: null,
      output: {
        width: 1920,
        height: 1080,
        coordinateSpace: "glkvm_screenshot_pixels",
      },
      scale: {
        x: 1,
        y: 1,
      },
      hashAlgorithm: "fnv1a-32",
    });
    expect(frame.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(resolveCachedGlkvmFrameDescriptor(frame.frameId)).toMatchObject({
      frameId: frame.frameId,
      capturedAt: frame.capturedAt,
      tabId: 42,
      source: frame.source,
      crop: null,
      output: frame.output,
    });
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(cdpManagerMock.sendCommand).toHaveBeenCalledWith(
      42,
      "Runtime.evaluate",
      expect.objectContaining({
        awaitPromise: false,
        returnByValue: true,
      }),
    );
    const expression = cdpManagerMock.sendCommand.mock.calls[0][2].expression;
    expect(expression).toContain("drawImage");
    expect(expression).toContain("toDataURL(\"image/jpeg\", 0.8)");
    expect(() => new Function(expression)).not.toThrow();
  });

  it("applies an intrinsic-pixel crop before capture and reports crop metadata", async () => {
    mockCanvasCapture("cropped-jpeg", 640, 360);

    const frame = await captureGlkvmFrame({
      tabId: 42,
      crop: { x: 120, y: 80, width: 640, height: 360 },
    });

    expect(frame.width).toBe(640);
    expect(frame.height).toBe(360);
    expect(frame.crop).toEqual({
      x: 120,
      y: 80,
      width: 640,
      height: 360,
      coordinateSpace: "intrinsic_remote_frame_pixels",
    });
    expect(frame.output).toEqual({
      width: 640,
      height: 360,
      coordinateSpace: "glkvm_screenshot_pixels",
    });
    const expression = cdpManagerMock.sendCommand.mock.calls[0][2].expression;
    expect(expression).toContain('"sx":120');
    expect(expression).toContain('"sy":80');
    expect(expression).toContain('"sWidth":640');
    expect(expression).toContain('"sHeight":360');
  });

  it("downscales within max dimensions while preserving aspect ratio and never upscaling", async () => {
    mockCanvasCapture("downscaled-jpeg", 800, 450);

    const frame = await captureGlkvmFrame({
      tabId: 42,
      maxWidth: 800,
      maxHeight: 800,
    });

    expect(frame.width).toBe(800);
    expect(frame.height).toBe(450);
    expect(frame.output).toEqual({
      width: 800,
      height: 450,
      coordinateSpace: "glkvm_screenshot_pixels",
    });

    cdpManagerMock.sendCommand.mockReset();
    mockCanvasCapture("not-upscaled-jpeg", 1920, 1080);
    const notUpscaled = await captureGlkvmFrame({
      tabId: 42,
      maxWidth: 4000,
      maxHeight: 4000,
    });

    expect(notUpscaled.width).toBe(1920);
    expect(notUpscaled.height).toBe(1080);
  });

  it("combines crop and downscale metadata", async () => {
    mockCanvasCapture("crop-downscale-jpeg", 320, 180);

    const frame = await captureGlkvmFrame({
      tabId: 42,
      crop: { x: 10, y: 20, width: 640, height: 360 },
      maxWidth: 320,
      maxHeight: 320,
    });

    expect(frame.crop).toEqual({
      x: 10,
      y: 20,
      width: 640,
      height: 360,
      coordinateSpace: "intrinsic_remote_frame_pixels",
    });
    expect(frame.source).toEqual({
      width: 1920,
      height: 1080,
      coordinateSpace: "intrinsic_remote_frame_pixels",
    });
    expect(frame.output).toEqual({
      width: 320,
      height: 180,
      coordinateSpace: "glkvm_screenshot_pixels",
    });
    expect(frame.scale).toEqual({ x: 0.5, y: 0.5 });
  });

  it("formats canonical metadata and exposes the latest successful frame metadata", async () => {
    mockCanvasCapture("metadata-jpeg", 320, 180);

    const frame = await captureGlkvmFrame({
      tabId: 42,
      crop: { x: 10, y: 20, width: 640, height: 360 },
      maxWidth: 320,
      maxHeight: 320,
    });

    const metadata = formatGlkvmFrameMetadata(frame, { mimeType: "image/jpeg" });

    expect(metadata).toEqual({
      frameId: frame.frameId,
      timestamp: frame.capturedAt,
      capturedAt: frame.capturedAt,
      tabId: 42,
      mimeType: "image/jpeg",
      hash: frame.hash,
      hashAlgorithm: "fnv1a-32",
      hashMetadata: {
        value: frame.hash,
        algorithm: "fnv1a-32",
      },
      width: 320,
      height: 180,
      source: {
        width: 1920,
        height: 1080,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      region: {
        x: 10,
        y: 20,
        width: 640,
        height: 360,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      crop: {
        x: 10,
        y: 20,
        width: 640,
        height: 360,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      output: {
        width: 320,
        height: 180,
        coordinateSpace: "glkvm_screenshot_pixels",
      },
      scale: {
        x: 0.5,
        y: 0.5,
      },
    });
    expect(getLatestGlkvmFrameMetadata(42)).toEqual(metadata);
  });

  it("returns stable FNV-1a hashes for identical frame data and different hashes for changed frames", async () => {
    mockCanvasCapture("same-frame", 1920, 1080);
    const first = await captureGlkvmFrame({ tabId: 42 });

    mockCanvasCapture("same-frame", 1920, 1080);
    const second = await captureGlkvmFrame({ tabId: 42 });

    mockCanvasCapture("changed-frame", 1920, 1080);
    const changed = await captureGlkvmFrame({ tabId: 42 });

    expect(first.hashAlgorithm).toBe("fnv1a-32");
    expect(first.hash).toBe(second.hash);
    expect(changed.hash).not.toBe(first.hash);
  });

  it.each([
    ["non-finite crop", { crop: { x: Number.NaN, y: 0, width: 10, height: 10 } }],
    ["negative crop", { crop: { x: -1, y: 0, width: 10, height: 10 } }],
    ["zero crop width", { crop: { x: 0, y: 0, width: 0, height: 10 } }],
    ["out-of-bounds crop", { crop: { x: 1800, y: 0, width: 200, height: 10 } }],
    ["invalid maxWidth", { maxWidth: 0 }],
    ["invalid maxHeight", { maxHeight: Number.POSITIVE_INFINITY }],
  ])("rejects invalid %s values before capture", async (_name, options) => {
    await expect(
      captureGlkvmFrame({ tabId: 42, ...options }),
    ).rejects.toThrow(/intrinsic remote-frame pixels|downscale/);
    expect(cdpManagerMock.sendCommand).not.toHaveBeenCalled();
  });
});
