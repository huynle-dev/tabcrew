/**
 * chrome.debugger per tab: attached lazily and kept attached.
 *
 * On attach we enable focus emulation (so background tabs in the unfocused Agents window
 * keep rendering and running timers, as in jev-ultrafast) and the Page domain. All state is
 * per tab; nothing is shared across tabs.
 */

import { OpError } from "./errors.js";

const CDP_PROTOCOL_VERSION = "1.3";
const SCREENSHOT_TIMEOUT_MS = 15_000;

export interface ScreenshotArgs {
  format?: unknown;
  quality?: unknown;
}

export interface ScreenshotResult {
  media_type: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
}

interface LayoutMetrics {
  cssVisualViewport?: { clientWidth: number; clientHeight: number };
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
}

export class CdpManager {
  /** tabId → attach in progress or done. Removed on detach/close/failure. */
  private readonly attached = new Map<number, Promise<void>>();

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  ensureAttached(tabId: number): Promise<void> {
    let pending = this.attached.get(tabId);
    if (!pending) {
      pending = this.attach(tabId);
      this.attached.set(tabId, pending);
      pending.catch(() => {
        if (this.attached.get(tabId) === pending) this.attached.delete(tabId);
      });
    }
    return pending;
  }

  /** chrome.debugger.onDetach (user canceled the infobar, tab closed, DevTools took over). */
  handleDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (typeof source.tabId !== "number") return;
    if (this.attached.delete(source.tabId)) {
      console.info(`[v2 cdp] detached from tab ${source.tabId}: ${reason}`);
    }
  }

  forgetTab(tabId: number): void {
    this.attached.delete(tabId);
  }

  async send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureAttached(tabId);
    try {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not attached|no tab with given id|detached/i.test(msg)) {
        this.attached.delete(tabId);
        throw new OpError("tab_gone", `debugger lost tab ${tabId}: ${msg}`);
      }
      throw err;
    }
  }

  /** Capture the tab without activating it or focusing its window. */
  async screenshot(tabId: number, args: ScreenshotArgs): Promise<ScreenshotResult> {
    const format = args.format ?? "jpeg";
    if (format !== "jpeg" && format !== "png") throw new OpError("invalid_args", "format must be jpeg or png");
    let quality = 80;
    if (args.quality !== undefined) {
      if (typeof args.quality !== "number" || !(args.quality >= 0 && args.quality <= 100)) {
        throw new OpError("invalid_args", "quality must be a number from 0 to 100");
      }
      quality = Math.round(args.quality);
    }
    const metrics = await this.send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    const params: Record<string, unknown> = { format };
    if (format === "jpeg") params.quality = quality;
    const shot = await withTimeout(
      this.send<{ data: string }>(tabId, "Page.captureScreenshot", params),
      SCREENSHOT_TIMEOUT_MS,
      `screenshot of tab ${tabId} timed out`,
    );
    return {
      media_type: format === "png" ? "image/png" : "image/jpeg",
      data: shot.data,
      width: Math.round(viewport?.clientWidth ?? 0),
      height: Math.round(viewport?.clientHeight ?? 0),
    };
  }

  private async attach(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // After a service-worker restart our previous attachment may still be live.
      if (!/already attached/i.test(msg)) {
        if (/no tab with given id/i.test(msg)) throw new OpError("tab_gone", `tab ${tabId} no longer exists`);
        throw new OpError("internal", `cannot attach debugger to tab ${tabId}: ${msg}`);
      }
    }
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OpError("internal", message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
