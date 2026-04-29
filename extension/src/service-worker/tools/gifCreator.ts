/**
 * gif_creator tool — record browser screenshots into an animated GIF.
 *
 * Actions:
 *   start      - Initialize frame buffer, begin a new recording session.
 *   screenshot - Capture a JPEG frame from the target tab via CDP.
 *   stop       - Encode all captured frames into an animated GIF via offscreen document.
 *
 * The encoding happens in an offscreen document (Chrome MV3) to avoid blocking
 * the service worker. The offscreen document uses Canvas + a pure-JS GIF89a
 * encoder with LZW compression — no external dependencies.
 *
 * Usage:
 *   1. { action: "start", tabId: 123 }
 *   2. { action: "screenshot", tabId: 123 }   (repeat for each frame)
 *   3. { action: "stop", tabId: 123 }          (returns base64 GIF)
 */

import type {
  ToolHandler,
  ToolResult,
  ToolContext,
} from "../../types/messages.js";
import { cdpManager } from "../cdp.js";

// --- Types ---

type Action = "start" | "screenshot" | "stop";

interface RecordingSession {
  tabId: number;
  frames: string[]; // base64-encoded JPEG screenshots
  width: number;
  height: number;
  startedAt: number;
}

/** Default frame delay in centiseconds (1/100th of a second) */
const DEFAULT_DELAY_CS = 50; // 500ms between frames

/** Maximum number of frames to prevent memory issues */
const MAX_FRAMES = 100;

/** Offscreen document URL (relative to extension root) */
const OFFSCREEN_URL = "src/offscreen/offscreen.html";

/** Offscreen document creation reason */
const OFFSCREEN_REASON = "WORKERS" as chrome.offscreen.Reason;

// --- GifCreatorTool ---

export class GifCreatorTool implements ToolHandler {
  /** Active recording sessions keyed by tabId */
  private sessions = new Map<number, RecordingSession>();

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const action = args.action as Action | undefined;
      if (!action) {
        return this.error(
          'Missing required argument: action ("start", "screenshot", "stop")',
        );
      }

      const tabId = args.tabId as number | undefined;
      if (typeof tabId !== "number") {
        return this.error("Missing required argument: tabId (number)");
      }

      switch (action) {
        case "start":
          return await this.start(tabId);
        case "screenshot":
          return await this.captureFrame(tabId);
        case "stop":
          return await this.stop(tabId, args);
        default:
          return this.error(
            `Unknown action: "${action}". Valid actions: start, screenshot, stop`,
          );
      }
    } catch (error) {
      return this.error(
        `gif_creator failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- Actions ---

  private async start(tabId: number): Promise<ToolResult> {
    // End any existing session for this tab
    this.sessions.delete(tabId);

    // Ensure CDP is attached
    if (!cdpManager.isAttached(tabId)) {
      await cdpManager.attach(tabId);
    }

    // Get viewport dimensions for consistent frame sizing
    const metrics = await cdpManager.sendCommand<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>(tabId, "Page.getLayoutMetrics");

    const width = metrics.cssLayoutViewport.clientWidth;
    const height = metrics.cssLayoutViewport.clientHeight;

    const session: RecordingSession = {
      tabId,
      frames: [],
      width,
      height,
      startedAt: Date.now(),
    };

    this.sessions.set(tabId, session);

    return this.success(
      `GIF recording started for tab ${tabId} (${width}x${height}). ` +
        `Use action "screenshot" to capture frames, then "stop" to encode.`,
    );
  }

  private async captureFrame(tabId: number): Promise<ToolResult> {
    const session = this.sessions.get(tabId);
    if (!session) {
      return this.error(
        `No active recording for tab ${tabId}. Call action "start" first.`,
      );
    }

    if (session.frames.length >= MAX_FRAMES) {
      return this.error(
        `Maximum frame limit reached (${MAX_FRAMES}). Call action "stop" to encode.`,
      );
    }

    // Ensure CDP is attached
    if (!cdpManager.isAttached(tabId)) {
      await cdpManager.attach(tabId);
    }

    // Capture screenshot via CDP (JPEG for smaller size)
    const result = await cdpManager.sendCommand<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 80,
        clip: {
          x: 0,
          y: 0,
          width: session.width,
          height: session.height,
          scale: 1,
        },
      },
    );

    session.frames.push(result.data);

    return this.success(
      `Frame ${session.frames.length} captured (${session.frames.length}/${MAX_FRAMES})`,
    );
  }

  private async stop(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const session = this.sessions.get(tabId);
    if (!session) {
      return this.error(
        `No active recording for tab ${tabId}. Call action "start" first.`,
      );
    }

    if (session.frames.length === 0) {
      this.sessions.delete(tabId);
      return this.error(
        'No frames captured. Use action "screenshot" to capture frames before stopping.',
      );
    }

    const delay =
      typeof args.delay === "number"
        ? Math.max(1, Math.round(args.delay))
        : DEFAULT_DELAY_CS;

    try {
      // Ensure offscreen document exists
      await this.ensureOffscreenDocument();

      // Send frames to offscreen document for encoding
      const response = (await chrome.runtime.sendMessage({
        action: "encode",
        frames: session.frames,
        delay,
        width: session.width,
        height: session.height,
      })) as { success: boolean; data?: string; error?: string };

      // Clean up session
      this.sessions.delete(tabId);

      if (!response.success || !response.data) {
        return this.error(
          `GIF encoding failed: ${response.error ?? "Unknown error"}`,
        );
      }

      const duration = ((Date.now() - session.startedAt) / 1000).toFixed(1);

      return {
        success: true,
        content: [
          {
            type: "image",
            data: response.data,
            mimeType: "image/gif",
          },
          {
            type: "text",
            text: JSON.stringify({
              gif: {
                frames: session.frames.length,
                width: session.width,
                height: session.height,
                delay_cs: delay,
                recording_duration_s: duration,
              },
            }),
          },
        ],
      };
    } catch (error) {
      // Clean up session even on failure
      this.sessions.delete(tabId);
      throw error;
    }
  }

  // --- Offscreen Document Management ---

  /**
   * Ensure the offscreen document is created and available.
   * Creates on demand and reuses for subsequent calls.
   */
  private async ensureOffscreenDocument(): Promise<void> {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });

    if (existingContexts.length > 0) {
      return; // Already exists
    }

    // Create the offscreen document
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [OFFSCREEN_REASON],
      justification: "GIF encoding requires Canvas API for image processing",
    });
  }

  // --- Utilities ---

  private success(message: string): ToolResult {
    return {
      success: true,
      content: [{ type: "text", text: message }],
    };
  }

  private error(message: string): ToolResult {
    return {
      success: false,
      content: [{ type: "text", text: message }],
    };
  }
}
