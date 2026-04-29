import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available before module imports
// ---------------------------------------------------------------------------

const cdpManagerMock = vi.hoisted(() => ({
  isAttached: vi.fn(),
  attach: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock("./cdp.js", () => ({
  cdpManager: cdpManagerMock,
}));

// Minimal chrome stub covering tabs API used by glkvmTab utilities
const chromeStub = {
  tabs: {
    query: vi.fn(),
    get: vi.fn(),
  },
};

Object.assign(globalThis, { chrome: chromeStub });

// Dynamic import AFTER mocks are wired up
const {
  findGlkvmTabs,
  resolveGlkvmTab,
  getVideoMetadata,
} = await import("./glkvmTab.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal chrome.tabs.Tab stub */
function makeTab(overrides: {
  id: number;
  url: string;
  title: string;
}): chrome.tabs.Tab {
  return {
    id: overrides.id,
    url: overrides.url,
    title: overrides.title,
    active: false,
    pinned: false,
    highlighted: false,
    incognito: false,
    index: 0,
    windowId: 1,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
  };
}

// ---------------------------------------------------------------------------
// findGlkvmTabs
// ---------------------------------------------------------------------------

describe("findGlkvmTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no tabs are open", async () => {
    chromeStub.tabs.query.mockResolvedValue([]);
    const result = await findGlkvmTabs();
    expect(result).toEqual([]);
  });

  it("returns empty array when no GLKVM tabs exist", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({ id: 1, url: "https://example.com", title: "Example" }),
      makeTab({ id: 2, url: "https://github.com", title: "GitHub" }),
    ]);

    const result = await findGlkvmTabs();
    expect(result).toEqual([]);
  });

  it("detects a single GLKVM tab by URL hash and title", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      }),
      makeTab({ id: 11, url: "https://example.com", title: "Other" }),
    ]);

    const result = await findGlkvmTabs();
    expect(result).toEqual([
      { tabId: 10, title: "GLKVM", url: "https://kvm.example.com/#/" },
    ]);
  });

  it("detects multiple GLKVM tabs", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm1.example.com/#/",
        title: "GLKVM",
      }),
      makeTab({
        id: 20,
        url: "https://kvm2.example.com/#/server",
        title: "GLKVM - Server",
      }),
    ]);

    const result = await findGlkvmTabs();
    expect(result).toHaveLength(2);
    expect(result[0].tabId).toBe(10);
    expect(result[1].tabId).toBe(20);
  });

  it("requires both URL hash pattern AND GLKVM in title", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      // Has hash but wrong title
      makeTab({
        id: 1,
        url: "https://app.example.com/#/dashboard",
        title: "Dashboard",
      }),
      // Has GLKVM title but no hash
      makeTab({
        id: 2,
        url: "https://kvm.example.com/status",
        title: "GLKVM Status",
      }),
      // Both match
      makeTab({
        id: 3,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      }),
    ]);

    const result = await findGlkvmTabs();
    expect(result).toHaveLength(1);
    expect(result[0].tabId).toBe(3);
  });

  it("matches title containing GLKVM as substring", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 5,
        url: "https://kvm.local/#/",
        title: "GLKVM - My Server",
      }),
    ]);

    const result = await findGlkvmTabs();
    expect(result).toHaveLength(1);
  });

  it("skips tabs with undefined id", async () => {
    const tabNoId = makeTab({
      id: 0,
      url: "https://kvm.example.com/#/",
      title: "GLKVM",
    });
    // Simulate undefined id (can happen in some Chrome states)
    (tabNoId as { id: number | undefined }).id = undefined;

    chromeStub.tabs.query.mockResolvedValue([tabNoId]);

    const result = await findGlkvmTabs();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveGlkvmTab
// ---------------------------------------------------------------------------

describe("resolveGlkvmTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Explicit tabId ---

  it("resolves explicit tabId directly", async () => {
    chromeStub.tabs.get.mockResolvedValue(
      makeTab({
        id: 42,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      }),
    );

    const result = await resolveGlkvmTab({ tabId: 42 });
    expect(result.tabId).toBe(42);
    expect(result.tab.url).toBe("https://kvm.example.com/#/");
    expect(chromeStub.tabs.query).not.toHaveBeenCalled();
  });

  it("throws when explicit tabId does not exist", async () => {
    chromeStub.tabs.get.mockRejectedValue(new Error("No tab with id: 999"));

    await expect(resolveGlkvmTab({ tabId: 999 })).rejects.toThrow(
      "Tab 999 not found",
    );
  });

  it("explicit tabId takes precedence over target", async () => {
    chromeStub.tabs.get.mockResolvedValue(
      makeTab({ id: 42, url: "https://other.com", title: "Other" }),
    );

    const result = await resolveGlkvmTab({
      tabId: 42,
      target: "kvm.example.com",
    });
    expect(result.tabId).toBe(42);
    // Should NOT call tabs.query since tabId was explicit
    expect(chromeStub.tabs.query).not.toHaveBeenCalled();
  });

  // --- Target string matching ---

  it("resolves target by hostname match", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      }),
    ]);

    const result = await resolveGlkvmTab({ target: "kvm.example.com" });
    expect(result.tabId).toBe(10);
  });

  it("resolves target by full URL match", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm.example.com/#/",
        title: "GLKVM",
      }),
    ]);

    const result = await resolveGlkvmTab({
      target: "https://kvm.example.com/#/",
    });
    expect(result.tabId).toBe(10);
  });

  it("resolves target by partial hostname", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm.myserver.local/#/",
        title: "GLKVM",
      }),
    ]);

    const result = await resolveGlkvmTab({ target: "kvm" });
    expect(result.tabId).toBe(10);
  });

  it("target matching is case-insensitive", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://KVM.Example.COM/#/",
        title: "GLKVM",
      }),
    ]);

    const result = await resolveGlkvmTab({ target: "kvm.example.com" });
    expect(result.tabId).toBe(10);
  });

  it("throws when target matches no GLKVM tabs (zero tabs)", async () => {
    chromeStub.tabs.query.mockResolvedValue([]);

    await expect(
      resolveGlkvmTab({ target: "kvm.example.com" }),
    ).rejects.toThrow("No GLKVM tab found matching");
  });

  it("throws with list when target matches no tab but GLKVM tabs exist", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm-other.example.com/#/",
        title: "GLKVM",
      }),
    ]);

    await expect(
      resolveGlkvmTab({ target: "nonexistent.host" }),
    ).rejects.toThrow("Available GLKVM tabs");
  });

  // --- Auto-detection (no target or tabId) ---

  it("auto-detects single GLKVM tab", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({ id: 1, url: "https://example.com", title: "Example" }),
      makeTab({
        id: 50,
        url: "https://kvm.local/#/",
        title: "GLKVM",
      }),
    ]);

    const result = await resolveGlkvmTab();
    expect(result.tabId).toBe(50);
  });

  it("auto-detects when called with empty options", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 50,
        url: "https://kvm.local/#/",
        title: "GLKVM",
      }),
    ]);

    const result = await resolveGlkvmTab({});
    expect(result.tabId).toBe(50);
  });

  it("throws on zero GLKVM tabs with auto-detect", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({ id: 1, url: "https://example.com", title: "Example" }),
    ]);

    await expect(resolveGlkvmTab()).rejects.toThrow(
      "No GLKVM tab found. Open and log in",
    );
  });

  it("throws on multiple GLKVM tabs with auto-detect", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm1.example.com/#/",
        title: "GLKVM",
      }),
      makeTab({
        id: 20,
        url: "https://kvm2.example.com/#/",
        title: "GLKVM",
      }),
    ]);

    await expect(resolveGlkvmTab()).rejects.toThrow(
      "Multiple GLKVM tabs found",
    );
  });

  it("error for multiple tabs includes available tab list", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      makeTab({
        id: 10,
        url: "https://kvm1.example.com/#/",
        title: "GLKVM",
      }),
      makeTab({
        id: 20,
        url: "https://kvm2.example.com/#/",
        title: "GLKVM",
      }),
    ]);

    await expect(resolveGlkvmTab()).rejects.toThrow("kvm1.example.com");
  });
});

