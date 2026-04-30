import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({
  captureGlkvmFrame: vi.fn(),
}));

const glkvmTabMock = vi.hoisted(() => ({
  requireOwnedGlkvmTabForDirectControl: vi.fn(),
  getVideoMetadata: vi.fn(),
}));

const openToolMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const attachToolMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./glkvmFrame.js", () => frameMock);
vi.mock("../glkvmTab.js", () => glkvmTabMock);
vi.mock("./glkvmOpen.js", () => ({
  GlkvmOpenTool: class {
    execute = openToolMock.execute;
  },
}));
vi.mock("./glkvmAttach.js", () => ({
  GlkvmAttachTool: class {
    execute = attachToolMock.execute;
  },
}));

vi.mock("./kvmInput.js", () => {
  throw new Error("default GLKVM smoke test must not import kvmInput");
});
vi.mock("./kvmHidTransport.js", () => {
  throw new Error("default GLKVM smoke test must not import kvmHidTransport");
});
vi.mock("./glkvmSequence.js", () => {
  throw new Error("default GLKVM smoke test must not import glkvmSequence");
});
vi.mock("./glkvmNav.js", () => {
  throw new Error("default GLKVM smoke test must not import glkvmNav");
});

const { GlkvmSmokeTestTool } = await import("./glkvmSmokeTest.js");

function parseJsonResult(
  result: Awaited<ReturnType<InstanceType<typeof GlkvmSmokeTestTool>["execute"]>>,
) {
  const block = result.content[0];
  expect(block.type).toBe("text");
  if (block.type !== "text") throw new Error("Expected text content");
  return JSON.parse(block.text);
}

