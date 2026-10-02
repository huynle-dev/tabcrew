import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendCommand = vi.fn();
const captureScreenshot = vi.fn();
const attach = vi.fn();
const detach = vi.fn();
const isAttached = vi.fn(() => true);
const tabSendMessage = vi.fn();

vi.mock("../cdp.js", () => ({
  cdpManager: {
    attach,
    detach,
    isAttached,
    sendCommand,
    captureScreenshot,
  },
}));

const { ComputerTool } = await import("./computer.js");

describe("ComputerTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      tabs: {
        sendMessage: tabSendMessage,
      },
    });
    tabSendMessage.mockResolvedValue({ wasVisible: true });
    isAttached.mockReturnValue(true);
    sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { type: "undefined" } };
      }
      return {};
    });
    captureScreenshot.mockResolvedValue({
      data: "base64-jpeg",
      dimensions: { width: 1000, height: 800 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("performs repeated clicks in a single tool request", async () => {
    const tool = new ComputerTool();

    const result = await tool.execute(
      { action: "click", tabId: 1, x: 100, y: 200, count: 3 },
      {},
    );

    expect(result).toEqual({
      success: true,
      content: [{ type: "text", text: "Clicked 3 times at (100, 200)" }],
    });

    const mouseCommands = sendCommand.mock.calls.filter(
      ([, method]) => method === "Input.dispatchMouseEvent",
    );

    expect(mouseCommands.map(([, , params]) => params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
      "mousePressed",
      "mouseReleased",
      "mousePressed",
      "mouseReleased",
    ]);
  });

  it("keeps one-shot computer attachments alive briefly to avoid debugger infobar flicker", async () => {
    vi.useFakeTimers();
    isAttached.mockReturnValue(false);
    const tool = new ComputerTool();

    await tool.execute({ action: "key", tabId: 1, key: "Enter" }, {});

    expect(attach).toHaveBeenCalledWith(1);
    expect(detach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(detach).toHaveBeenCalledWith(1);
  });

  it("cancels a pending detach when another computer action starts on the tab", async () => {
    vi.useFakeTimers();
    isAttached.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const tool = new ComputerTool();

    await tool.execute({ action: "key", tabId: 1, key: "Enter" }, {});
    await vi.advanceTimersByTimeAsync(2500);
    await tool.execute({ action: "key", tabId: 1, key: "Tab" }, {});
    await vi.advanceTimersByTimeAsync(500);

    expect(detach).not.toHaveBeenCalled();
  });

  it("preserves existing CDP attachments it did not create", async () => {
    isAttached.mockReturnValue(true);
    const tool = new ComputerTool();

    await tool.execute({ action: "click", tabId: 1, x: 100, y: 200 }, {});

    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("temporarily hides the visual indicator while dispatching coordinate clicks", async () => {
    const tool = new ComputerTool();

    const result = await tool.execute(
      { action: "click", tabId: 1, x: 100, y: 200 },
      {},
    );

    expect(result.success).toBe(true);

    const inputIndex = sendCommand.mock.calls.findIndex(
      ([, method]) => method === "Input.dispatchMouseEvent",
    );
    const postIndex = tabSendMessage.mock.calls.findIndex(
      ([, message]) => message.action === "post_screenshot",
    );
    const firstInputOrder = sendCommand.mock.invocationCallOrder[inputIndex];
    const postOrder = tabSendMessage.mock.invocationCallOrder[postIndex];

    expect(tabSendMessage.mock.calls[0]).toEqual([
      1,
      { action: "pre_screenshot" },
    ]);
    expect(inputIndex).toBeGreaterThan(-1);
    expect(postIndex).toBeGreaterThan(-1);
    expect(postOrder).toBeGreaterThan(firstInputOrder);
    expect(tabSendMessage.mock.calls[postIndex]).toEqual([
      1,
      { action: "post_screenshot", wasVisible: true },
    ]);
  });

  it("captures a screenshot with a temporary grid overlay and removes it afterward", async () => {
    const tool = new ComputerTool();

    const result = await tool.execute(
      { action: "screenshot", tabId: 1, overlay: "temporary-grid" },
      {},
    );

    expect(result.success).toBe(true);
    expect(captureScreenshot).toHaveBeenCalledWith(1, {
      format: "jpeg",
      quality: 80,
      viewport: { width: 1000, height: 800 },
    });

    const runtimeExpressions = sendCommand.mock.calls
      .filter(([, method]) => method === "Runtime.evaluate")
      .map(([, , params]) => params.expression as string);

    expect(runtimeExpressions[0]).toContain("chromeuse-grid-overlay");
    expect(runtimeExpressions[0]).toContain("backgroundSize");
    expect(runtimeExpressions[0]).toContain("screenshotWidth");
    expect(runtimeExpressions.at(-1)).toContain("chromeuse-grid-overlay");
    expect(runtimeExpressions.at(-1)).toContain("remove");
  });

  it("returns viewport and scale metadata with screenshots", async () => {
    captureScreenshot.mockResolvedValueOnce({
      data: "base64-jpeg",
      dimensions: { width: 500, height: 400 },
    });
    const tool = new ComputerTool();

    const result = await tool.execute({ action: "screenshot", tabId: 1 }, {});

    const metadataText = result.content.find((block) => block.type === "text")?.text;
    expect(JSON.parse(metadataText ?? "{}")).toEqual({
      screenshot: { width: 500, height: 400 },
      viewport: { width: 1000, height: 800 },
      scale: {
        screenshotToViewportX: 2,
        screenshotToViewportY: 2,
        viewportToScreenshotX: 0.5,
        viewportToScreenshotY: 0.5,
      },
      coordinateSpace: "screenshot",
    });
  });

  it("draws temporary grid labels in screenshot coordinates", async () => {
    sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 2000, clientHeight: 1000 } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { type: "undefined" } };
      }
      return {};
    });
    captureScreenshot.mockResolvedValueOnce({
      data: "base64-jpeg",
      dimensions: { width: 1000, height: 500 },
    });
    const tool = new ComputerTool();

    await tool.execute(
      { action: "screenshot", tabId: 1, overlay: "temporary-grid" },
      {},
    );

    const gridExpression = sendCommand.mock.calls.find(
      ([, method, params]) =>
        method === "Runtime.evaluate" &&
        typeof params.expression === "string" &&
        params.expression.includes("backgroundSize"),
    )?.[2].expression as string;

    expect(gridExpression).toContain("const screenshotWidth = 1400");
    expect(gridExpression).toContain("const screenshotHeight = 700");
    expect(gridExpression).toContain("label.textContent = \"x\" + sx");
    expect(gridExpression).toContain("left: (sx * scaleX + 4) + \"px\"");
    expect(gridExpression).toContain("label.textContent = \"y\" + sy");
    expect(gridExpression).toContain("top: (sy * scaleY + 4) + \"px\"");
  });

  it("removes the temporary grid even when screenshot capture fails", async () => {
    captureScreenshot.mockRejectedValueOnce(new Error("capture failed"));
    const tool = new ComputerTool();

    const result = await tool.execute(
      { action: "screenshot", tabId: 1, overlay: "temporary-grid" },
      {},
    );

    expect(result.success).toBe(false);
    const errorText = result.content.find((block) => block.type === "text")?.text;
    expect(errorText).toContain("capture failed");

    const runtimeExpressions = sendCommand.mock.calls
      .filter(([, method]) => method === "Runtime.evaluate")
      .map(([, , params]) => params.expression as string);

    expect(runtimeExpressions.at(-1)).toContain("chromeuse-grid-overlay");
    expect(runtimeExpressions.at(-1)).toContain("remove");
  });

  it("moves through multiple points in one tool request", async () => {
    const tool = new ComputerTool();

    const result = await tool.execute(
      {
        action: "move_path",
        tabId: 1,
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
          { x: 50, y: 60 },
        ],
      },
      {},
    );

    expect(result).toEqual({
      success: true,
      content: [{ type: "text", text: "Moved mouse through 3 points" }],
    });

    const mouseCommands = sendCommand.mock.calls.filter(
      ([, method]) => method === "Input.dispatchMouseEvent",
    );

    expect(mouseCommands.map(([, , params]) => params)).toEqual([
      expect.objectContaining({ type: "mouseMoved", x: 10, y: 20 }),
      expect.objectContaining({ type: "mouseMoved", x: 30, y: 40 }),
      expect.objectContaining({ type: "mouseMoved", x: 50, y: 60 }),
    ]);
  });

  it("dispatches drag as a realistic left-button pointer sequence", async () => {
    const tool = new ComputerTool();

    const result = await tool.execute(
      { action: "drag", tabId: 1, startX: 100, startY: 200, endX: 200, endY: 300 },
      {},
    );

    expect(result.success).toBe(true);

    const mouseCommands = sendCommand.mock.calls
      .filter(([, method]) => method === "Input.dispatchMouseEvent")
      .map(([, , params]) => params);

    expect(mouseCommands[0]).toEqual(expect.objectContaining({
      type: "mouseMoved",
      x: 100,
      y: 200,
      button: "none",
      buttons: 0,
    }));
    expect(mouseCommands[1]).toEqual(expect.objectContaining({
      type: "mousePressed",
      x: 100,
      y: 200,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }));
    expect(mouseCommands.slice(2, -1)).toHaveLength(10);
    expect(mouseCommands.slice(2, -1).every((params) =>
      params.type === "mouseMoved" &&
      params.button === "none" &&
      params.buttons === 1 &&
      params.clickCount === 0,
    )).toBe(true);
    expect(mouseCommands.at(-1)).toEqual(expect.objectContaining({
      type: "mouseReleased",
      x: 200,
      y: 300,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }));
  });

  it("dispatches CapsLock as a recognized keyboard key", async () => {
    const tool = new ComputerTool();

    const result = await tool.execute({ action: "key", tabId: 1, key: "CapsLock" }, {});

    expect(result).toEqual({
      success: true,
      content: [{ type: "text", text: "Pressed key: CapsLock" }],
    });

    const keyCommands = sendCommand.mock.calls.filter(
      ([, method]) => method === "Input.dispatchKeyEvent",
    );
    expect(keyCommands.map(([, , params]) => params)).toEqual([
      expect.objectContaining({
        type: "keyDown",
        key: "CapsLock",
        code: "CapsLock",
        windowsVirtualKeyCode: 20,
      }),
      expect.objectContaining({
        type: "keyUp",
        key: "CapsLock",
        code: "CapsLock",
        windowsVirtualKeyCode: 20,
      }),
    ]);
  });

  it("uses shifted printable key text for letter shortcuts", async () => {
    const tool = new ComputerTool();

    await tool.execute({ action: "key", tabId: 1, key: "shift+a" }, {});

    const keyDown = sendCommand.mock.calls.find(
      ([, method, params]) => method === "Input.dispatchKeyEvent" && params.type === "keyDown",
    )?.[2];

    expect(keyDown).toEqual(expect.objectContaining({
      key: "A",
      code: "KeyA",
      text: "A",
      modifiers: 8,
    }));
  });

  it("maps shifted digit punctuation and digit codes correctly", async () => {
    const tool = new ComputerTool();

    await tool.execute({ action: "key", tabId: 1, key: "shift+1" }, {});

    const keyDown = sendCommand.mock.calls.find(
      ([, method, params]) => method === "Input.dispatchKeyEvent" && params.type === "keyDown",
    )?.[2];

    expect(keyDown).toEqual(expect.objectContaining({
      key: "!",
      code: "Digit1",
      text: "!",
      windowsVirtualKeyCode: 49,
      modifiers: 8,
    }));
  });

  it("maps slash shortcuts to slash code instead of a letter code", async () => {
    const tool = new ComputerTool();

    await tool.execute({ action: "key", tabId: 1, key: "cmd+/" }, {});

    const keyDown = sendCommand.mock.calls.find(
      ([, method, params]) => method === "Input.dispatchKeyEvent" && params.type === "keyDown",
    )?.[2];

    expect(keyDown).toEqual(expect.objectContaining({
      key: "/",
      code: "Slash",
      windowsVirtualKeyCode: 191,
      modifiers: 4,
    }));
  });
});