// ---------------------------------------------------------------------------
// getVideoMetadata
// ---------------------------------------------------------------------------

describe("getVideoMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cdpManagerMock.isAttached.mockReturnValue(true);
    cdpManagerMock.attach.mockResolvedValue(undefined);
  });

  it("returns video metadata when video element exists", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 1920,
          videoHeight: 1080,
          displayRect: { x: 0, y: 64, width: 960, height: 540 },
          visible: true,
        },
      },
    });

    const meta = await getVideoMetadata(42);
    expect(meta.videoWidth).toBe(1920);
    expect(meta.videoHeight).toBe(1080);
    expect(meta.displayRect).toEqual({
      x: 0,
      y: 64,
      width: 960,
      height: 540,
    });
    expect(meta.visible).toBe(true);
  });

  it("attaches CDP if not already attached", async () => {
    cdpManagerMock.isAttached.mockReturnValue(false);
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 1280,
          videoHeight: 720,
          displayRect: { x: 0, y: 0, width: 640, height: 360 },
          visible: true,
        },
      },
    });

    await getVideoMetadata(42);
    expect(cdpManagerMock.attach).toHaveBeenCalledWith(42);
  });

  it("does not re-attach if already attached", async () => {
    cdpManagerMock.isAttached.mockReturnValue(true);
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 1920,
          videoHeight: 1080,
          displayRect: { x: 0, y: 0, width: 1920, height: 1080 },
          visible: true,
        },
      },
    });

    await getVideoMetadata(42);
    expect(cdpManagerMock.attach).not.toHaveBeenCalled();
  });

  it("throws when no video element is found", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          error: "no_video",
          message: "No <video> element found on this page.",
        },
      },
    });

    await expect(getVideoMetadata(42)).rejects.toThrow(
      "No <video> element found",
    );
  });

  it("reports hidden video as not visible", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 0,
          videoHeight: 0,
          displayRect: { x: 0, y: 0, width: 0, height: 0 },
          visible: false,
        },
      },
    });

    const meta = await getVideoMetadata(42);
    expect(meta.visible).toBe(false);
    expect(meta.videoWidth).toBe(0);
    expect(meta.videoHeight).toBe(0);
  });

  it("handles zero-size display rect (collapsed element)", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 1920,
          videoHeight: 1080,
          displayRect: { x: 0, y: 0, width: 0, height: 0 },
          visible: false,
        },
      },
    });

    const meta = await getVideoMetadata(42);
    expect(meta.videoWidth).toBe(1920); // intrinsic size preserved
    expect(meta.displayRect.width).toBe(0);
    expect(meta.visible).toBe(false);
  });

  it("handles CDP evaluation exception", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: { type: "undefined" },
      exceptionDetails: {
        text: "Uncaught Error",
        exception: { description: "SecurityError: blocked" },
      },
    });

    await expect(getVideoMetadata(42)).rejects.toThrow(
      "Failed to detect video element: SecurityError: blocked",
    );
  });

  it("handles null result from evaluation", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: { type: "object", value: undefined },
    });

    await expect(getVideoMetadata(42)).rejects.toThrow(
      "no result returned",
    );
  });

  it("defaults missing displayRect fields to zero", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 1920,
          videoHeight: 1080,
          // displayRect missing entirely
          visible: true,
        },
      },
    });

    const meta = await getVideoMetadata(42);
    expect(meta.displayRect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("calls Runtime.evaluate with correct parameters", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          videoWidth: 1920,
          videoHeight: 1080,
          displayRect: { x: 0, y: 0, width: 1920, height: 1080 },
          visible: true,
        },
      },
    });

    await getVideoMetadata(99);

    expect(cdpManagerMock.sendCommand).toHaveBeenCalledWith(
      99,
      "Runtime.evaluate",
      expect.objectContaining({
        returnByValue: true,
        awaitPromise: false,
      }),
    );
  });
});
