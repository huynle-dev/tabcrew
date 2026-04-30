import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  GLKVM_FRAME_CACHE_TTL_MS,
  captureGlkvmFrame,
  checkGlkvmFrameReady,
  checkGlkvmPageReady,
  checkGlkvmVideoVisible,
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

async function captureLabeledFrame(tabId: number, label: string) {
  mockCanvasCapture(`${label}-jpeg`, 1920, 1080);
  return captureGlkvmFrame({ tabId });
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
  glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockImplementation((options) => {
    const tabId = typeof options?.tabId === "number" ? options.tabId : 42;
    return Promise.resolve({
      tabId,
      tab: { tabId, title: "GLKVM", url: `https://kvm-${tabId}.example/#/` },
      ownership: { ok: true, tabId, groupId: 101 },
    });
  });
  mockVideoMetadata();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
      timestamp: expect.any(String),
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
      readiness: {
        pageReady: true,
        videoVisible: true,
        frameReady: true,
        reason: "frame_ready",
      },
    });
    expect(frame.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(resolveCachedGlkvmFrameDescriptor(frame.frameId)).toMatchObject({
      frameId: frame.frameId,
      timestamp: frame.timestamp,
      capturedAt: frame.capturedAt,
      tabId: 42,
      hash: frame.hash,
      source: frame.source,
      crop: null,
      output: frame.output,
      readiness: frame.readiness,
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
      readiness: {
        pageReady: true,
        videoVisible: true,
        frameReady: true,
        reason: "frame_ready",
      },
    });
    expect(getLatestGlkvmFrameMetadata(42)).toEqual(metadata);
  });

  it("creates opaque frame IDs without embedding the capture timestamp", async () => {
    const timestamp = new Date("2026-04-30T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(timestamp);
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
    });
    mockCanvasCapture("opaque-id-jpeg", 1920, 1080);

    const frame = await captureGlkvmFrame({ tabId: 42 });

    expect(frame.frameId).toBe(
      "glkvm-frame-11111111-1111-4111-8111-111111111111",
    );
    expect(frame.frameId).not.toContain(timestamp.getTime().toString(36));
    expect(frame.frameId).not.toContain("42");
  });

  it("keeps the recent-frame cache bounded per tab without cross-tab eviction", async () => {
    const otherTabFrame = await captureLabeledFrame(7, "tab-7-first");
    const firstTabFrame = await captureLabeledFrame(42, "tab-42-first");

    for (let index = 0; index < 20; index += 1) {
      await captureLabeledFrame(42, `tab-42-${index}`);
    }

    expect(resolveCachedGlkvmFrameDescriptor(firstTabFrame.frameId)).toBeUndefined();
    expect(resolveCachedGlkvmFrameDescriptor(otherTabFrame.frameId)).toMatchObject({
      frameId: otherTabFrame.frameId,
      tabId: 7,
    });
  });

  it("expires stale frame descriptors after the cache TTL", async () => {
    expect(GLKVM_FRAME_CACHE_TTL_MS).toBeGreaterThan(0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00.000Z"));
    const frame = await captureLabeledFrame(42, "ttl-frame");

    expect(resolveCachedGlkvmFrameDescriptor(frame.frameId)).toMatchObject({
      frameId: frame.frameId,
    });

    vi.setSystemTime(
      new Date(Date.now() + GLKVM_FRAME_CACHE_TTL_MS + 1),
    );

    expect(resolveCachedGlkvmFrameDescriptor(frame.frameId)).toBeUndefined();
  });

  it("exposes page, video, and frame readiness helper states", () => {
    expect(checkGlkvmPageReady({ status: "loading" })).toEqual({
      ready: false,
      reason: "page_loading",
    });
    expect(checkGlkvmPageReady({ status: "complete" })).toEqual({
      ready: true,
      reason: "page_ready",
    });
    expect(checkGlkvmVideoVisible({
      videoWidth: 1920,
      videoHeight: 1080,
      displayRect: { width: 0, height: 540 },
      visible: true,
    })).toEqual({ ready: false, reason: "video_hidden" });
    expect(checkGlkvmVideoVisible({
      videoWidth: 1920,
      videoHeight: 1080,
      displayRect: { width: 960, height: 540 },
      visible: true,
    })).toEqual({ ready: true, reason: "video_visible" });
    expect(checkGlkvmFrameReady({
      videoWidth: 0,
      videoHeight: 1080,
      displayRect: { width: 960, height: 540 },
      visible: true,
    })).toEqual({ ready: false, reason: "frame_dimensions_unavailable" });
    expect(checkGlkvmFrameReady({
      videoWidth: 1920,
      videoHeight: 1080,
      displayRect: { width: 960, height: 540 },
      visible: true,
    })).toEqual({ ready: true, reason: "frame_ready" });
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
