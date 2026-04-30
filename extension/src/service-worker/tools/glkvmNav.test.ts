import { beforeEach, describe, expect, it, vi } from "vitest";

const sequenceMock = vi.hoisted(() => ({
  execute: vi.fn(),
  GlkvmSequenceTool: vi.fn(function GlkvmSequenceTool(this: { execute: typeof sequenceMock.execute }) {
    this.execute = sequenceMock.execute;
  }),
}));

vi.mock("./glkvmSequence.js", () => ({ GlkvmSequenceTool: sequenceMock.GlkvmSequenceTool }));

const { GlkvmNavTool } = await import("./glkvmNav.js");

function parseJsonResult(result: Awaited<ReturnType<InstanceType<typeof GlkvmNavTool>["execute"]>>) {
  const block = result.content[0];
  expect(block.type).toBe("text");
  if (block.type !== "text") throw new Error("Expected text content");
  return JSON.parse(block.text);
}

describe("GlkvmNavTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sequenceMock.execute.mockResolvedValue({ success: true, content: [{ type: "text", text: JSON.stringify({ completed: true }) }] });
  });

  it("expands OS-independent macros with unknown OS and delegates once to the owned-tab sequence tool", async () => {
    const context = { sessionScope: "scope-a" };
    const result = await new GlkvmNavTool().execute({ tabId: 42, sessionId: "hid-1", macro: "confirm", timeout: 1234, pollInterval: 50 }, context);

    expect(result.success).toBe(true);
    expect(sequenceMock.GlkvmSequenceTool).toHaveBeenCalledTimes(1);
    expect(sequenceMock.execute).toHaveBeenCalledTimes(1);
    expect(sequenceMock.execute).toHaveBeenCalledWith({
      tabId: 42,
      sessionId: "hid-1",
      steps: [
        { action: "key", key: "Enter" },
        { action: "wait", timeout: 1234, pollInterval: 50 },
      ],
    }, context);
  });

  it("expands field navigation macros without requiring an OS profile", async () => {
    await new GlkvmNavTool().execute({ tabId: 42, macro: "next_field" }, {});
    await new GlkvmNavTool().execute({ tabId: 42, macro: "previous_field" }, {});

    expect(sequenceMock.execute).toHaveBeenNthCalledWith(1, { tabId: 42, steps: [{ action: "key", key: "Tab" }, { action: "wait" }] }, {});
    expect(sequenceMock.execute).toHaveBeenNthCalledWith(2, { tabId: 42, steps: [{ action: "key", key: "Shift+Tab", keyAction: "hotkey" }, { action: "wait" }] }, {});
  });

  it.each([
    ["macos", "Meta+Tab"],
    ["windows", "Alt+Tab"],
    ["linux", "Alt+Tab"],
  ] as const)("expands app_switch for %s", async (os, key) => {
    await new GlkvmNavTool().execute({ tabId: 42, macro: "app_switch", os }, {});

    expect(sequenceMock.execute).toHaveBeenCalledWith({ tabId: 42, steps: [{ action: "key", key, keyAction: "hotkey" }, { action: "wait" }] }, {});
  });

  it.each([
    ["macos", "Meta"],
    ["windows", "Alt"],
    ["linux", "Alt"],
  ] as const)("expands app_switch_n by holding the %s modifier", async (os, modifier) => {
    await new GlkvmNavTool().execute({ tabId: 42, macro: "app_switch_n", os, count: 3 }, {});

    expect(sequenceMock.execute).toHaveBeenCalledWith({
      tabId: 42,
      steps: [
        { action: "key", key: modifier, keyAction: "down" },
        { action: "key", key: "Tab" },
        { action: "key", key: "Tab" },
        { action: "key", key: "Tab" },
        { action: "key", key: modifier, keyAction: "up" },
        { action: "wait" },
      ],
    }, {});
  });

  it.each([
    ["macos", "Meta+Space"],
    ["windows", "Meta"],
    ["linux", "Alt+F2"],
  ] as const)("expands open_launcher for %s", async (os, key) => {
    await new GlkvmNavTool().execute({ tabId: 42, macro: "open_launcher", os }, {});

    expect(sequenceMock.execute).toHaveBeenCalledWith({ tabId: 42, steps: [{ action: "key", key, keyAction: "hotkey" }, { action: "wait" }] }, {});
  });

  it("expands open_app through launcher, typing, Enter, and final wait", async () => {
    await new GlkvmNavTool().execute({ tabId: 42, macro: "open_app", os: "linux", app: "Terminal", timeout: 2000 }, {});

    expect(sequenceMock.execute).toHaveBeenCalledWith({
      tabId: 42,
      steps: [
        { action: "key", key: "Alt+F2", keyAction: "hotkey" },
        { action: "wait", timeout: 2000 },
        { action: "type", text: "Terminal" },
        { action: "key", key: "Enter" },
        { action: "wait", timeout: 2000 },
      ],
    }, {});
  });

  it.each(["app_switch", "app_switch_n", "open_launcher", "open_app"] as const)("rejects %s for unknown OS without delegating", async (macro) => {
    const result = await new GlkvmNavTool().execute({ tabId: 42, macro, app: "Terminal" }, {});

    expect(result.success).toBe(false);
    expect(sequenceMock.execute).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({ errorType: "nav_validation_error" });
    expect(parseJsonResult(result).error).toContain("requires os to be one of");
  });

  it.each([
    [{ macro: "confirm" }, 'The "tabId" argument is required for GLKVM nav'],
    [{ tabId: 1.2, macro: "confirm" }, 'The "tabId" argument is required for GLKVM nav'],
    [{ tabId: 42, macro: "bogus" }, "Unsupported GLKVM nav macro"],
    [{ tabId: 42, macro: "app_switch", os: "beos" }, "Unsupported GLKVM nav os"],
    [{ tabId: 42, macro: "app_switch_n", os: "macos", count: 0 }, 'The "count" argument must be a positive integer'],
    [{ tabId: 42, macro: "open_app", os: "macos", app: "" }, 'The "app" argument is required'],
  ])("returns structured validation errors for %j", async (args, expectedError) => {
    const result = await new GlkvmNavTool().execute(args, {});

    expect(result.success).toBe(false);
    expect(sequenceMock.execute).not.toHaveBeenCalled();
    expect(parseJsonResult(result)).toMatchObject({ completed: false, errorType: "nav_validation_error", error: expectedError });
  });
});
