import { beforeEach, describe, expect, it, vi } from "vitest";

const addTabToGroupMock = vi.hoisted(() => vi.fn());

vi.mock("../tabGroups.js", () => ({
  tabGroupManager: {
    addTabToGroup: addTabToGroupMock,
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
    vi.clearAllMocks();
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
