/**
 * CDPManager wraps the Chrome DevTools Protocol (CDP) via chrome.debugger API.
 *
 * This is the foundation that all browser automation tools depend on.
 * It handles:
 * - Attaching/detaching the debugger to tabs
 * - Sending CDP commands across domains (Page, Runtime, Input, DOM, Network)
 * - Keepalive via Page.startScreencast to prevent auto-detach
 * - Auto-reattach on unexpected detach (unless user-initiated)
 * - MV3 service worker lifecycle management:
 *   - chrome.alarms for periodic wakeup
 *   - chrome.storage.session for state persistence
 *   - Debugger reattach on service worker restart
 *
 * Usage:
 *   const cdp = CDPManager.getInstance();
 *   await cdp.attach(tabId);
 *   const result = await cdp.sendCommand(tabId, 'Page.navigate', { url: '...' });
 *   await cdp.detach(tabId);
 */

import {
  calculateScreenshotDimensions,
  type ViewportSize,
  type ScreenshotDimensions,
} from './coordinateMapper.js';

// --- Constants ---

/** CDP protocol version to use when attaching */
const CDP_PROTOCOL_VERSION = '1.3';

/** Screencast keepalive interval in milliseconds (30 seconds) */
const KEEPALIVE_INTERVAL_MS = 30_000;

/** Screencast parameters for keepalive (minimal resource usage) */
const KEEPALIVE_SCREENCAST = {
  format: 'jpeg' as const,
  quality: 10,
  maxWidth: 100,
  maxHeight: 100,
  everyNthFrame: 30,
};

/** CDP domains that expose commands but no Domain.enable method. */
const COMMAND_ONLY_DOMAINS = new Set(['Input', 'Emulation', 'Browser']);

/** chrome.storage.session key for persisted CDP state */
const STORAGE_KEY = 'cdp_attached_tabs';

/** Alarm name for periodic keepalive wakeup */
const CDP_ALARM_NAME = 'cdp-keepalive';

/** Alarm period in minutes (~24 seconds, under the 30s service worker limit) */
const CDP_ALARM_PERIOD_MINUTES = 0.4;

/** Maximum reattach attempts after detach */
const MAX_REATTACH_ATTEMPTS = 3;

/** Delay between reattach attempts in milliseconds */
const REATTACH_DELAY_MS = 1000;

// --- Types ---

/**
 * Reason a debugger was detached.
 * Chrome passes this as a string; known values are:
 * - "target_closed"
 * - "canceled_by_user"
 * - "replaced_with_devtools"
 */
type DetachReason = string;

/** State of a CDP connection to a single tab */
interface TabConnection {
  tabId: number;
  attached: boolean;
  enabledDomains: Set<string>;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  reattachAttempts: number;
  /** True if detach was initiated by us (not auto-reattach) */
  userDetached: boolean;
}

/** Serializable version of tab state for chrome.storage.session */
interface PersistedTabState {
  tabId: number;
  enabledDomains: string[];
}

/** CDP event listener callback */
type CDPEventListener = (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
) => void;

// --- CDPManager ---

export class CDPManager {
  private static instance: CDPManager | null = null;

