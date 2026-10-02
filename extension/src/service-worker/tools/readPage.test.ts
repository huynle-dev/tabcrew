import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReadPageTool } from "./readPage.js";

const getTab = vi.fn();
const sendMessage = vi.fn();
const executeScript = vi.fn();

describe("ReadPageTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTab.mockResolvedValue({ id: 7 });
    sendMessage.mockResolvedValue({ success: true, data: "[ref_1] main" });
    vi.stubGlobal("chrome", {
      tabs: { get: getTab, sendMessage },
      scripting: { executeScript },
    });
  });

  it("reads accessibility content from the main frame only", async () => {
    const result = await new ReadPageTool().execute(
      { tabId: 7, format: "accessibility" },
      {},
    );

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { action: "get_accessibility_tree", format: "accessibility" },
      { frameId: 0 },
    );
  });
});
