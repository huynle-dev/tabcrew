import { beforeEach, describe, expect, it, vi } from "vitest";

const glkvmTabMock = vi.hoisted(() => ({
  resolveGlkvmTab: vi.fn(),
  requireOwnedGlkvmTabForDirectControl: vi.fn(),
  getVideoMetadata: vi.fn(),
}));

const transportMock = vi.hoisted(() => ({
  getSessionStatus: vi.fn(),
}));

vi.mock("../glkvmTab.js", () => glkvmTabMock);
vi.mock("./kvmHidTransport.js", () => transportMock);

const { GlkvmStatusTool } = await import("./kvmStatus.js");

function parseJsonResult(
  result: Awaited<ReturnType<InstanceType<typeof GlkvmStatusTool>["execute"]>>,
) {
  expect(result.content[0].type).toBe("text");
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

describe("GlkvmStatusTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockResolvedValue({
      tabId: 42,
      tab: {
        tabId: 42,
        title: "GLKVM - Lab",
        url: "https://kvm.example.com/#/",
      },
    });

    glkvmTabMock.getVideoMetadata.mockResolvedValue({
      videoWidth: 1920,
      videoHeight: 1080,
      displayRect: { x: 12, y: 80, width: 960, height: 540 },
      visible: true,
    });

    transportMock.getSessionStatus.mockResolvedValue(1);
  });

  it("validates explicit owned tabId before returning status metadata", async () => {
    const result = await new GlkvmStatusTool().execute(
      { tabId: 42 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { tabId: 42 },
      "scope-a",
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(glkvmTabMock.getVideoMetadata).toHaveBeenCalledWith(42);

    expect(parseJsonResult(result)).toEqual({
      tab: {
        tabId: 42,
        title: "GLKVM - Lab",
        url: "https://kvm.example.com/#/",
      },
      video: {
        videoWidth: 1920,
        videoHeight: 1080,
        displayRect: { x: 12, y: 80, width: 960, height: 540 },
        visible: true,
      },
      stream: {
        available: true,
        status: "ready",
      },
    });
  });

  it("rejects missing tabId before reading status metadata", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. Available GLKVM tabs:\n  (none)"),
    );

    const result = await new GlkvmStatusTool().execute({}, {});

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      {},
      undefined,
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(glkvmTabMock.getVideoMetadata).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("requires an OpenCode-owned tabId"),
    });
  });

  it("rejects target-only status control before side effects", async () => {
    glkvmTabMock.requireOwnedGlkvmTabForDirectControl.mockRejectedValue(
      new Error("Direct GLKVM control requires an OpenCode-owned tabId. URL targets are only for discovery/open/attach."),
    );

    const result = await new GlkvmStatusTool().execute(
      { target: "kvm.example.com" },
      {},
    );

    expect(result.success).toBe(false);
    expect(glkvmTabMock.requireOwnedGlkvmTabForDirectControl).toHaveBeenCalledWith(
      { target: "kvm.example.com" },
      undefined,
    );
    expect(glkvmTabMock.resolveGlkvmTab).not.toHaveBeenCalled();
    expect(glkvmTabMock.getVideoMetadata).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("URL targets are only for discovery/open/attach"),
    });
  });

  it("returns a clear failure when video metadata cannot be read", async () => {
    glkvmTabMock.getVideoMetadata.mockRejectedValue(
      new Error("No <video> element found on this page."),
    );

    const result = await new GlkvmStatusTool().execute({ tabId: 42 }, {});

    expect(result.success).toBe(false);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "GLKVM status failed: No <video> element found on this page.",
    });
  });

  it("includes session status metadata when sessionId is supplied", async () => {
    const result = await new GlkvmStatusTool().execute(
      { tabId: 42, sessionId: "__oc_kvm_abc123" },
      {},
    );

    expect(transportMock.getSessionStatus).toHaveBeenCalledWith({
      tabId: 42,
      sessionId: "__oc_kvm_abc123",
      createdAt: expect.any(Number),
    });

    expect(parseJsonResult(result).session).toEqual({
      sessionId: "__oc_kvm_abc123",
      readyState: 1,
      status: "open",
    });
  });

  it("reports an unavailable session when the page no longer has it", async () => {
    transportMock.getSessionStatus.mockResolvedValue(null);

    const result = await new GlkvmStatusTool().execute(
      { tabId: 42, sessionId: "__oc_kvm_missing" },
      {},
    );

    expect(result.success).toBe(true);
    expect(parseJsonResult(result).session).toEqual({
      sessionId: "__oc_kvm_missing",
      readyState: null,
      status: "not_found",
    });
  });
});
