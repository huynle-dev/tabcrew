import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({
  captureGlkvmFrame: vi.fn(),
}));

vi.mock("./glkvmFrame.js", () => frameMock);

const { GlkvmWaitTool } = await import("./glkvmWait.js");

function parseJsonResult(
  result: Awaited<ReturnType<InstanceType<typeof GlkvmWaitTool>["execute"]>>,
) {
  const block = result.content[0];
  expect(block.type).toBe("text");
  if (block.type !== "text") throw new Error("Expected text content");
  return JSON.parse(block.text);
}

describe("GlkvmWaitTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("polls KVM frames until the frame hash changes", async () => {
    frameMock.captureGlkvmFrame
      .mockResolvedValueOnce({ tabId: 42, hash: "before", data: "aaa" })
      .mockResolvedValueOnce({ tabId: 42, hash: "before", data: "aaa" })
      .mockResolvedValueOnce({ tabId: 42, hash: "after", data: "bbb" });

    const result = await new GlkvmWaitTool().execute(
      { target: "kvm.example.com", timeout: 1000, pollInterval: 1 },
      {},
    );

    expect(result.success).toBe(true);
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledTimes(3);
    expect(frameMock.captureGlkvmFrame).toHaveBeenCalledWith({
      target: "kvm.example.com",
    });
    expect(parseJsonResult(result)).toMatchObject({
      changed: true,
      initialHash: "before",
      currentHash: "after",
      polls: 2,
    });
  });

  it("returns a distinct timeout result when the frame stays unchanged", async () => {
    frameMock.captureGlkvmFrame.mockResolvedValue({
      tabId: 42,
      hash: "same",
      data: "aaa",
    });

    const result = await new GlkvmWaitTool().execute(
      { timeout: 100, pollInterval: 50 },
      {},
    );

    expect(result.success).toBe(true);
    expect(parseJsonResult(result)).toMatchObject({
      changed: false,
      timedOut: true,
      reason: "timeout",
      initialHash: "same",
      currentHash: "same",
    });
  });

  it("reports capture errors distinctly from timeouts", async () => {
    frameMock.captureGlkvmFrame.mockRejectedValue(
      new Error("No GLKVM tab found. Open and log in first."),
    );

    const result = await new GlkvmWaitTool().execute(
      { timeout: 100, pollInterval: 50 },
      {},
    );

    expect(result.success).toBe(false);
    expect(parseJsonResult(result)).toMatchObject({
      changed: false,
      timedOut: false,
      errorType: "capture_error",
      error: "No GLKVM tab found. Open and log in first.",
    });
  });
});
