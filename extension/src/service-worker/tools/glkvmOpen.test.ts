import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addTabToGroupMock = vi.hoisted(() => vi.fn());
const isAttachedMock = vi.hoisted(() => vi.fn());
const attachMock = vi.hoisted(() => vi.fn());
const sendCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../tabGroups.js", () => ({
  tabGroupManager: {
    addTabToGroup: addTabToGroupMock,
  },
}));

vi.mock("../cdp.js", () => ({
  cdpManager: {
    isAttached: isAttachedMock,
    attach: attachMock,
    sendCommand: sendCommandMock,
  },
}));

const chromeStub = {
  tabs: {
    create: vi.fn(),
    get: vi.fn(),
  },
};

Object.assign(globalThis, { chrome: chromeStub });

const { GlkvmOpenTool } = await import("./glkvmOpen.js");

function parseJsonResult(result: Awaited<ReturnType<InstanceType<typeof GlkvmOpenTool>["execute"]>>) {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  if (!block || block.type !== "text") throw new Error("Expected text content");
  return JSON.parse(block.text);
}

describe("GlkvmOpenTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    isAttachedMock.mockReturnValue(true);
    sendCommandMock.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 1280,
          videoHeight: 720,
          displayRect: { x: 0, y: 0, width: 640, height: 360 },
          visible: true,
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a GLKVM URL in the current OpenCode session group", async () => {
    chromeStub.tabs.create.mockResolvedValueOnce({
      id: 42,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      windowId: 7,
      active: true,
    });
    addTabToGroupMock.mockResolvedValueOnce(101);
    chromeStub.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      status: "complete",
    });

    const result = await new GlkvmOpenTool().execute(
      { url: "https://kvm.example.com/#/", active: true },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(chromeStub.tabs.create).toHaveBeenCalledWith({
      url: "https://kvm.example.com/#/",
      active: true,
    });
    expect(addTabToGroupMock).toHaveBeenCalledWith(42, "scope-a");
    expect(parseJsonResult(result)).toMatchObject({
      tabId: 42,
      groupId: 101,
      tab: {
        tabId: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      },
      status: {
        glkvm: true,
        owned: true,
        readiness: {
          pagePresent: true,
          videoVisible: true,
          firstFrameAvailable: true,
          reason: "frame_ready",
        },
      },
    });
  });

  it("waits for a delayed GLKVM title before returning success", async () => {
    chromeStub.tabs.create.mockResolvedValueOnce({
      id: 42,
      pendingUrl: "https://kvm.example.com/#/",
      title: "",
      windowId: 7,
      active: true,
    });
    addTabToGroupMock.mockResolvedValueOnce(101);
    chromeStub.tabs.get
      .mockResolvedValueOnce({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "",
        status: "complete",
      })
      .mockResolvedValueOnce({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
        status: "complete",
      });

    const pending = new GlkvmOpenTool().execute(
      { url: "https://kvm.example.com/#/", timeout: 1000, pollInterval: 10 },
      { sessionScope: "scope-a" },
    );

    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(chromeStub.tabs.get).toHaveBeenCalledTimes(2);
    expect(parseJsonResult(result)).toMatchObject({
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      status: {
        readiness: {
          pagePresent: true,
          videoVisible: true,
          firstFrameAvailable: true,
          reason: "frame_ready",
        },
      },
    });
  });

  it("waits for a delayed final GLKVM URL before returning success", async () => {
    chromeStub.tabs.create.mockResolvedValueOnce({
      id: 42,
      pendingUrl: "https://kvm.example.com/#/",
      title: "GLKVM",
      windowId: 7,
      active: true,
    });
    addTabToGroupMock.mockResolvedValueOnce(101);
    chromeStub.tabs.get
      .mockResolvedValueOnce({ id: 42, url: "", title: "GLKVM", status: "complete" })
      .mockResolvedValueOnce({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
        status: "complete",
      });

    const pending = new GlkvmOpenTool().execute(
      { url: "https://kvm.example.com/#/", timeout: 1000, pollInterval: 10 },
      { sessionScope: "scope-a" },
    );

    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(chromeStub.tabs.get).toHaveBeenCalledTimes(2);
    expect(parseJsonResult(result)).toMatchObject({
      tab: { url: "https://kvm.example.com/#/", title: "GLKVM" },
      status: { readiness: { pagePresent: true, reason: "frame_ready" } },
    });
  });

  it("waits for delayed video dimensions before returning success", async () => {
    chromeStub.tabs.create.mockResolvedValueOnce({
      id: 42,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      windowId: 7,
      active: true,
    });
    addTabToGroupMock.mockResolvedValueOnce(101);
    chromeStub.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      status: "complete",
    });
    sendCommandMock
      .mockResolvedValueOnce({
        result: {
          type: "object",
          value: {
            videoWidth: 0,
            videoHeight: 0,
            displayRect: { x: 0, y: 0, width: 640, height: 360 },
            visible: true,
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          type: "object",
          value: {
            videoWidth: 1280,
            videoHeight: 720,
            displayRect: { x: 0, y: 0, width: 640, height: 360 },
            visible: true,
          },
        },
      });

    const pending = new GlkvmOpenTool().execute(
      { url: "https://kvm.example.com/#/", timeout: 1000, pollInterval: 10 },
      { sessionScope: "scope-a" },
    );

    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(sendCommandMock).toHaveBeenCalledTimes(2);
    expect(parseJsonResult(result)).toMatchObject({
      video: { videoWidth: 1280, videoHeight: 720, visible: true },
      status: {
        readiness: {
          videoVisible: true,
          firstFrameAvailable: true,
          reason: "frame_ready",
        },
      },
    });
  });

  it("returns a structured not-ready timeout when no first frame arrives", async () => {
    chromeStub.tabs.create.mockResolvedValueOnce({
      id: 42,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      windowId: 7,
      active: true,
    });
    addTabToGroupMock.mockResolvedValueOnce(101);
    chromeStub.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      status: "complete",
    });
    sendCommandMock.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 0,
          videoHeight: 0,
          displayRect: { x: 0, y: 0, width: 640, height: 360 },
          visible: true,
        },
      },
    });

    const pending = new GlkvmOpenTool().execute(
      { url: "https://kvm.example.com/#/", timeout: 25, pollInterval: 10 },
      { sessionScope: "scope-a" },
    );

    await vi.advanceTimersByTimeAsync(30);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "glkvm_not_ready_timeout",
      tabId: 42,
      groupId: 101,
      status: {
        readiness: {
          pagePresent: true,
          videoVisible: true,
          firstFrameAvailable: false,
          reason: "frame_dimensions_unavailable",
        },
      },
    });
  });

  it("rejects missing or invalid GLKVM URLs before creating a tab", async () => {
    const result = await new GlkvmOpenTool().execute(
      { url: "not a url" },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(chromeStub.tabs.create).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "invalid_url",
      error: expect.stringContaining("valid http(s) GLKVM URL"),
    });
  });

  it("returns a clear missing-tab error when Chrome creates no tab ID", async () => {
    chromeStub.tabs.create.mockResolvedValueOnce({
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      windowId: 7,
      active: true,
    });

    const result = await new GlkvmOpenTool().execute(
      { url: "https://kvm.example.com/#/" },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(addTabToGroupMock).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "tab_not_found",
      error: expect.stringContaining("Chrome did not return a tab ID"),
    });
  });

  it("returns a clear group API error when ownership assignment fails", async () => {
    chromeStub.tabs.create.mockResolvedValueOnce({
      id: 42,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
      windowId: 7,
      active: true,
    });
    addTabToGroupMock.mockRejectedValueOnce(new Error("group failed"));

    const result = await new GlkvmOpenTool().execute(
      { url: "https://kvm.example.com/#/" },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "group_api_error",
      error: expect.stringContaining("Failed to move tab 42 into OpenCode group"),
      groupError: "group failed",
      tab: {
        tabId: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      },
    });
  });
});
