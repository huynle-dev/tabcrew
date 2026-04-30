import { beforeEach, describe, expect, it, vi } from "vitest";

const addTabToGroupMock = vi.hoisted(() => vi.fn());

vi.mock("../tabGroups.js", () => ({
  tabGroupManager: {
    addTabToGroup: addTabToGroupMock,
  },
}));

const chromeStub = {
  tabs: {
    create: vi.fn(),
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
    vi.clearAllMocks();
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
});
