import { beforeEach, describe, expect, it, vi } from "vitest";

const cdpManagerMock = vi.hoisted(() => ({
  isAttached: vi.fn(),
  attach: vi.fn(),
  sendCommand: vi.fn(),
}));

const glkvmTabMock = vi.hoisted(() => ({
  resolveGlkvmTab: vi.fn(),
  getVideoMetadata: vi.fn(),
}));

vi.mock("../cdp.js", () => ({
  cdpManager: cdpManagerMock,
}));

vi.mock("../glkvmTab.js", () => glkvmTabMock);

const {
  buildSnapshotOcrPath,
  GlkvmOcrError,
  GlkvmOcrTool,
  readKvmOcr,
  selectOcrPercent,
} = await import("./kvmOcr.js");

function mockEvalResult(value: Record<string, unknown>) {
  return { result: { type: "object", value } };
}

beforeEach(() => {
  vi.clearAllMocks();
  cdpManagerMock.isAttached.mockReturnValue(true);
  cdpManagerMock.attach.mockResolvedValue(undefined);
  glkvmTabMock.resolveGlkvmTab.mockResolvedValue({
    tabId: 42,
    tab: { tabId: 42, title: "GLKVM", url: "https://kvm.example/#/" },
  });
  glkvmTabMock.getVideoMetadata.mockResolvedValue({
    videoWidth: 1920,
    videoHeight: 1080,
    displayRect: { x: 0, y: 0, width: 960, height: 540 },
    visible: true,
  });
});

describe("selectOcrPercent", () => {
  it("maps a selected remote-frame region to the closest supported ocr_percent", () => {
    const percent = selectOcrPercent(
      { x: 120, y: 80, width: 180, height: 70 },
      { width: 1920, height: 1080 },
    );

    expect(percent).toBe(10);
  });

  it("caps large remote-frame regions at the largest confirmed ocr_percent", () => {
    const percent = selectOcrPercent(
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 1920, height: 1080 },
    );

    expect(percent).toBe(20);
  });
});

describe("GlkvmOcrTool", () => {
  it("resolves GLKVM metadata and returns OCR text from the optional wrapper", async () => {
    cdpManagerMock.sendCommand
      .mockResolvedValueOnce(
        mockEvalResult({
          ok: true,
          capabilities: {
            enabled: true,
            engine: "tesseract",
            langs: { default: ["eng"], available: ["eng"] },
          },
        }),
      )
      .mockResolvedValueOnce(
        mockEvalResult({
          ok: true,
          contentType: "application/json",
          text: "BIOS setup",
        }),
      );

    const result = await new GlkvmOcrTool().execute(
      {
        target: "kvm.example",
        sessionId: "ses_ocr",
        language: "eng",
        region: { x: 100, y: 100, width: 220, height: 80 },
      },
      {},
    );

    expect(result.success).toBe(true);
    expect(glkvmTabMock.resolveGlkvmTab).toHaveBeenCalledWith({
      target: "kvm.example",
    });
    expect(glkvmTabMock.getVideoMetadata).toHaveBeenCalledWith(42);
    const text = result.content[0];
    expect(text.type).toBe("text");
    if (text.type !== "text") throw new Error("Expected text content");
    expect(JSON.parse(text.text)).toMatchObject({
      sessionId: "ses_ocr",
      tabId: 42,
      text: "BIOS setup",
      language: "eng",
      region: { x: 100, y: 100, width: 220, height: 80 },
    });
    const snapshotCall = cdpManagerMock.sendCommand.mock.calls[1];
    expect(snapshotCall[2].expression).toContain(
      "/api/streamer/snapshot?ocr_percent=15",
    );
  });

  it("returns clear structured errors when requested OCR language is unavailable", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({
        ok: true,
        capabilities: {
          enabled: true,
          engine: "tesseract",
          langs: { default: ["eng"], available: ["eng"] },
        },
      }),
    );

    const result = await new GlkvmOcrTool().execute(
      { target: "kvm.example", language: "deu" },
      {},
    );

    expect(result.success).toBe(false);
    const text = result.content[0];
    expect(text.type).toBe("text");
    if (text.type !== "text") throw new Error("Expected text content");
    expect(JSON.parse(text.text)).toMatchObject({
      errorType: "OCR_LANGUAGE_UNAVAILABLE",
      error: expect.stringContaining('language "deu" is unavailable'),
    });
  });
});

