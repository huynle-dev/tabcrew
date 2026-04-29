import { cdpManager } from "../cdp.js";
import { getVideoMetadata, resolveGlkvmTab } from "../glkvmTab.js";

export interface GlkvmFrame {
  readonly tabId: number;
  readonly hash: string;
  readonly data: string;
  readonly width?: number;
  readonly height?: number;
}

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

export async function captureGlkvmFrame(options?: {
  target?: string;
}): Promise<GlkvmFrame> {
  const resolved = await resolveGlkvmTab(options);
  const video = await getVideoMetadata(resolved.tabId);

  if (!video.visible || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new GlkvmFrameCaptureError(
      "GLKVM video stream is not ready for frame capture.",
    );
  }

  if (!cdpManager.isAttached(resolved.tabId)) {
    await cdpManager.attach(resolved.tabId);
  }

  const result = await cdpManager.sendCommand<{ data: string }>(
    resolved.tabId,
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: 80,
      clip: {
        x: video.displayRect.x,
        y: video.displayRect.y,
        width: video.displayRect.width,
        height: video.displayRect.height,
        scale: 1,
      },
    },
  );

  if (!result.data) {
    throw new GlkvmFrameCaptureError("GLKVM frame capture returned no data.");
  }

  return {
    tabId: resolved.tabId,
    data: result.data,
    hash: hashFrameData(result.data),
    width: Math.round(video.displayRect.width),
    height: Math.round(video.displayRect.height),
  };
}
