import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({
  captureGlkvmFrame: vi.fn(),
}));

vi.mock("./glkvmFrame.js", () => frameMock);

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

describe("GlkvmScreenshotTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the captured GLKVM video frame as an MCP JPEG image block", async () => {
    frameMock.captureGlkvmFrame.mockResolvedValue({
      tabId: 42,
      data: "jpeg-base64-frame",
      hash: "abc12345",
      width: 960,
      height: 540,
    });

    const result = await new GlkvmScreenshotTool().execute(
      { target: "kvm.example.com" },
      {},
    );

    expect(result.success).toBe(true);
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledWith({
      target: "kvm.example.com",
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

  it("fails clearly when the target is not an OpenCode-owned GLKVM tab", async () => {
    frameMock.captureGlkvmFrame.mockRejectedValue(
      new Error(
        'No GLKVM tab found matching "example.com". Open and log in to your GLKVM device first.',
      ),
    );

    const result = await new GlkvmScreenshotTool().execute(
      { target: "example.com" },
      {},
    );

    expect(result.success).toBe(false);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(
        {
          errorType: "capture_error",
          error:
            'No GLKVM tab found matching "example.com". Open and log in to your GLKVM device first.',
        },
        null,
        2,
      ),
    });
  });

  it("fails clearly when the resolved GLKVM tab is missing", async () => {
    frameMock.captureGlkvmFrame.mockRejectedValue(
      new Error("Tab 99 not found. The tab may have been closed."),
    );

    const result = await new GlkvmScreenshotTool().execute(
      { target: "kvm.example.com" },
      {},
    );

    expect(result.success).toBe(false);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Tab 99 not found"),
    });
  });

  it("rejects caller-supplied browser tabIds so unowned tabs cannot be captured", async () => {
    const result = await new GlkvmScreenshotTool().execute(
      { tabId: 123, target: "kvm.example.com" },
      {},
    );

    expect(result.success).toBe(false);
    expect(frameMock.captureGlkvmFrame).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("does not accept browser tabId"),
    });
  });
});
