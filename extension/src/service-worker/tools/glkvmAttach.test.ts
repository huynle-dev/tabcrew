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
    get: vi.fn(),
  },
};

Object.assign(globalThis, { chrome: chromeStub });

const { GlkvmAttachTool } = await import("./glkvmAttach.js");

function parseJsonResult(
  result: Awaited<
    ReturnType<InstanceType<typeof GlkvmAttachTool>["execute"]>
  >,
) {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  if (!block || block.type !== "text") throw new Error("Expected text content");
  return JSON.parse(block.text);
}

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 42,
    url: "https://kvm.example.com/#/",
    title: "GLKVM",
    active: false,
    pinned: false,
    highlighted: false,
    incognito: false,
    index: 0,
    windowId: 7,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    ...overrides,
  };
}

describe("GlkvmAttachTool", () => {
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

  it("keeps explicit integer tab ID validation before Chrome lookup", async () => {
    const result = await new GlkvmAttachTool().execute(
      { tabId: "42" },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(chromeStub.tabs.get).not.toHaveBeenCalled();
    expect(addTabToGroupMock).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "invalid_tab_id",
      error: expect.stringContaining("integer tabId"),
    });
  });

  it("attaches an existing GLKVM tab to the current OpenCode session group", async () => {
    chromeStub.tabs.get.mockResolvedValueOnce(
      makeTab({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM - Server",
      }),
    );
    addTabToGroupMock.mockResolvedValueOnce(101);
    chromeStub.tabs.get.mockResolvedValue(
      makeTab({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM - Server",
        status: "complete",
      }),
    );

    const result = await new GlkvmAttachTool().execute(
      { tabId: 42 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(true);
    expect(chromeStub.tabs.get).toHaveBeenCalledWith(42);
    expect(addTabToGroupMock).toHaveBeenCalledWith(42, "scope-a");
    expect(parseJsonResult(result)).toMatchObject({
      tabId: 42,
      groupId: 101,
      tab: {
        tabId: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM - Server",
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

  it("uses shared readiness polling after grouping and succeeds after delayed frame readiness", async () => {
    chromeStub.tabs.get.mockResolvedValue(
      makeTab({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
        status: "complete",
      }),
    );
    addTabToGroupMock.mockResolvedValueOnce(101);
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

    const pending = new GlkvmAttachTool().execute(
      { tabId: 42, timeout: 1000, pollInterval: 10 },
      { sessionScope: "scope-a" },
    );

    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(addTabToGroupMock).toHaveBeenCalledWith(42, "scope-a");
    expect(sendCommandMock).toHaveBeenCalledTimes(2);
    expect(parseJsonResult(result)).toMatchObject({
      tabId: 42,
      groupId: 101,
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

  it("waits for a delayed GLKVM title after grouping", async () => {
    chromeStub.tabs.get
      .mockResolvedValueOnce(
        makeTab({
          id: 42,
          url: "https://kvm.example.com/#/",
          title: "",
          status: "loading",
        }),
      )
      .mockResolvedValueOnce(
        makeTab({
          id: 42,
          url: "https://kvm.example.com/#/",
          title: "",
          status: "complete",
        }),
      )
      .mockResolvedValueOnce(
        makeTab({
          id: 42,
          url: "https://kvm.example.com/#/",
          title: "GLKVM",
          status: "complete",
        }),
      );
    addTabToGroupMock.mockResolvedValueOnce(101);

    const pending = new GlkvmAttachTool().execute(
      { tabId: 42, timeout: 1000, pollInterval: 10 },
      { sessionScope: "scope-a" },
    );

    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(addTabToGroupMock).toHaveBeenCalledWith(42, "scope-a");
    expect(chromeStub.tabs.get).toHaveBeenCalledTimes(3);
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

  it("waits for a delayed final GLKVM URL after grouping", async () => {
    chromeStub.tabs.get
      .mockResolvedValueOnce(
        makeTab({
          id: 42,
          url: "",
          pendingUrl: "https://kvm.example.com/#/",
          title: "GLKVM",
          status: "loading",
        }),
      )
      .mockResolvedValueOnce(
        makeTab({ id: 42, url: "", title: "GLKVM", status: "complete" }),
      )
      .mockResolvedValueOnce(
        makeTab({
          id: 42,
          url: "https://kvm.example.com/#/",
          title: "GLKVM",
          status: "complete",
        }),
      );
    addTabToGroupMock.mockResolvedValueOnce(101);

    const pending = new GlkvmAttachTool().execute(
      { tabId: 42, timeout: 1000, pollInterval: 10 },
      { sessionScope: "scope-a" },
    );

    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(addTabToGroupMock).toHaveBeenCalledWith(42, "scope-a");
    expect(chromeStub.tabs.get).toHaveBeenCalledTimes(3);
    expect(parseJsonResult(result)).toMatchObject({
      tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example.com/#/" },
      status: { readiness: { pagePresent: true, reason: "frame_ready" } },
    });
  });

  it("returns a structured not-ready timeout after ownership when a frame never arrives", async () => {
    chromeStub.tabs.get.mockResolvedValue(
      makeTab({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
        status: "complete",
      }),
    );
    addTabToGroupMock.mockResolvedValueOnce(101);
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

    const pending = new GlkvmAttachTool().execute(
      { tabId: 42, timeout: 25, pollInterval: 10 },
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

  it("returns a clear missing-tab error before grouping", async () => {
    chromeStub.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 999"));

    const result = await new GlkvmAttachTool().execute(
      { tabId: 999 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(addTabToGroupMock).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "tab_not_found",
      error: expect.stringContaining("Tab 999 was not found"),
    });
  });

  it("returns a clear non-GLKVM error with tab diagnostics before grouping", async () => {
    chromeStub.tabs.get.mockResolvedValueOnce(
      makeTab({
        id: 42,
        url: "https://example.com/#/",
        title: "Dashboard",
      }),
    );

    const result = await new GlkvmAttachTool().execute(
      { tabId: 42 },
      { sessionScope: "scope-a" },
    );

    expect(result.success).toBe(false);
    expect(addTabToGroupMock).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "not_glkvm_tab",
      tab: {
        tabId: 42,
        url: "https://example.com/#/",
        title: "Dashboard",
      },
      error: expect.stringContaining("Expected a GLKVM page"),
    });
  });

  it("returns a clear group API error when ownership assignment fails", async () => {
    chromeStub.tabs.get.mockResolvedValueOnce(
      makeTab({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      }),
    );
    addTabToGroupMock.mockRejectedValueOnce(new Error("group failed"));

    const result = await new GlkvmAttachTool().execute(
      { tabId: 42 },
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
