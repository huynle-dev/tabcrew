import { cdpManager } from "../cdp.js";
import {
  getVideoMetadata,
  requireOwnedGlkvmTabForDirectControl,
} from "../glkvmTab.js";

const INTRINSIC_REMOTE_FRAME_COORDINATE_SPACE =
  "intrinsic_remote_frame_pixels" as const;
const GLKVM_SCREENSHOT_COORDINATE_SPACE = "glkvm_screenshot_pixels" as const;
const HASH_ALGORITHM = "fnv1a-32" as const;
const FRAME_CACHE_LIMIT = 20;
let nextFrameSequence = 0;

export interface GlkvmFrameCropOptions {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GlkvmFrameCrop extends GlkvmFrameCropOptions {
  readonly coordinateSpace: typeof INTRINSIC_REMOTE_FRAME_COORDINATE_SPACE;
}

export interface GlkvmFrameDimensions {
  readonly width: number;
  readonly height: number;
  readonly coordinateSpace:
    | typeof INTRINSIC_REMOTE_FRAME_COORDINATE_SPACE
    | typeof GLKVM_SCREENSHOT_COORDINATE_SPACE;
}

export interface GlkvmFrameScale {
  readonly x: number;
  readonly y: number;
}

export interface GlkvmFrame {
  readonly frameId: string;
  readonly capturedAt: string;
  readonly tabId: number;
  readonly hash: string;
  readonly data: string;
  readonly width?: number;
  readonly height?: number;
  readonly source?: GlkvmFrameDimensions;
  readonly crop?: GlkvmFrameCrop | null;
  readonly output?: GlkvmFrameDimensions;
  readonly scale?: GlkvmFrameScale;
  readonly hashAlgorithm?: typeof HASH_ALGORITHM;
}

export type GlkvmFrameDescriptor = Pick<
  GlkvmFrame,
  "frameId" | "capturedAt" | "tabId" | "source" | "crop" | "output" | "width" | "height"
>;

const recentFrames = new Map<string, GlkvmFrameDescriptor>();
const latestFrameMetadataByTab = new Map<number, Record<string, unknown>>();

export class GlkvmFrameCaptureError extends Error {
  readonly code: "CAPTURE_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "GlkvmFrameCaptureError";
    this.code = "CAPTURE_FAILED";
  }
}

