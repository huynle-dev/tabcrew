import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../../types/messages.js";

const addTabToGroup = vi.fn<(tabId: number, sessionScope?: string) => Promise<number>>();
const recordAutomationTab = vi.fn();

vi.mock("../tabGroups.js", () => ({
  tabGroupManager: { addTabToGroup },
}));

vi.mock("../sidePanelHandler.js", () => ({ recordAutomationTab }));

const { TabsCreateTool } = await import("./tabsCreate.js");

function resultText(result: ToolResult): string {
  const block = result.content[0];
  if (block.type !== "text") throw new Error("Expected text result");
  return block.text;
}

describe("TabsCreateTool", () => {
  const create = vi.fn();
  const get = vi.fn();
  const update = vi.fn();
  const focusWindow = vi.fn();
  const getGroup = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      tabs: { create, get, update },
      windows: { update: focusWindow },
      tabGroups: { get: getGroup },
    });
    create.mockResolvedValue({
      id: 42,
      url: "https://example.com",
      windowId: 1,
      active: true,
    });
    get
      .mockResolvedValueOnce({ id: 42, windowId: 1, active: true })
      .mockResolvedValue({ id: 42, windowId: 9, active: false });
    update.mockResolvedValue({ id: 42, active: true });
    focusWindow.mockResolvedValue({ id: 9, focused: true });
    getGroup.mockResolvedValue({ id: 7, windowId: 9 });
    addTabToGroup.mockResolvedValue(7);
  });

  it("restores an active tab after grouping may move it to another window", async () => {
    const result = await new TabsCreateTool().execute(
      { url: "https://example.com", active: true },
      { sessionScope: "session-1" },
    );

    expect(result.success).toBe(true);
    expect(addTabToGroup).toHaveBeenCalledWith(42, "session-1");
    expect(getGroup).toHaveBeenCalledWith(7);
    expect(focusWindow).toHaveBeenCalledWith(9, { focused: true });
    expect(update).toHaveBeenCalledWith(42, { active: true });
    expect(JSON.parse(resultText(result))).toMatchObject({
      windowId: 9,
      active: true,
    });
  });

  it("does not activate a tab requested in the background", async () => {
    create.mockResolvedValue({
      id: 43,
      url: "https://example.com",
      windowId: 1,
      active: false,
    });

    const result = await new TabsCreateTool().execute(
      { url: "https://example.com", active: false },
      { sessionScope: "session-1" },
    );

    expect(result.success).toBe(true);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