function successfulToolResult(value: Record<string, unknown>) {
  return {
    success: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function mockSuccessfulSmokeFrames(): void {
  frameMock.captureGlkvmFrame
    .mockResolvedValueOnce({
      tabId: 42,
      data: "full-frame",
      hash: "fullhash",
      width: 960,
      height: 540,
      source: { width: 1920, height: 1080, coordinateSpace: "intrinsic_remote_frame_pixels" },
      crop: null,
      output: { width: 960, height: 540, coordinateSpace: "glkvm_screenshot_pixels" },
      hashAlgorithm: "fnv1a-32",
    })
    .mockResolvedValueOnce({
      tabId: 42,
      data: "crop-frame",
      hash: "crophash",
      width: 320,
      height: 180,
      source: { width: 1920, height: 1080, coordinateSpace: "intrinsic_remote_frame_pixels" },
      crop: { x: 800, y: 450, width: 320, height: 180, coordinateSpace: "intrinsic_remote_frame_pixels" },
      output: { width: 320, height: 180, coordinateSpace: "glkvm_screenshot_pixels" },
      hashAlgorithm: "fnv1a-32",
    })
    .mockResolvedValueOnce({ tabId: 42, data: "stable-a", hash: "stablehash" })
    .mockResolvedValueOnce({ tabId: 42, data: "stable-b", hash: "stablehash" });
}

describe("GlkvmSmokeTestTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockResolvedValue({
      tabId: 42,
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      ownership: { ok: true, tabId: 42, groupId: 101 },
    });
    glkvmTabMock.getVideoMetadata.mockResolvedValue({
      videoWidth: 1920,
      videoHeight: 1080,
      displayRect: { x: 0, y: 0, width: 960, height: 540 },
      visible: true,
    });
    openToolMock.execute.mockResolvedValue(
      successfulToolResult({ tabId: 42, status: { glkvm: true, owned: true } }),
    );
    attachToolMock.execute.mockResolvedValue(
      successfulToolResult({ tabId: 42, status: { glkvm: true, owned: true } }),
    );
  });

  it("runs the default no-input smoke path against an owned tab", async () => {
    mockSuccessfulSmokeFrames();

    const result = await new GlkvmSmokeTestTool().execute(
      { tabId: 42, timeout: 100, pollInterval: 1, stabilityDuration: 1 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(openToolMock.execute).not.toHaveBeenCalled();
    expect(attachToolMock.execute).not.toHaveBeenCalled();
    expect(glkvmTabMock.getVideoMetadata).toHaveBeenCalledWith(42);
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(1, {
      tabId: 42,
      sessionScope: "scope-a",
    });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(2, {
      tabId: 42,
      sessionScope: "scope-a",
      crop: { x: 800, y: 450, width: 320, height: 180 },
    });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(3, {
      tabId: 42,
      sessionScope: "scope-a",
    });
    expect(frameMock.captureGlkvmFrame).toHaveBeenNthCalledWith(4, {
      tabId: 42,
      sessionScope: "scope-a",
    });

    expect(parseJsonResult(result)).toMatchObject({
      ok: true,
      tabId: 42,
      inputSent: false,
      openOrAttach: { mode: "owned_tab" },
      readiness: {
        tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
        stream: { available: true, status: "ready" },
        video: { videoWidth: 1920, videoHeight: 1080, visible: true },
      },
      captures: {
        full: { hash: "fullhash", width: 960, height: 540 },
        crop: {
          hash: "crophash",
          crop: { x: 800, y: 450, width: 320, height: 180 },
        },
      },
      stableWait: {
        stable: true,
        initialHash: "stablehash",
        stableHash: "stablehash",
      },
      calibration: {
        requested: false,
        approved: false,
        status: "skipped",
      },
    });
  });

  it("opens a GLKVM URL before no-input readiness and frame checks", async () => {
    mockSuccessfulSmokeFrames();
    openToolMock.execute.mockResolvedValueOnce(
      successfulToolResult({
        tabId: 42,
        status: { glkvm: true, owned: true },
        tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      }),
    );

    const result = await new GlkvmSmokeTestTool().execute(
      { url: "https://kvm.example.com/#/", active: false, timeout: 100, pollInterval: 1, stabilityDuration: 1 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(openToolMock.execute).toHaveBeenCalledWith(
      { url: "https://kvm.example.com/#/", active: false },
      { sessionScope: "scope-a" },
    );
    expect(attachToolMock.execute).not.toHaveBeenCalled();
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(parseJsonResult(result)).toMatchObject({
      ok: true,
      tabId: 42,
      inputSent: false,
      openOrAttach: {
        mode: "open",
        result: { tabId: 42, status: { glkvm: true, owned: true } },
      },
    });
  });

  it("attaches an existing GLKVM tab before no-input readiness and frame checks when requested", async () => {
    mockSuccessfulSmokeFrames();
    attachToolMock.execute.mockResolvedValueOnce(
      successfulToolResult({
        tabId: 42,
        status: { glkvm: true, owned: true },
        tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      }),
    );

    const result = await new GlkvmSmokeTestTool().execute(
      { tabId: 42, attach: true, timeout: 100, pollInterval: 1, stabilityDuration: 1 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(openToolMock.execute).not.toHaveBeenCalled();
    expect(attachToolMock.execute).toHaveBeenCalledWith(
      { tabId: 42 },
      { sessionScope: "scope-a" },
    );
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(parseJsonResult(result)).toMatchObject({
      ok: true,
      tabId: 42,
      inputSent: false,
      openOrAttach: {
        mode: "attach",
        result: { tabId: 42, status: { glkvm: true, owned: true } },
      },
    });
  });

  it("requires explicit approval before any HID calibration path can run", async () => {
    const result = await new GlkvmSmokeTestTool().execute(
      { tabId: 42, calibration: { enabled: true } },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      ok: false,
      inputSent: false,
      errorType: "calibration_approval_required",
      calibration: {
        requested: true,
        approved: false,
        status: "blocked",
      },
    });
  });

  it("keeps approved calibration gated and out of the default smoke operations", async () => {
    mockSuccessfulSmokeFrames();

    const result = await new GlkvmSmokeTestTool().execute(
      {
        tabId: 42,
        calibration: { enabled: true, approved: true },
        timeout: 100,
        pollInterval: 1,
        stabilityDuration: 1,
      },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(parseJsonResult(result)).toMatchObject({
      inputSent: false,
      calibration: {
        requested: true,
        approved: true,
        status: "approved_not_executed",
      },
    });
  });
});
