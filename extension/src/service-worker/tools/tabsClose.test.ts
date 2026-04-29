import { beforeEach, describe, expect, it, vi } from "vitest";

const hidTransportMock = vi.hoisted(() => ({
  cleanupSessionsForTab: vi.fn(),
}));

vi.mock("./kvmHidTransport.js", () => hidTransportMock);

const chromeStub = {
  tabs: {
    remove: vi.fn(),
  },
};

Object.assign(globalThis, { chrome: chromeStub });

const { TabsCloseTool } = await import("./tabsClose.js");

function parseJsonResult(
  result: Awaited<ReturnType<InstanceType<typeof TabsCloseTool>["execute"]>>,
) {
  expect(result.content[0].type).toBe("text");
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

describe("TabsCloseTool HID cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chromeStub.tabs.remove.mockResolvedValue(undefined);
    hidTransportMock.cleanupSessionsForTab.mockResolvedValue([]);
  });

  it("runs release-all HID cleanup before closing tabs", async () => {
    hidTransportMock.cleanupSessionsForTab.mockResolvedValueOnce([
      {
        tabId: 42,
        sessionId: "__oc_kvm_test",
        ok: true,
        releasedKeys: 1,
        releasedButtons: 0,
      },
    ]);

    const result = await new TabsCloseTool().execute({ tabId: 42 }, {});

    expect(result.success).toBe(true);
    expect(hidTransportMock.cleanupSessionsForTab).toHaveBeenCalledWith(42, {
      releaseAll: true,
      close: true,
    });
    expect(chromeStub.tabs.remove).toHaveBeenCalledWith([42]);
    expect(parseJsonResult(result)).toMatchObject({
      closed: [42],
      count: 1,
      hidCleanup: [
        {
          tabId: 42,
          sessionId: "__oc_kvm_test",
          ok: true,
          releasedKeys: 1,
        },
      ],
    });
  });

  it("still closes the tab when HID cleanup reports a cleanup failure", async () => {
    hidTransportMock.cleanupSessionsForTab.mockResolvedValueOnce([
      {
        tabId: 42,
        sessionId: "__oc_kvm_test",
        ok: false,
        cleanupFailed: true,
        error: "release failed",
      },
    ]);

    const result = await new TabsCloseTool().execute({ tabId: 42 }, {});

    expect(result.success).toBe(true);
    expect(chromeStub.tabs.remove).toHaveBeenCalledWith([42]);
    expect(parseJsonResult(result).hidCleanup[0]).toMatchObject({
      ok: false,
      cleanupFailed: true,
      error: "release failed",
    });
  });

  it("preserves the primary tab-close failure separately from cleanup metadata", async () => {
    hidTransportMock.cleanupSessionsForTab.mockResolvedValueOnce([
      { tabId: 42, sessionId: "__oc_kvm_test", ok: true },
    ]);
    chromeStub.tabs.remove.mockRejectedValueOnce(new Error("No tab with id: 42"));

    const result = await new TabsCloseTool().execute({ tabId: 42 }, {});

    expect(result.success).toBe(false);
    expect(parseJsonResult(result)).toMatchObject({
      errorType: "tab_close_error",
      error: "Failed to close tab(s): No tab with id: 42",
      hidCleanup: [{ tabId: 42, sessionId: "__oc_kvm_test", ok: true }],
    });
  });
});
