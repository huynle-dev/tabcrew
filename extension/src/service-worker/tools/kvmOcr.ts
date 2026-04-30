import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "../../types/messages.js";
import { cdpManager } from "../cdp.js";
import { getVideoMetadata, requireOwnedGlkvmTabForDirectControl } from "../glkvmTab.js";

export type SupportedOcrPercent = 5 | 10 | 15 | 20;

const SUPPORTED_OCR_PERCENTS: readonly SupportedOcrPercent[] = [5, 10, 15, 20];

export interface RemoteFrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RemoteFrameSize {
  readonly width: number;
  readonly height: number;
}

export type GlkvmOcrErrorCode =
  | "OCR_UNAVAILABLE"
  | "OCR_LANGUAGE_UNAVAILABLE"
  | "OCR_TEXT_UNAVAILABLE"
  | "OCR_REQUEST_FAILED";

export class GlkvmOcrError extends Error {
  readonly code: GlkvmOcrErrorCode;

  constructor(code: GlkvmOcrErrorCode, message: string) {
    super(message);
    this.name = "GlkvmOcrError";
    this.code = code;
  }
}

interface OcrCapabilities {
  readonly enabled?: boolean;
  readonly engine?: string;
  readonly langs?: {
    readonly default?: readonly string[];
    readonly available?: readonly string[];
  };
}

interface PageContextResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly capabilities?: OcrCapabilities;
  readonly contentType?: string;
  readonly hasText?: boolean;
  readonly text?: string;
}

export function selectOcrPercent(
  region: RemoteFrameRegion,
  frame: RemoteFrameSize,
): SupportedOcrPercent {
  if (frame.width <= 0 || frame.height <= 0) {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      "Cannot construct OCR request: remote frame dimensions must be positive.",
    );
  }

  if (region.width <= 0 || region.height <= 0) {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      "Cannot construct OCR request: selected OCR region dimensions must be positive.",
    );
  }

  const widthPercent = (region.width / frame.width) * 100;
  const heightPercent = (region.height / frame.height) * 100;
  const requestedPercent = Math.max(widthPercent, heightPercent);

  return (
    SUPPORTED_OCR_PERCENTS.find((percent) => requestedPercent <= percent) ?? 20
  );
}

export function buildSnapshotOcrPath(percent: SupportedOcrPercent): string {
  return `/api/streamer/snapshot?ocr_percent=${percent}`;
}

export async function readKvmOcr(options: {
  tabId: number;
  region: RemoteFrameRegion;
  frame: RemoteFrameSize;
  language?: string;
}): Promise<string> {
  const { tabId, region, frame, language } = options;

  await ensureAttached(tabId);

  const capabilities = await readOcrCapabilities(tabId);
  if (!capabilities.enabled) {
    throw new GlkvmOcrError(
      "OCR_UNAVAILABLE",
      describeOcrUnavailable(capabilities),
    );
  }

  if (language) {
    const available = capabilities.langs?.available ?? [];
    const defaults = capabilities.langs?.default ?? [];
    const supported = new Set([...available, ...defaults]);
    if (!supported.has(language)) {
      const listed = [...supported].join(", ") || "none reported";
      throw new GlkvmOcrError(
        "OCR_LANGUAGE_UNAVAILABLE",
        `GLKVM OCR language "${language}" is unavailable. Reported languages: ${listed}.`,
      );
    }
  }

  const percent = selectOcrPercent(region, frame);
  const snapshot = await requestOcrSnapshot(tabId, percent);

  if (snapshot.text) return snapshot.text;

  throw new GlkvmOcrError(
    "OCR_TEXT_UNAVAILABLE",
    `GLKVM accepted ${buildSnapshotOcrPath(percent)}, but no confirmed OCR text endpoint is available; snapshot returned ${snapshot.contentType ?? "unknown content type"}.`,
  );
}

export class GlkvmOcrTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const target = typeof args.target === "string" ? args.target : undefined;
    const sessionId =
      typeof args.sessionId === "string" ? args.sessionId : undefined;
    const language =
      typeof args.language === "string" ? args.language : undefined;

    try {
      const validated = await requireOwnedGlkvmTabForDirectControl(
        {
          ...("tabId" in args ? { tabId: args.tabId } : {}),
          ...(target ? { target } : {}),
        },
        context.sessionScope,
      );
      const video = await getVideoMetadata(validated.tabId);
      const frame = {
        width: video.videoWidth,
        height: video.videoHeight,
      };
      const region = parseRegion(args.region, frame);
      const text = await readKvmOcr({
        tabId: validated.tabId,
        region,
        frame,
        language,
      });

      return this.json(true, {
        ...(target ? { target } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(language ? { language } : {}),
        tabId: validated.tabId,
        tab: validated.tab,
        region,
        text,
      });
    } catch (error) {
      return this.json(false, {
        ...(target ? { target } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(language ? { language } : {}),
        errorType: error instanceof GlkvmOcrError ? error.code : "OCR_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private json(success: boolean, value: Record<string, unknown>): ToolResult {
    return {
      success,
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
  }
}

function parseRegion(value: unknown, frame: RemoteFrameSize): RemoteFrameRegion {
  if (value === undefined) {
    return { x: 0, y: 0, width: frame.width, height: frame.height };
  }

  if (!value || typeof value !== "object") {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      "OCR region must be an object with x, y, width, and height.",
    );
  }

  const region = value as Record<string, unknown>;
  const x = readRegionNumber(region, "x");
  const y = readRegionNumber(region, "y");
  const width = readRegionNumber(region, "width");
  const height = readRegionNumber(region, "height");

  if (x < 0 || y < 0) {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      "OCR region x and y coordinates must be non-negative.",
    );
  }

  if (x + width > frame.width || y + height > frame.height) {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      "OCR region must fit inside the remote frame dimensions.",
    );
  }

  return { x, y, width, height };
}

function readRegionNumber(
  region: Record<string, unknown>,
  key: keyof RemoteFrameRegion,
): number {
  const value = region[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      `OCR region ${key} must be a finite number.`,
    );
  }
  return value;
}