  private connections = new Map<number, TabConnection>();
  private eventListeners: CDPEventListener[] = [];
  private initialized = false;

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): CDPManager {
    if (!CDPManager.instance) {
      CDPManager.instance = new CDPManager();
    }
    return CDPManager.instance;
  }

  /**
   * Initialize the CDP manager: register Chrome event listeners,
   * set up the keepalive alarm, and restore any persisted connections.
   *
   * Must be called once during service worker startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Listen for debugger detach events
    chrome.debugger.onDetach.addListener(
      (source: chrome.debugger.Debuggee, reason: DetachReason) => {
        this.handleDetach(source, reason);
      },
    );

    // Listen for CDP events from attached targets
    chrome.debugger.onEvent.addListener(
      (source: chrome.debugger.Debuggee, method: string, params?: object) => {
        this.handleEvent(source, method, params as Record<string, unknown>);
      },
    );

    // Listen for tab removal to clean up connections
    chrome.tabs.onRemoved.addListener((tabId: number) => {
      this.cleanupTab(tabId);
    });

    // Set up keepalive alarm
    await chrome.alarms.create(CDP_ALARM_NAME, {
      periodInMinutes: CDP_ALARM_PERIOD_MINUTES,
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === CDP_ALARM_NAME) {
        this.onKeepaliveAlarm();
      }
    });

    // Restore connections from previous service worker session
    await this.restoreConnections();
  }

  /**
   * Attach the debugger to a tab. Enables core CDP domains and starts
   * the keepalive screencast.
   *
   * If already attached to this tab, returns immediately.
   */
  async attach(tabId: number): Promise<void> {
    const existing = this.connections.get(tabId);
    if (existing?.attached) return;

    const debuggee: chrome.debugger.Debuggee = { tabId };

    await chrome.debugger.attach(debuggee, CDP_PROTOCOL_VERSION);

    const connection: TabConnection = {
      tabId,
      attached: true,
      enabledDomains: new Set(),
      keepaliveTimer: null,
      reattachAttempts: 0,
      userDetached: false,
    };

    this.connections.set(tabId, connection);

    // Enable the Page domain (required for screencast keepalive and screenshots)
    await this.enableDomain(tabId, 'Page');

    // Start keepalive screencast
    this.startKeepalive(tabId);

    // Persist state for service worker recovery
    await this.persistState();

    console.log(`[CDP] Attached to tab ${tabId}`);
  }

  /**
   * Detach the debugger from a tab. Stops keepalive and cleans up state.
   */
  async detach(tabId: number): Promise<void> {
    const connection = this.connections.get(tabId);
    if (!connection?.attached) return;

    // Mark as user-initiated so onDetach doesn't auto-reattach
    connection.userDetached = true;

    this.stopKeepalive(tabId);

    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached, that's fine
    }

    this.connections.delete(tabId);
    await this.persistState();

    console.log(`[CDP] Detached from tab ${tabId}`);
  }

  /**
   * Send a CDP command to an attached tab.
   *
   * Automatically enables the required CDP domain if not already enabled.
   *
   * @param tabId - The tab to send the command to
   * @param method - CDP method (e.g. 'Page.navigate', 'Runtime.evaluate')
   * @param params - Command parameters
   * @returns The CDP command result
   */
  async sendCommand<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const connection = this.connections.get(tabId);
    if (!connection?.attached) {
      throw new Error(`Not attached to tab ${tabId}`);
    }

    // Auto-enable the domain if needed
    const domain = method.split('.')[0];
    if (domain && !connection.enabledDomains.has(domain)) {
      await this.enableDomain(tabId, domain);
    }

    const result = await chrome.debugger.sendCommand(
      { tabId },
      method,
      params,
    );

    return result as T;
  }

  /**
   * Enable a CDP domain on an attached tab.
   */
  async enableDomain(tabId: number, domain: string): Promise<void> {
    const connection = this.connections.get(tabId);
    if (!connection?.attached) {
      throw new Error(`Not attached to tab ${tabId}`);
    }

    if (connection.enabledDomains.has(domain)) return;

    if (COMMAND_ONLY_DOMAINS.has(domain)) {
      connection.enabledDomains.add(domain);
      return;
    }

    try {
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
      connection.enabledDomains.add(domain);
    } catch (error) {
      // Some domains don't have .enable (e.g. Input) - that's fine
      console.warn(`[CDP] Failed to enable ${domain} on tab ${tabId}:`, error);
      // Still mark as "enabled" so we don't retry
      connection.enabledDomains.add(domain);
    }
  }

  /**
   * Capture a screenshot of the given tab, with dimensions optimized
   * for token budget.
   *
   * @returns Base64-encoded image data and the screenshot dimensions
   */
  async captureScreenshot(
    tabId: number,
    options?: {
      format?: 'jpeg' | 'png' | 'webp';
      quality?: number;
      viewport?: ViewportSize;
      devicePixelRatio?: number;
    },
  ): Promise<{ data: string; dimensions: ScreenshotDimensions }> {
    const format = options?.format ?? 'jpeg';
    const quality = options?.quality ?? 80;

    // Get viewport dimensions if not provided
    let viewport = options?.viewport;
    if (!viewport) {
      const layoutMetrics = await this.sendCommand<{
        cssLayoutViewport: { clientWidth: number; clientHeight: number };
      }>(tabId, 'Page.getLayoutMetrics');
      viewport = {
        width: layoutMetrics.cssLayoutViewport.clientWidth,
        height: layoutMetrics.cssLayoutViewport.clientHeight,
      };
    }

    const dpr = options?.devicePixelRatio ?? 1;
    const dimensions = calculateScreenshotDimensions(viewport, dpr);

    // Use clip to capture at the desired dimensions
    const result = await this.sendCommand<{ data: string }>(
      tabId,
      'Page.captureScreenshot',
      {
        format,
        quality,
        clip: {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
          scale: dimensions.width / (viewport.width * dpr),
        },
      },
    );

    return { data: result.data, dimensions };
  }

  /**
   * Check if the debugger is currently attached to a tab.
   */
  isAttached(tabId: number): boolean {
    return this.connections.get(tabId)?.attached ?? false;
  }

  /**
   * Get all currently attached tab IDs.
   */
  getAttachedTabs(): number[] {
    return Array.from(this.connections.entries())
      .filter(([, conn]) => conn.attached)
      .map(([tabId]) => tabId);
  }

  /**
   * Check if an attached tab is healthy and responding to CDP commands.
   * Sends a lightweight CDP command to test responsiveness.
   *
   * @param tabId - The tab to check
   * @returns true if the tab responds, false if timeout/error occurs
   */
  async checkTabHealth(tabId: number): Promise<boolean> {
    const connection = this.connections.get(tabId);
    if (!connection?.attached) {
      console.log(`[CDP] Health check failed: tab ${tabId} not attached`);
      return false;
    }

    try {
      // Send lightweight command to test responsiveness
      await this.sendCommand(tabId, 'Page.getLayoutMetrics', {});
      console.log(`[CDP] Health check passed for tab ${tabId}`);
      return true;
    } catch (error) {
      console.warn(`[CDP] Health check failed for tab ${tabId}:`, error);
      return false;
    }
  }

  /**
   * Force a debugger detach and reattach cycle, even if we think
   * the connection is healthy. Useful for recovering from zombie
   * CDP sessions where the connection appears attached but is
   * actually non-responsive.
   *
   * @param tabId - The tab to force reattach
   */
  async forceReattach(tabId: number): Promise<void> {
    const connection = this.connections.get(tabId);
    if (!connection) {
      throw new Error(`No connection record for tab ${tabId}`);
    }

    console.log(`[CDP] Force reattach initiated for tab ${tabId}`);

    // Save previously enabled domains
    const previousDomains = new Set(connection.enabledDomains);

    // Mark as user-initiated temporarily to prevent auto-reattach loop
    const wasUserDetached = connection.userDetached;
    connection.userDetached = true;

    // Force detach
    await this.detach(tabId);

    // Restore flag state for the new connection
    connection.userDetached = wasUserDetached;

    // Reattach
    await this.attach(tabId);

    // Re-enable previously active domains (except Page, which attach() enables)
    for (const domain of previousDomains) {
      if (domain !== 'Page') {
        await this.enableDomain(tabId, domain);
      }
    }

    console.log(`[CDP] Force reattach completed for tab ${tabId}`);
  }

  /**
   * Register a listener for CDP events from all attached tabs.
   */
  addEventListener(listener: CDPEventListener): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove a previously registered CDP event listener.
   */
  removeEventListener(listener: CDPEventListener): void {
    const idx = this.eventListeners.indexOf(listener);
    if (idx !== -1) {
      this.eventListeners.splice(idx, 1);
    }
  }

  // --- Keepalive ---

  /**
   * Start the keepalive screencast for a tab.
   * The screencast prevents Chrome from auto-detaching the debugger
   * after 30 seconds of inactivity.
   */
  private startKeepalive(tabId: number): void {
    const connection = this.connections.get(tabId);
    if (!connection) return;

    this.stopKeepalive(tabId);

    // Start low-overhead screencast
    chrome.debugger
      .sendCommand({ tabId }, 'Page.startScreencast', KEEPALIVE_SCREENCAST)
      .catch((err: unknown) => {
        console.warn(
          `[CDP] Failed to start screencast keepalive for tab ${tabId}:`,
          err,
        );
      });

    // Periodically ack screencast frames to keep it alive
    connection.keepaliveTimer = setInterval(() => {
      if (!connection.attached) {
        this.stopKeepalive(tabId);
        return;
      }
      // Sending any command keeps the debugger session alive.
      // We ack the screencast frame with sessionId 0 (noop but valid).
      chrome.debugger
        .sendCommand({ tabId }, 'Page.screencastFrameAck', { sessionId: 0 })
        .catch(() => {
          // Tab might have navigated or been closed
        });
    }, KEEPALIVE_INTERVAL_MS);
  }

  /**
   * Stop the keepalive screencast for a tab.
   */
  private stopKeepalive(tabId: number): void {
    const connection = this.connections.get(tabId);
    if (!connection) return;

    if (connection.keepaliveTimer !== null) {
      clearInterval(connection.keepaliveTimer);
      connection.keepaliveTimer = null;
    }

    if (connection.attached) {
      chrome.debugger
        .sendCommand({ tabId }, 'Page.stopScreencast')
        .catch(() => {
          // Ignore errors during cleanup
        });
    }
  }

  // --- Event Handling ---

  /**
   * Handle a debugger detach event. If the detach was not user-initiated,
   * attempt to reattach.
   */
  private handleDetach(
    source: chrome.debugger.Debuggee,
    reason: DetachReason,
  ): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;

    const connection = this.connections.get(tabId);
    if (!connection) return;

    console.log(`[CDP] Detached from tab ${tabId}: ${reason}`);

    connection.attached = false;
    this.stopKeepalive(tabId);

    // If user initiated or canceled by user, don't reattach
    if (connection.userDetached || reason === 'canceled_by_user') {
      this.connections.delete(tabId);
      this.persistState().catch(() => {});
      return;
    }

    // Attempt auto-reattach for unexpected detaches
    if (connection.reattachAttempts < MAX_REATTACH_ATTEMPTS) {
      connection.reattachAttempts++;
      console.log(
        `[CDP] Attempting reattach to tab ${tabId} (attempt ${connection.reattachAttempts}/${MAX_REATTACH_ATTEMPTS})`,
      );

      setTimeout(() => {
        this.reattach(tabId).catch((err: unknown) => {
          console.error(`[CDP] Reattach to tab ${tabId} failed:`, err);
          if (connection.reattachAttempts >= MAX_REATTACH_ATTEMPTS) {
            this.connections.delete(tabId);
            this.persistState().catch(() => {});
          }
        });
      }, REATTACH_DELAY_MS);
    } else {
      this.connections.delete(tabId);
      this.persistState().catch(() => {});
    }
  }

  /**
   * Reattach the debugger to a tab after unexpected detach.
   * Restores previously enabled domains.
   */
  private async reattach(tabId: number): Promise<void> {
    const connection = this.connections.get(tabId);
    if (!connection || connection.attached) return;

    // Verify the tab still exists
    try {
      await chrome.tabs.get(tabId);
    } catch {
      // Tab no longer exists
      this.connections.delete(tabId);
      await this.persistState();
      return;
    }

    const previousDomains = new Set(connection.enabledDomains);

    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    connection.attached = true;
    connection.enabledDomains = new Set();

    // Re-enable previously active domains
    for (const domain of previousDomains) {
      await this.enableDomain(tabId, domain);
    }

    // Restart keepalive
    this.startKeepalive(tabId);

    await this.persistState();

    console.log(`[CDP] Reattached to tab ${tabId}`);
  }

  /**
   * Handle a CDP event from an attached target.
   * Dispatches to all registered event listeners.
   */
  private handleEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    // Forward to all registered listeners
    for (const listener of this.eventListeners) {
      try {
        listener(source, method, params);
      } catch (err) {
        console.error('[CDP] Event listener error:', err);
      }
    }
  }

  // --- Service Worker Lifecycle ---

  /**
   * Persist the current CDP state to chrome.storage.session
   * so it can be restored after service worker restart.
   */
  private async persistState(): Promise<void> {
    const state: PersistedTabState[] = [];

    for (const [tabId, connection] of this.connections) {
      if (connection.attached) {
        state.push({
          tabId,
          enabledDomains: Array.from(connection.enabledDomains),
        });
      }
    }

    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: state });
    } catch (err) {
      console.warn('[CDP] Failed to persist state:', err);
    }
  }

  /**
   * Restore CDP connections from chrome.storage.session after
   * a service worker restart.
   */
  private async restoreConnections(): Promise<void> {
    try {
      const result = await chrome.storage.session.get(STORAGE_KEY);
      const states: PersistedTabState[] = result[STORAGE_KEY] ?? [];

      if (states.length === 0) return;

      console.log(`[CDP] Restoring ${states.length} connection(s)`);

      for (const state of states) {
        try {
          // Check if tab still exists
          await chrome.tabs.get(state.tabId);

          // Check if already attached (might still be from before suspend)
          const targets = await chrome.debugger.getTargets();
          const isAttached = targets.some(
            (t) => t.tabId === state.tabId && t.attached,
          );

          if (isAttached) {
            // Still attached - just restore our state tracking
            const connection: TabConnection = {
              tabId: state.tabId,
              attached: true,
              enabledDomains: new Set(state.enabledDomains),
              keepaliveTimer: null,
              reattachAttempts: 0,
              userDetached: false,
            };
            this.connections.set(state.tabId, connection);
            this.startKeepalive(state.tabId);
          } else {
            // Not attached - reattach
            await this.attach(state.tabId);
            // Re-enable previously active domains beyond Page (which attach() enables)
            for (const domain of state.enabledDomains) {
              if (domain !== 'Page') {
                await this.enableDomain(state.tabId, domain);
              }
            }
          }

          console.log(`[CDP] Restored connection to tab ${state.tabId}`);
        } catch (err) {
          console.warn(
            `[CDP] Failed to restore tab ${state.tabId}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.warn('[CDP] Failed to restore connections:', err);
    }
  }

  /**
   * Handle the periodic keepalive alarm. Ensures all attached
   * debugger connections are still alive.
   */
  private onKeepaliveAlarm(): void {
    for (const [tabId, connection] of this.connections) {
      if (!connection.attached) continue;

      // Send a lightweight CDP command to keep the connection active
      chrome.debugger
        .sendCommand({ tabId }, 'Page.getLayoutMetrics')
        .catch(() => {
          // Connection may have been lost
          console.warn(`[CDP] Keepalive failed for tab ${tabId}`);
        });
    }
  }

  /**
   * Clean up connection state when a tab is removed.
   */
  private cleanupTab(tabId: number): void {
    const connection = this.connections.get(tabId);
    if (!connection) return;

    this.stopKeepalive(tabId);
    this.connections.delete(tabId);
    this.persistState().catch(() => {});

    console.log(`[CDP] Cleaned up tab ${tabId} (tab removed)`);
  }
}

/** Singleton instance */
export const cdpManager = CDPManager.getInstance();
