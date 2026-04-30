import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({
  captureGlkvmFrame: vi.fn(),
}));

const glkvmTabMock = vi.hoisted(() => ({
  requireOwnedGlkvmTabForDirectControl: vi.fn(),
  validateOwnedGlkvmTab: vi.fn(),
}));

vi.mock("./glkvmFrame.js", () => frameMock);
vi.mock("../glkvmTab.js", () => glkvmTabMock);

const { GlkvmScreenshotTool } = await import("./glkvmScreenshot.js");

function parseMetadata(
  result: Awaited<
    ReturnType<InstanceType<typeof GlkvmScreenshotTool>["execute"]>
  >,
) {
  const block = result.content[1];
  expect(block.type).toBe("text");
  if (block.type !== "text") throw new Error("Expected text metadata block");
  return JSON.parse(block.text);
}

function parseErrorResult(
  result: Awaited<
    ReturnType<InstanceType<typeof GlkvmScreenshotTool>["execute"]>
  >,
) {
  const block = result.content[0];
  expect(block.type).toBe("text");
  if (block.type !== "text") throw new Error("Expected text error block");
  return JSON.parse(block.text);
}

describe("GlkvmScreenshotTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockResolvedValue({
      tabId: 42,
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      ownership: { ok: true, tabId: 42, groupId: 101 },
    });
    glkvmTabMock.validateOwnedGlkvmTab.mockResolvedValue({
      tabId: 42,
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      ownership: { ok: true, tabId: 42, groupId: 101 },
    });
  });

  it("validates an explicit owned tabId before returning the captured GLKVM video frame", async () => {
    frameMock.captureGlkvmFrame.mockResolvedValue({
      tabId: 42,
      data: "jpeg-base64-frame",
      hash: "abc12345",
      width: 960,
      height: 540,
    });

    const result = await new GlkvmScreenshotTool().execute(
      { tabId: 42 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(glkvmTabMock.validateOwnedGlkvmTab).not.toHaveBeenCalled();
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledWith({
      tabId: 42,
      sessionScope: "scope-a",
    });
    expect(result.content[0]).toEqual({
      type: "image",
      data: "jpeg-base64-frame",
      mimeType: "image/jpeg",
    });
    expect(parseMetadata(result)).toEqual({
      tabId: 42,
      mimeType: "image/jpeg",
      hash: "abc12345",
      width: 960,
      height: 540,
    });
  });

  it("passes region and downscale options to frame capture as intrinsic crop options", async () => {
    frameMock.captureGlkvmFrame.mockResolvedValue({
      tabId: 42,
      data: "cropped-downscaled-jpeg",
      hash: "feedbeef",
      hashAlgorithm: "fnv1a-32",
      width: 320,
      height: 180,
      source: {
        width: 1920,
        height: 1080,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      crop: {
        x: 100,
        y: 50,
        width: 800,
        height: 450,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      output: {
        width: 320,
        height: 180,
        coordinateSpace: "glkvm_screenshot_pixels",
      },
    });

    const result = await new GlkvmScreenshotTool().execute(
      {
        tabId: 42,
        region: { x: 100, y: 50, width: 800, height: 450 },
        maxWidth: 320,
        maxHeight: 240,
      },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledWith({
      tabId: 42,
      sessionScope: "scope-a",
      crop: { x: 100, y: 50, width: 800, height: 450 },
      maxWidth: 320,
      maxHeight: 240,
    });
    expect(parseMetadata(result)).toEqual({
      tabId: 42,
      mimeType: "image/jpeg",
      hash: "feedbeef",
      hashAlgorithm: "fnv1a-32",
      width: 320,
      height: 180,
      source: {
        width: 1920,
        height: 1080,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      region: {
        x: 100,
        y: 50,
        width: 800,
        height: 450,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      crop: {
        x: 100,
        y: 50,
        width: 800,
        height: 450,
        coordinateSpace: "intrinsic_remote_frame_pixels",
      },
      output: {
        width: 320,
        height: 180,
        coordinateSpace: "glkvm_screenshot_pixels",
      },
    });
  });

  it("rejects invalid region arguments before frame capture", async () => {
    const result = await new GlkvmScreenshotTool().execute(
      { tabId: 42, region: { x: 0, y: 0, width: 0, height: 100 } },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Invalid region.width"),
    });
  });

  it("rejects invalid downscale arguments before frame capture", async () => {
    const result = await new GlkvmScreenshotTool().execute(
      { tabId: 42, maxWidth: Number.POSITIVE_INFINITY },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Invalid maxWidth"),
    });
  });

  it("rejects target-only direct control before frame capture", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error(
        "Direct GLKVM control requires an OpenCode-owned tabId. Pass an integer tabId from discovery/open/attach. URL targets are only for discovery/open/attach and are deprecated for direct GLKVM control.\nAvailable GLKVM tabs:\n  (none)",
      ),
    );

    const result = await new GlkvmScreenshotTool().execute(
      { target: "example.com" },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { target: "example.com" },
      undefined,
    );
    expect(glkvmTabMock.validateOwnedGlkvmTab).not.toHaveBeenCalled();
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(parseErrorResult(result)).toEqual({
      errorType: "capture_error",
      error: expect.stringContaining("Available GLKVM tabs"),
    });
  });

  it("includes targeting diagnostics when the explicit GLKVM tab is missing", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error(
        "Tab 99 was not found. The tab may have been closed.\nAvailable GLKVM tabs:\n  - tab 42: https://kvm.example.com/#/ (GLKVM)\nOpenCode-owned GLKVM tabs:\n  (none)",
      ),
    );

    const result = await new GlkvmScreenshotTool().execute(
      { tabId: 99 },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 99 },
      undefined,
    );
    expect(glkvmTabMock.validateOwnedGlkvmTab).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("OpenCode-owned GLKVM tabs"),
    });
  });

  it("rejects non-integer tabIds before frame capture", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. Pass an integer tabId"),
    );

    const result = await new GlkvmScreenshotTool().execute(
      { tabId: "123" },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: "123" },
      undefined,
    );
    expect(glkvmTabMock.validateOwnedGlkvmTab).not.toHaveBeenCalled();
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("requires an OpenCode-owned tabId"),
    });
  });
});