describe("buildSnapshotOcrPath", () => {
  it("uses only the confirmed streamer snapshot OCR parameter", () => {
    expect(buildSnapshotOcrPath(15)).toBe(
      "/api/streamer/snapshot?ocr_percent=15",
    );
  });
});

describe("readKvmOcr", () => {
  it("returns a clear error when OCR capability metadata reports disabled OCR", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({
        ok: true,
        capabilities: {
          enabled: false,
          engine: "tesseract",
          langs: { default: [], available: [] },
        },
      }),
    );

    await expect(
      readKvmOcr({
        tabId: 42,
        region: { x: 10, y: 20, width: 100, height: 50 },
        frame: { width: 1920, height: 1080 },
        language: "eng",
      }),
    ).rejects.toMatchObject({
      name: "GlkvmOcrError",
      code: "OCR_UNAVAILABLE",
    });

    expect(cdpManagerMock.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("returns a clear error when the requested OCR language is unavailable", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({
        ok: true,
        capabilities: {
          enabled: true,
          engine: "tesseract",
          langs: { default: ["eng"], available: ["eng"] },
        },
      }),
    );

    await expect(
      readKvmOcr({
        tabId: 42,
        region: { x: 10, y: 20, width: 100, height: 50 },
        frame: { width: 1920, height: 1080 },
        language: "deu",
      }),
    ).rejects.toMatchObject({
      name: "GlkvmOcrError",
      code: "OCR_LANGUAGE_UNAVAILABLE",
    });

    expect(cdpManagerMock.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("builds the confirmed snapshot OCR request and fails clearly when no text endpoint is available", async () => {
    cdpManagerMock.sendCommand
      .mockResolvedValueOnce(
        mockEvalResult({
          ok: true,
          capabilities: {
            enabled: true,
            engine: "tesseract",
            langs: { default: ["eng"], available: ["eng", "deu"] },
          },
        }),
      )
      .mockResolvedValueOnce(
        mockEvalResult({
          ok: true,
          contentType: "image/jpeg",
          hasText: false,
        }),
      );

    await expect(
      readKvmOcr({
        tabId: 42,
        region: { x: 100, y: 100, width: 220, height: 80 },
        frame: { width: 1920, height: 1080 },
        language: "eng",
      }),
    ).rejects.toMatchObject({
      name: "GlkvmOcrError",
      code: "OCR_TEXT_UNAVAILABLE",
    });

    const snapshotCall = cdpManagerMock.sendCommand.mock.calls[1];
    expect(snapshotCall[0]).toBe(42);
    expect(snapshotCall[1]).toBe("Runtime.evaluate");
    expect(snapshotCall[2].expression).toContain(
      "/api/streamer/snapshot?ocr_percent=15",
    );
    expect(snapshotCall[2].expression).toContain("method: \"GET\"");
  });

  it("attaches CDP before checking OCR when needed", async () => {
    cdpManagerMock.isAttached.mockReturnValue(false);
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({
        ok: true,
        capabilities: {
          enabled: false,
          engine: "tesseract",
          langs: { default: [], available: [] },
        },
      }),
    );

    await expect(
      readKvmOcr({
        tabId: 42,
        region: { x: 10, y: 20, width: 100, height: 50 },
        frame: { width: 1920, height: 1080 },
      }),
    ).rejects.toBeInstanceOf(GlkvmOcrError);

    expect(cdpManagerMock.attach).toHaveBeenCalledWith(42);
  });
});
