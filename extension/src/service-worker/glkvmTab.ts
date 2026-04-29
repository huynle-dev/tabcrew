/**
 * GLKVM tab discovery and video detection utilities.
 *
 * Provides reusable functions for locating GLKVM tabs in the browser,
 * resolving a target identifier to a specific tab, and extracting
 * video element metadata from a GLKVM page.
 *
 * Tab Detection:
 *   GLKVM tabs are identified by URL pattern (hash-routed SPA with
 *   `/#/` fragment) combined with the page title "GLKVM".
 *
 * Target Resolution:
 *   GLKVM tools accept an optional `target` string (URL or hostname).
 *   When omitted, auto-detection picks the sole GLKVM tab. When
 *   multiple GLKVM tabs are open, the caller must specify a target
 *   or provide a `tabId` directly. An explicit numeric `tabId` always
 *   takes precedence.
 *
 * Video Metadata:
 *   The GLKVM web app renders the KVM video feed inside a `<video>`
 *   element. These utilities extract intrinsic dimensions (videoWidth,
 *   videoHeight) and the displayed bounding rect for coordinate mapping.
 */

import { cdpManager } from "./cdp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Information about a discovered GLKVM tab */
export interface GlkvmTabInfo {
  readonly tabId: number;
  readonly title: string;
  readonly url: string;
}

/** Metadata extracted from the GLKVM video element */
export interface GlkvmVideoMetadata {
  /** Intrinsic (native) width of the video feed in pixels */
  readonly videoWidth: number;
  /** Intrinsic (native) height of the video feed in pixels */
  readonly videoHeight: number;
  /** Displayed bounding rectangle of the video element on the page */
  readonly displayRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Whether the video element is currently visible (not hidden/zero-size) */
  readonly visible: boolean;
}

/** Result of resolving a GLKVM target to a tab ID */
export interface ResolvedGlkvmTarget {
  readonly tabId: number;
  readonly tab: GlkvmTabInfo;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * URL fragment pattern that identifies a GLKVM single-page app.
 * GLKVM uses hash-based routing with `/#/` as the root.
 */
const GLKVM_HASH_PATTERN = /#\//;

/**
 * Page title used by GLKVM web interface.
 * Used as a secondary signal alongside the URL pattern.
 */
const GLKVM_TITLE = "GLKVM";

// ---------------------------------------------------------------------------
// Tab Discovery
// ---------------------------------------------------------------------------

/**
 * Find all open tabs that appear to be GLKVM instances.
 *
 * Detection uses URL pattern matching (hash fragment `/#/`) combined
 * with the page title containing "GLKVM". Both criteria must match
 * to avoid false positives from other hash-routed SPAs.
 *
 * @returns Array of GLKVM tab info objects, possibly empty.
 */
export async function findGlkvmTabs(): Promise<GlkvmTabInfo[]> {
  const allTabs = await chrome.tabs.query({});

  return allTabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => {
      if (tab.id === undefined) return false;

      const url = tab.url ?? "";
      const title = tab.title ?? "";

      // Must have the hash-routing pattern AND "GLKVM" in the title
      return GLKVM_HASH_PATTERN.test(url) && title.includes(GLKVM_TITLE);
    })
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title ?? "",
      url: tab.url ?? "",
    }));
}

/**
 * Resolve a GLKVM target to a specific tab ID.
 *
 * Resolution precedence:
 * 1. Explicit `tabId` — used directly if provided (validated to exist).
 * 2. `target` string — matched against GLKVM tab URLs by hostname or full URL.
 * 3. Auto-detection — if no target/tabId given:
 *    - Zero GLKVM tabs → error
 *    - One GLKVM tab → auto-selected
 *    - Multiple GLKVM tabs → error (ambiguous)
 *
 * @param options - Optional target identifier and/or tabId.
 * @returns The resolved tab ID and tab info.
 * @throws Error if no matching GLKVM tab is found or selection is ambiguous.
 */
