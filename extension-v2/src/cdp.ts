/**
 * chrome.debugger per tab: attached on tab_create (or lazily on first use) and kept attached.
 *
 * On attach we enable focus emulation (so tabs in the unfocused per-session windows keep
 * rendering and running timers, as in jev-ultrafast) and the Page domain, and start the tab's
 * debug log buffers (Runtime + Network domains, not awaited, so attach is not slowed).
 * `tab_create` starts the attach eagerly; every other op awaits the same pending attach.
 * All state is per tab; nothing is shared across tabs.
 */

import { DebugLogStore } from "./debuglogs.js";
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

export type EventMatch = (method: string, params: unknown) => boolean;

export interface EventWait {
  /** true when a matching event arrived, false on timeout, detach or cancel. */
  readonly done: Promise<boolean>;
  cancel(): void;
}

export class CdpManager {
  /** tabId → attach in progress or done. Removed on detach/close/failure. */
  private readonly attached = new Map<number, Promise<void>>();
  private readonly waiters = new Map<number, Set<{ match: EventMatch; finish: (hit: boolean) => void }>>();
  /** Console/network ring buffers of attached tabs. */
  readonly logs = new DebugLogStore();

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
    this.dropTabState(source.tabId);
  }

  forgetTab(tabId: number): void {
    this.attached.delete(tabId);
    this.dropTabState(tabId);
  }

  /** chrome.debugger.onEvent for one tab: feeds the log buffers and pending waits. */
  handleEvent(tabId: number, method: string, params: unknown): void {
    this.logs.handleEvent(tabId, method, params);
    const set = this.waiters.get(tabId);
    if (!set) return;
    for (const w of [...set]) {
      if (w.match(method, params)) w.finish(true);
    }
  }

  /**
   * Wait for an event on the tab. Register before sending the command that triggers it.
   * Never rejects: resolves false after `timeoutMs`, on detach/close, or on cancel.
   */
  waitForEvent(tabId: number, match: EventMatch, timeoutMs: number): EventWait {
    let set = this.waiters.get(tabId);
    if (!set) {
      set = new Set();
      this.waiters.set(tabId, set);
    }
    const tabWaiters = set;
    let finish!: (hit: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const waiter = {
        match,
        finish: (hit: boolean) => {
          clearTimeout(timer);
          tabWaiters.delete(waiter);
          if (tabWaiters.size === 0 && this.waiters.get(tabId) === tabWaiters) this.waiters.delete(tabId);
          resolve(hit);
        },
      };
      finish = waiter.finish;
      tabWaiters.add(waiter);
    });
    return { done, cancel: () => finish(false) };
  }

  private dropTabState(tabId: number): void {
    this.logs.forget(tabId);
    const set = this.waiters.get(tabId);
    if (set) for (const w of [...set]) w.finish(false);
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
    const params: Record<string, unknown> = { format };
    if (format === "jpeg") params.quality = quality;
    // Independent reads: issue both at once instead of serially.
    const [metrics, shot] = await Promise.all([
      this.send<LayoutMetrics>(tabId, "Page.getLayoutMetrics"),
      withTimeout(
        this.send<{ data: string }>(tabId, "Page.captureScreenshot", params),
        SCREENSHOT_TIMEOUT_MS,
        `screenshot of tab ${tabId} timed out`,
      ),
    ]);
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
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
    // Focus emulation keeps the hidden background tab awake and rendering, so screenshots and
    // rAF-based settle waits do not stall. Page.enable delivers Page.frameNavigated (drops stale
    // snapshots) and Page.loadEventFired (navigate). All commands go out together.
    // Runtime/Network feed debug_logs for this tab only; they are not awaited and their failure
    // never fails the attach. No post data is captured and response bodies are never requested.
    const essential = Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }),
      chrome.debugger.sendCommand({ tabId }, "Page.enable"),
    ]);
    this.logs.start(tabId);
    void Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
      chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxPostDataSize: 0 }),
    ]).catch((err) => console.warn(`[v2 cdp] debug logs unavailable for tab ${tabId}:`, err));
    await essential;
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
