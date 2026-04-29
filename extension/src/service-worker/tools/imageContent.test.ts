import { beforeEach, describe, expect, it, vi } from "vitest";

const cdpManagerMock = vi.hoisted(() => ({
  isAttached: vi.fn(),
  attach: vi.fn(),
  captureScreenshot: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock("../cdp.js", () => ({
  cdpManager: cdpManagerMock,
}));

const chromeStub = {
  tabs: {
    sendMessage: vi.fn(),
  },
  runtime: {
    ContextType: {
      OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT",
    },
    getContexts: vi.fn(),
    getURL: vi.fn(),
    sendMessage: vi.fn(),
  },
  offscreen: {
    createDocument: vi.fn(),
  },
};

Object.assign(globalThis, { chrome: chromeStub });

const { ComputerTool } = await import("./computer.js");
const { GifCreatorTool } = await import("./gifCreator.js");

describe("image content responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    cdpManagerMock.isAttached.mockReturnValue(true);
    cdpManagerMock.attach.mockResolvedValue(undefined);
    cdpManagerMock.captureScreenshot.mockResolvedValue({
      data: "jpeg-data",
      dimensions: { width: 800, height: 600 },
    });
    cdpManagerMock.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      }

      if (method === "Page.captureScreenshot") {
        return { data: "frame-data" };
      }

      throw new Error(`Unexpected CDP method: ${String(method)}`);
    });

    chromeStub.tabs.sendMessage.mockResolvedValue(undefined);
    chromeStub.runtime.getContexts.mockResolvedValue([]);
    chromeStub.runtime.getURL.mockImplementation((path: string) =>
      `chrome-extension://test/${path}`,
    );
    chromeStub.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: "gif-data",
    });
    chromeStub.offscreen.createDocument.mockResolvedValue(undefined);
  });

  it("returns computer screenshots using MCP image data and mimeType fields", async () => {
    const result = await new ComputerTool().execute(
      { action: "screenshot", tabId: 123 },
      {},
    );

    expect(result.success).toBe(true);
    expect(result.content[0]).toEqual({
      type: "image",
      data: "jpeg-data",
      mimeType: "image/jpeg",
    });
  });

  it("returns completed GIFs using MCP image data and mimeType fields", async () => {
    const tool = new GifCreatorTool();

    await tool.execute({ action: "start", tabId: 123 }, {});
    await tool.execute({ action: "screenshot", tabId: 123 }, {});
    const result = await tool.execute(
      { action: "stop", tabId: 123, delay: 25 },
      {},
    );

    expect(result.success).toBe(true);
    expect(result.content[0]).toEqual({
      type: "image",
      data: "gif-data",
      mimeType: "image/gif",
    });
  });
});
