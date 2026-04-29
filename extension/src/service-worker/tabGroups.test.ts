import { beforeEach, describe, expect, it, vi } from "vitest";

const chromeStub = {
  tabs: {
    get: vi.fn(),
    group: vi.fn(),
  },
  tabGroups: {
    get: vi.fn(),
    update: vi.fn(),
  },
};

Object.assign(globalThis, { chrome: chromeStub });

const { TabGroupManager } = await import("./tabGroups.js");
type TabOwnershipResult = Awaited<
  ReturnType<InstanceType<typeof TabGroupManager>["validateOwnedTab"]>
>;
type TabOwnershipFailure = Extract<TabOwnershipResult, { ok: false }>;

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
    windowId: 1,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: 101,
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<chrome.tabGroups.TabGroup> = {},
): chrome.tabGroups.TabGroup {
  return {
    id: 101,
    title: "OpenCode",
    color: "blue",
    collapsed: false,
    windowId: 1,
    ...overrides,
  };
}

async function managerTrackingGroup(
  sessionScope = "scope-a",
): Promise<InstanceType<typeof TabGroupManager>> {
  const manager = new TabGroupManager();
  chromeStub.tabs.group.mockResolvedValueOnce(101);
  chromeStub.tabGroups.update.mockResolvedValueOnce(makeGroup());
  await manager.addTabToGroup(42, sessionScope);
  vi.clearAllMocks();
  return manager;
}

function expectFailure(result: TabOwnershipResult): TabOwnershipFailure {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected ownership validation failure");
  }
  return result;
}

describe("TabGroupManager owned tab validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when the tab belongs to the tracked OpenCode group", async () => {
    const manager = await managerTrackingGroup();
    chromeStub.tabs.get.mockResolvedValueOnce(makeTab({ id: 42, groupId: 101 }));
    chromeStub.tabGroups.get.mockResolvedValueOnce(makeGroup({ id: 101 }));

    const result = await manager.validateOwnedTab(42, "scope-a");

    expect(result).toEqual({ ok: true, tabId: 42, groupId: 101 });
  });

  it("fails when no OpenCode group is tracked for the session", async () => {
    const manager = new TabGroupManager();

    const result = await manager.validateOwnedTab(42, "missing-scope");

    const failure = expectFailure(result);
    expect(failure).toMatchObject({
      ok: false,
      code: "NO_TRACKED_GROUP",
      tabId: 42,
      sessionScope: "missing-scope",
    });
    expect(failure.message).toContain("No OpenCode tab group is tracked");
    expect(chromeStub.tabs.get).not.toHaveBeenCalled();
  });

  it("fails when the tracked OpenCode group was removed", async () => {
    const manager = await managerTrackingGroup();
    chromeStub.tabGroups.get.mockRejectedValueOnce(new Error("No group"));

    const result = await manager.validateOwnedTab(42, "scope-a");

    const failure = expectFailure(result);
    expect(failure).toMatchObject({
      ok: false,
      code: "TRACKED_GROUP_REMOVED",
      tabId: 42,
      groupId: 101,
    });
    expect(failure.message).toContain("tracked OpenCode tab group no longer exists");
    expect(chromeStub.tabs.get).not.toHaveBeenCalled();
  });

  it("fails closed when the tracked OpenCode group was manually renamed", async () => {
    const manager = await managerTrackingGroup();
    chromeStub.tabGroups.get.mockResolvedValueOnce(
      makeGroup({ id: 101, title: "Manual Name" }),
    );

    const result = await manager.validateOwnedTab(42, "scope-a");

    const failure = expectFailure(result);
    expect(failure).toMatchObject({
      ok: false,
      code: "TRACKED_GROUP_RENAMED",
      tabId: 42,
      groupId: 101,
      actualTitle: "Manual Name",
    });
    expect(failure.message).toContain("renamed");
    expect(chromeStub.tabs.get).not.toHaveBeenCalled();
  });

  it("fails when the tab does not exist", async () => {
    const manager = await managerTrackingGroup();
    chromeStub.tabGroups.get.mockResolvedValueOnce(makeGroup({ id: 101 }));
    chromeStub.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 42"));

    const result = await manager.validateOwnedTab(42, "scope-a");

    const failure = expectFailure(result);
    expect(failure).toMatchObject({
      ok: false,
      code: "TAB_NOT_FOUND",
      tabId: 42,
      groupId: 101,
    });
    expect(failure.message).toContain("Tab 42 was not found");
  });

  it("fails when the tab is ungrouped", async () => {
    const manager = await managerTrackingGroup();
    chromeStub.tabGroups.get.mockResolvedValueOnce(makeGroup({ id: 101 }));
    chromeStub.tabs.get.mockResolvedValueOnce(makeTab({ id: 42, groupId: -1 }));

    const result = await manager.validateOwnedTab(42, "scope-a");

    const failure = expectFailure(result);
    expect(failure).toMatchObject({
      ok: false,
      code: "TAB_UNGROUPED",
      tabId: 42,
      groupId: 101,
      actualGroupId: -1,
    });
    expect(failure.message).toContain("not in any tab group");
  });

  it("fails when the tab belongs to a different group", async () => {
    const manager = await managerTrackingGroup();
    chromeStub.tabGroups.get.mockResolvedValueOnce(makeGroup({ id: 101 }));
    chromeStub.tabs.get.mockResolvedValueOnce(makeTab({ id: 42, groupId: 202 }));

    const result = await manager.validateOwnedTab(42, "scope-a");

    const failure = expectFailure(result);
    expect(failure).toMatchObject({
      ok: false,
      code: "TAB_IN_DIFFERENT_GROUP",
      tabId: 42,
      groupId: 101,
      actualGroupId: 202,
    });
    expect(failure.message).toContain("different tab group");
  });
});