function hashFrameData(data: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createFrameId(): string {
  nextFrameSequence = (nextFrameSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `glkvm-frame-${Date.now().toString(36)}-${nextFrameSequence.toString(36)}`;
}

function rememberFrameDescriptor(frame: GlkvmFrame): void {
  const descriptor: GlkvmFrameDescriptor = {
    frameId: frame.frameId,
    capturedAt: frame.capturedAt,
    tabId: frame.tabId,
    source: frame.source,
    crop: frame.crop,
    output: frame.output,
    width: frame.width,
    height: frame.height,
  };
  recentFrames.set(frame.frameId, descriptor);
  while (recentFrames.size > FRAME_CACHE_LIMIT) {
    const oldest = recentFrames.keys().next().value;
    if (oldest === undefined) break;
    recentFrames.delete(oldest);
  }
}

export function resolveCachedGlkvmFrameDescriptor(
  frameId: string | undefined,
): GlkvmFrameDescriptor | undefined {
  if (!frameId) return undefined;
  return recentFrames.get(frameId);
}

export function clearGlkvmFrameCacheForTests(): void {
  recentFrames.clear();
  latestFrameMetadataByTab.clear();
  nextFrameSequence = 0;
}

export function formatGlkvmFrameMetadata(
  frame: GlkvmFrame,
  options?: { mimeType?: string },
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    frameId: frame.frameId,
    timestamp: frame.capturedAt,
    capturedAt: frame.capturedAt,
    tabId: frame.tabId,
    ...(options?.mimeType !== undefined ? { mimeType: options.mimeType } : {}),
    hash: frame.hash,
  };
  if (frame.hashAlgorithm !== undefined) {
    metadata.hashAlgorithm = frame.hashAlgorithm;
    metadata.hashMetadata = {
      value: frame.hash,
      algorithm: frame.hashAlgorithm,
    };
  }
  if (frame.width !== undefined) metadata.width = frame.width;
  if (frame.height !== undefined) metadata.height = frame.height;
  if (frame.source !== undefined) metadata.source = frame.source;
  if (frame.crop !== undefined) {
    metadata.region = frame.crop;
    metadata.crop = frame.crop;
  }
  if (frame.output !== undefined) metadata.output = frame.output;
  if (frame.scale !== undefined) metadata.scale = frame.scale;
  return metadata;
}

export function getLatestGlkvmFrameMetadata(
  tabId: number,
): Record<string, unknown> | undefined {
  return latestFrameMetadataByTab.get(tabId);
}

export async function captureGlkvmFrame(options?: {
  target?: string;
  tabId?: unknown;
  sessionScope?: string;
  crop?: GlkvmFrameCropOptions;
  maxWidth?: number;
  maxHeight?: number;
}): Promise<GlkvmFrame> {
  const { sessionScope, ...validationOptions } = options ?? {};
  const validated = await requireOwnedGlkvmTabForDirectControl(
    validationOptions,
    sessionScope,
  );
  const tabId = validated.tabId;
  const video = await getVideoMetadata(tabId);

  if (!video.visible || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new GlkvmFrameCaptureError(
      "GLKVM video stream is not ready for frame capture.",
    );
  }

  const source = {
    width: video.videoWidth,
    height: video.videoHeight,
    coordinateSpace: INTRINSIC_REMOTE_FRAME_COORDINATE_SPACE,
  } satisfies GlkvmFrameDimensions;

  const crop = validateCrop(options?.crop, source.width, source.height);
  const captureSource = crop ?? {
    x: 0,
    y: 0,
    width: source.width,
    height: source.height,
    coordinateSpace: INTRINSIC_REMOTE_FRAME_COORDINATE_SPACE,
  };
  const outputSize = calculateOutputSize(captureSource, {
    maxWidth: options?.maxWidth,
    maxHeight: options?.maxHeight,
  });

  if (!cdpManager.isAttached(tabId)) {
    await cdpManager.attach(tabId);
  }

  const result = await cdpManager.sendCommand<{
    result: {
      value?: {
        data?: string;
        width?: number;
        height?: number;
        error?: string;
        message?: string;
      };
    };
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
    };
  }>(
    tabId,
    "Runtime.evaluate",
    {
      expression: buildCanvasCaptureExpression(captureSource, outputSize),
      returnByValue: true,
      awaitPromise: false,
    },
  );

  if (result.exceptionDetails) {
    const message =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Unknown page-context error";
    throw new GlkvmFrameCaptureError(
      `GLKVM frame capture failed in page context: ${message}`,
    );
  }

  const value = result.result.value;
  if (value?.error) {
    throw new GlkvmFrameCaptureError(
      value.message ?? `GLKVM frame capture failed: ${value.error}`,
    );
  }

  if (!value?.data) {
    throw new GlkvmFrameCaptureError("GLKVM frame capture returned no data.");
  }

  const output = {
    width: value.width ?? outputSize.width,
    height: value.height ?? outputSize.height,
    coordinateSpace: GLKVM_SCREENSHOT_COORDINATE_SPACE,
  } satisfies GlkvmFrameDimensions;
  const scale = {
    x: output.width / captureSource.width,
    y: output.height / captureSource.height,
  } satisfies GlkvmFrameScale;

  const frame: GlkvmFrame = {
    frameId: createFrameId(),
    capturedAt: new Date().toISOString(),
    tabId,
    data: value.data,
    hash: hashFrameData(value.data),
    width: output.width,
    height: output.height,
    source,
    crop,
    output,
    scale,
    hashAlgorithm: HASH_ALGORITHM,
  };
  rememberFrameDescriptor(frame);
  latestFrameMetadataByTab.set(
    tabId,
    formatGlkvmFrameMetadata(frame, { mimeType: "image/jpeg" }),
  );
  return frame;
}