async function ensureAttached(tabId: number): Promise<void> {
  if (!cdpManager.isAttached(tabId)) {
    await cdpManager.attach(tabId);
  }
}

async function readOcrCapabilities(tabId: number): Promise<OcrCapabilities> {
  const evalResult = await cdpManager.sendCommand<{
    result: { type: string; value?: PageContextResult };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(tabId, "Runtime.evaluate", {
    expression: buildReadCapabilitiesScript(),
    returnByValue: true,
    awaitPromise: true,
  });

  const value = unwrapPageResult(evalResult, "read OCR capabilities");
  return value.capabilities ?? {};
}

async function requestOcrSnapshot(
  tabId: number,
  percent: SupportedOcrPercent,
): Promise<PageContextResult> {
  const evalResult = await cdpManager.sendCommand<{
    result: { type: string; value?: PageContextResult };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(tabId, "Runtime.evaluate", {
    expression: buildSnapshotRequestScript(buildSnapshotOcrPath(percent)),
    returnByValue: true,
    awaitPromise: true,
  });

  return unwrapPageResult(evalResult, "request OCR snapshot");
}

function unwrapPageResult(
  evalResult: {
    result: { value?: PageContextResult };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  },
  operation: string,
): PageContextResult {
  if (evalResult.exceptionDetails) {
    const msg =
      evalResult.exceptionDetails.exception?.description ??
      evalResult.exceptionDetails.text ??
      "Unknown error";
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      `Failed to ${operation}: ${msg}`,
    );
  }

  const value = evalResult.result.value;
  if (!value) {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      `Failed to ${operation}: no result returned.`,
    );
  }

  if (!value.ok) {
    throw new GlkvmOcrError(
      "OCR_REQUEST_FAILED",
      value.error ?? `Failed to ${operation}.`,
    );
  }

  return value;
}

function buildReadCapabilitiesScript(): string {
  return `
    (async () => {
      const cached = window.__oc_glkvm_ocr_capabilities;
      if (cached) return { ok: true, capabilities: cached };

      const timeoutMs = 3000;
      const multiRaw = localStorage.getItem("gl-kvm-token-keys");
      let token = null;
      if (multiRaw) {
        try {
          const values = Object.values(JSON.parse(multiRaw));
          if (values.length > 0) token = values[0];
        } catch {}
      }
      if (!token) token = localStorage.getItem("gl-kvm-token-key");
      if (!token) return { ok: false, error: "No GLKVM auth token found in localStorage. Log in to the GLKVM web interface first." };

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = proto + "//" + location.host + "/api/ws?auth_token=" + encodeURIComponent(token);

      return await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          resolve({ ok: false, error: "Timed out waiting for GLKVM OCR capability metadata from /api/ws." });
        }, timeoutMs);

        ws.addEventListener("message", (event) => {
          try {
            const parsed = JSON.parse(event.data);
            if (parsed && parsed.event_type === "ocr") {
              clearTimeout(timer);
              try { ws.close(); } catch {}
              window.__oc_glkvm_ocr_capabilities = parsed.event || {};
              resolve({ ok: true, capabilities: parsed.event || {} });
            }
          } catch {}
        });

        ws.addEventListener("error", () => {
          clearTimeout(timer);
          resolve({ ok: false, error: "Unable to read GLKVM OCR capability metadata from /api/ws." });
        });
      });
    })()
  `;
}

function buildSnapshotRequestScript(path: string): string {
  return `
    (async () => {
      const response = await fetch(${JSON.stringify(path)}, {
        method: "GET",
        credentials: "include"
      });
      if (!response.ok) {
        return { ok: false, error: "OCR snapshot request failed with HTTP " + response.status };
      }
      return {
        ok: true,
        contentType: response.headers.get("content-type") || "",
        hasText: false
      };
    })()
  `;
}

function describeOcrUnavailable(capabilities: OcrCapabilities): string {
  const engine = capabilities.engine ?? "unknown engine";
  const available = capabilities.langs?.available?.join(", ") || "none";
  return `GLKVM OCR is unavailable or disabled (engine: ${engine}; languages: ${available}).`;
}
