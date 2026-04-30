import { beforeEach, describe, expect, it, vi } from "vitest";

const chromeStub = {
  tabs: {
    get: vi.fn(),
    sendMessage: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
};

Object.assign(globalThis, { chrome: chromeStub });

const { ReadPageTool } = await import("./readPage.js");

describe("ReadPageTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    chromeStub.tabs.get.mockResolvedValue({ id: 123 });
    chromeStub.tabs.sendMessage
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce({ success: true, data: "Page text" });
    chromeStub.scripting.executeScript.mockResolvedValue(undefined);
  });

  it("injects the bundled accessibility content script from dist on fallback", async () => {
    const result = await new ReadPageTool().execute(
      { tabId: 123, format: "accessibility" },
      {},
    );

    expect(result.success).toBe(true);
    expect(chromeStub.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 123 },
      files: ["dist/content-scripts/accessibilityTree.js"],
    });
  });
});