export async function resolveGlkvmTab(options?: {
  target?: string;
  tabId?: number;
}): Promise<ResolvedGlkvmTarget> {
  const { target, tabId } = options ?? {};

  // --- Explicit tabId takes precedence ---
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return {
        tabId,
        tab: {
          tabId,
          title: tab.title ?? "",
          url: tab.url ?? "",
        },
      };
    } catch {
      throw new Error(
        `Tab ${tabId} not found. The tab may have been closed.`,
      );
    }
  }

  // --- Discover GLKVM tabs ---
  const glkvmTabs = await findGlkvmTabs();

  // --- Match by target string ---
  if (target) {
    const matched = matchTabByTarget(glkvmTabs, target);
    if (matched) {
      return { tabId: matched.tabId, tab: matched };
    }

    // Target didn't match any GLKVM tab
    if (glkvmTabs.length === 0) {
      throw new Error(
        `No GLKVM tab found matching "${target}". Open and log in to your GLKVM device first.`,
      );
    }

    const available = glkvmTabs
      .map((t) => `  - ${t.url} (tab ${t.tabId})`)
      .join("\n");
    throw new Error(
      `No GLKVM tab matches target "${target}". Available GLKVM tabs:\n${available}`,
    );
  }

  // --- Auto-detection (no target or tabId) ---
  if (glkvmTabs.length === 0) {
    throw new Error(
      "No GLKVM tab found. Open and log in to your GLKVM device first.",
    );
  }

  if (glkvmTabs.length === 1) {
    const tab = glkvmTabs[0];
    return { tabId: tab.tabId, tab };
  }

  // Multiple tabs — ambiguous
  const available = glkvmTabs
    .map((t) => `  - ${t.url} (tab ${t.tabId})`)
    .join("\n");
  throw new Error(
    `Multiple GLKVM tabs found. Specify a target to select one:\n${available}`,
  );
}

// ---------------------------------------------------------------------------
// Video Detection
// ---------------------------------------------------------------------------

/**
 * Detect the active GLKVM video element and return its metadata.
 *
 * Executes a script in the GLKVM tab's page context via CDP
 * `Runtime.evaluate` to locate the `<video>` element, read its
 * intrinsic dimensions (videoWidth / videoHeight), and measure
 * its displayed bounding rect.
 *
 * @param tabId - The tab ID of a GLKVM page.
 * @returns Video metadata including intrinsic and displayed dimensions.
 * @throws Error if no video element is found or it has no video source.
 */
export async function getVideoMetadata(
  tabId: number,
): Promise<GlkvmVideoMetadata> {
  // Ensure CDP is attached to the tab
  if (!cdpManager.isAttached(tabId)) {
    await cdpManager.attach(tabId);
  }

  const script = `
    (() => {
      const video = document.querySelector('video');
      if (!video) return { error: 'no_video', message: 'No <video> element found on this page.' };

      const rect = video.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0
        && video.offsetParent !== null
        && getComputedStyle(video).display !== 'none'
        && getComputedStyle(video).visibility !== 'hidden';

      return {
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        displayRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        visible,
      };
    })()
  `;

  const evalResult = await cdpManager.sendCommand<{
    result: {
      type: string;
      value?: {
        error?: string;
        message?: string;
        videoWidth?: number;
        videoHeight?: number;
        displayRect?: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        visible?: boolean;
      };
    };
    exceptionDetails?: {
      text: string;
      exception?: { description?: string };
    };
  }>(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
  });

  // Handle evaluation errors
  if (evalResult.exceptionDetails) {
    const msg =
      evalResult.exceptionDetails.exception?.description ??
      evalResult.exceptionDetails.text ??
      "Unknown error";
    throw new Error(`Failed to detect video element: ${msg}`);
  }

  const value = evalResult.result.value;
  if (!value) {
    throw new Error("Failed to detect video element: no result returned.");
  }

  // Handle application-level errors (no video element found)
  if (value.error) {
    throw new Error(value.message ?? "No video element found.");
  }

  // Validate we got actual video dimensions
  const videoWidth = value.videoWidth ?? 0;
  const videoHeight = value.videoHeight ?? 0;

  return {
    videoWidth,
    videoHeight,
    displayRect: value.displayRect ?? { x: 0, y: 0, width: 0, height: 0 },
    visible: value.visible ?? false,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Match a GLKVM tab against a target string.
 *
 * The target can be:
 * - A full URL (matched against tab URL)
 * - A hostname (matched against the host portion of tab URL)
 * - A partial hostname (matched as substring of the host)
 */
function matchTabByTarget(
  tabs: GlkvmTabInfo[],
  target: string,
): GlkvmTabInfo | undefined {
  // Normalize target: strip protocol if present for hostname matching
  const normalizedTarget = target.toLowerCase();

  // Try exact URL match first
  const exactMatch = tabs.find(
    (t) => t.url.toLowerCase() === normalizedTarget,
  );
  if (exactMatch) return exactMatch;

  // Try hostname match
  for (const tab of tabs) {
    try {
      const tabUrl = new URL(tab.url);
      const tabHost = tabUrl.hostname.toLowerCase();

      // Direct hostname match
      if (tabHost === normalizedTarget) return tab;

      // Try parsing target as URL and comparing hosts
      try {
        const targetUrl = new URL(
          normalizedTarget.includes("://")
            ? normalizedTarget
            : `https://${normalizedTarget}`,
        );
        if (tabHost === targetUrl.hostname.toLowerCase()) return tab;
      } catch {
        // Target is not a valid URL, try substring
      }

      // Substring match on hostname (e.g., "kvm" matches "kvm.example.com")
      if (tabHost.includes(normalizedTarget)) return tab;
    } catch {
      // Tab URL not parseable, skip
    }
  }

  return undefined;
}
