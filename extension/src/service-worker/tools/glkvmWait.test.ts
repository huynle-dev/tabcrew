import { beforeEach, describe, expect, it, vi } from "vitest";

const frameMock = vi.hoisted(() => ({
  captureGlkvmFrame: vi.fn(),
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

describe("GlkvmWaitTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockResolvedValue({
      tabId: 42,
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      ownership: { ok: true, tabId: 42, groupId: 101 },
    });
  });

  it("validates explicit owned tabId before polling KVM frames until the frame hash changes", async () => {
    frameMock.captureGlkvmFrame
      .mockResolvedValueOnce({ tabId: 42, hash: "before", data: "aaa" })
      .mockResolvedValueOnce({ tabId: 42, hash: "before", data: "aaa" })
      .mockResolvedValueOnce({ tabId: 42, hash: "after", data: "bbb" });

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