function validateCrop(
  crop: GlkvmFrameCropOptions | undefined,
  sourceWidth: number,
  sourceHeight: number,
): GlkvmFrameCrop | null {
  if (crop === undefined) {
    return null;
  }

  const fields = [
    ["x", crop.x],
    ["y", crop.y],
    ["width", crop.width],
    ["height", crop.height],
  ] as const;

  for (const [name, value] of fields) {
    if (!Number.isFinite(value)) {
      throw new GlkvmFrameCaptureError(
        `Invalid crop.${name}: expected a finite number in intrinsic remote-frame pixels.`,
      );
    }
  }

  if (crop.x < 0 || crop.y < 0) {
    throw new GlkvmFrameCaptureError(
      "Invalid crop: x and y must be non-negative intrinsic remote-frame pixels.",
    );
  }

  if (crop.width <= 0 || crop.height <= 0) {
    throw new GlkvmFrameCaptureError(
      "Invalid crop: width and height must be positive intrinsic remote-frame pixels.",
    );
  }

  if (crop.x + crop.width > sourceWidth || crop.y + crop.height > sourceHeight) {
    throw new GlkvmFrameCaptureError(
      `Invalid crop: region must fit within the ${sourceWidth}x${sourceHeight} intrinsic remote-frame pixels.`,
    );
  }

  return {
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
    coordinateSpace: INTRINSIC_REMOTE_FRAME_COORDINATE_SPACE,
  };
}

function calculateOutputSize(
  source: GlkvmFrameCropOptions,
  options: { maxWidth?: number; maxHeight?: number },
): { width: number; height: number } {
  validateDownscaleDimension("maxWidth", options.maxWidth);
  validateDownscaleDimension("maxHeight", options.maxHeight);

  const widthScale =
    options.maxWidth === undefined ? 1 : options.maxWidth / source.width;
  const heightScale =
    options.maxHeight === undefined ? 1 : options.maxHeight / source.height;
  const scale = Math.min(1, widthScale, heightScale);

  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

function validateDownscaleDimension(name: string, value: number | undefined) {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new GlkvmFrameCaptureError(
      `Invalid downscale ${name}: expected a positive finite pixel dimension.`,
    );
  }
}

function buildCanvasCaptureExpression(
  source: GlkvmFrameCropOptions,
  output: { width: number; height: number },
): string {
  const drawSource = {
    sx: source.x,
    sy: source.y,
    sWidth: source.width,
    sHeight: source.height,
  };
  const drawOutput = { width: output.width, height: output.height };

  return `
    (() => {
      const video = document.querySelector('video');
      if (!video) return { error: 'no_video', message: 'No <video> element found on this page.' };
      if (video.videoWidth <= 0 || video.videoHeight <= 0) {
        return { error: 'video_not_ready', message: 'GLKVM video stream is not ready for frame capture.' };
      }

      const source = ${JSON.stringify(drawSource)};
      const output = ${JSON.stringify(drawOutput)};
      const canvas = document.createElement('canvas');
      canvas.width = output.width;
      canvas.height = output.height;
      const context = canvas.getContext('2d');
      if (!context) return { error: 'canvas_unavailable', message: 'Canvas 2D context is unavailable.' };
      context.drawImage(
        video,
        source.sx,
        source.sy,
        source.sWidth,
        source.sHeight,
        0,
        0,
        output.width,
        output.height,
      );
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const prefix = "data:image/jpeg;base64,";
      if (!dataUrl.startsWith(prefix)) {
        return { error: 'unexpected_data_url', message: 'Canvas returned an unexpected image data URL.' };
      }
      return {
        data: dataUrl.slice(prefix.length),
        width: output.width,
        height: output.height,
      };
    })()
  `;
}
