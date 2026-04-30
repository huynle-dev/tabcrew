/**
 * GLKVM HID WebSocket transport — manages authenticated WebSocket
 * connections to GLKVM's /api/ws endpoint for sending HID packets.
 *
 * Architecture:
 *   The service worker cannot directly authenticate WebSocket connections
 *   to GLKVM (the server requires cookies set by the page). Instead,
 *   this transport executes JavaScript in the GLKVM tab's page context
 *   via CDP Runtime.evaluate. The injected code:
 *
 *   1. Reads the auth token from localStorage
 *   2. Opens a WebSocket to /api/ws?auth_token=<token>
 *   3. Waits for the connection to be established
 *   4. Sends binary HID packets
 *   5. Closes the connection when done
 *
 * Session Model:
 *   Each transport session is identified by a random session ID. Sessions
 *   are stored as globals on the GLKVM page's window object, allowing
 *   reuse across multiple tool invocations without re-establishing the
 *   WebSocket each time.
 *
 * Lifecycle:
 *   connect() → send() → send() → ... → close()
 *
 * Error Categories:
 *   - AUTH_FAILED: No auth token found or server rejected credentials
 *   - TAB_NOT_FOUND: The GLKVM tab ID is invalid or tab was closed
 *   - CONNECTION_FAILED: WebSocket could not connect (offline, DNS, etc.)
 *   - PROTOCOL_ERROR: WebSocket closed unexpectedly or send failed
 *   - TIMEOUT: Operation exceeded the allowed time
 *   - EVAL_ERROR: CDP Runtime.evaluate failed
 */

import { cdpManager } from "../cdp.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Distinguishable error categories for GLKVM transport failures */
export type GlkvmTransportErrorCode =
  | "AUTH_FAILED"
  | "TAB_NOT_FOUND"
  | "CONNECTION_FAILED"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "EVAL_ERROR";

/** Structured error from the GLKVM transport layer */
export class GlkvmTransportError extends Error {
  readonly code: GlkvmTransportErrorCode;
  readonly reconnect?: GlkvmReconnectDiagnostics;

  constructor(
    code: GlkvmTransportErrorCode,
    message: string,
    reconnect?: GlkvmReconnectDiagnostics,
  ) {
    super(message);
    this.name = "GlkvmTransportError";
    this.code = code;
    this.reconnect = reconnect;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from page-context WebSocket operations */
interface PageContextResult {
  ok: boolean;
  error?: string;
  errorCode?: GlkvmTransportErrorCode;
  sessionId?: string;
  readyState?: number;
  status?: number;
  cleanupFailed?: boolean;
  releasedKeys?: number;
  releasedButtons?: number;
}

/** Session state tracked by the transport */
export interface GlkvmSession {
  /** Random session ID used as the window property name in page context */
  readonly sessionId: string;
  /** Tab ID where the WebSocket lives */
  readonly tabId: number;
  /** When the session was created */
  readonly createdAt: number;
  /** Diagnostics for requested-session reuse/reconnect decisions, when applicable */
  readonly reconnect?: GlkvmReconnectDiagnostics;
}

/** Diagnostics for connect({ sessionId }) reuse and reconnect decisions. */
export interface GlkvmReconnectDiagnostics {
  requestedSessionId: string;
  action: "reused" | "missing" | "closed" | "unavailable";
  readyState?: number;
  error?: string;
  errorCode?: GlkvmTransportErrorCode;
  reconnected?: boolean;
  replacementSessionId?: string;
}

/** Options for establishing a connection */
export interface ConnectOptions {
  /** Tab ID of the GLKVM page */
  tabId: number;
  /** Reuse an existing session by ID (skip opening a new WebSocket) */
  sessionId?: string;
  /** Connection timeout in milliseconds (default: 10000) */
  timeout?: number;
}

/** Options for sending HID packets */
export interface SendOptions {
  /** Session to send on */
  session: GlkvmSession;
  /** Binary packets to send (Uint8Array from kvmHidEncoder) */
  packets: Uint8Array[];
}

/** Options for sending text through KVMD's paste-as-keys endpoint */
export interface PasteTextOptions {
  /** Tab ID of the GLKVM page */
  tabId: number;
  /** Text to type on the remote target */
  text: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
}

/** Options for explicit page-context session cleanup */
export interface CleanupOptions {
  /** Send key/button up packets for anything tracked as pressed */
  releaseAll?: boolean;
  /** Close the WebSocket and delete the page global (default: false) */
  close?: boolean;
}

/** Non-throwing cleanup result so callers can distinguish cleanup failures */
export interface CleanupOutcome {
  ok: boolean;
  cleanupFailed?: boolean;
  error?: string;
  errorCode?: GlkvmTransportErrorCode;
  releasedKeys?: number;
  releasedButtons?: number;
}

/** Cleanup result for a tracked service-worker session */
export interface SessionCleanupOutcome extends CleanupOutcome {
  tabId: number;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for WebSocket connection in milliseconds */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Default timeout for HTTP paste-as-keys requests */
const DEFAULT_PASTE_TIMEOUT_MS = 10_000;

/** Prefix for session globals on the GLKVM page window object */
const SESSION_PREFIX = "__oc_kvm_";

/** localStorage keys where GLKVM stores auth tokens */
const TOKEN_KEY_MULTI = "gl-kvm-token-keys";
const TOKEN_KEY_SINGLE = "gl-kvm-token-key";

const sessionsByTabId = new Map<number, Map<string, GlkvmSession>>();
const hidOperationQueuesByTabId = new Map<number, Promise<void>>();
let tabRemovalCleanupInitialized = false;

function trackSession(session: GlkvmSession): void {
  let tabSessions = sessionsByTabId.get(session.tabId);
  if (!tabSessions) {
    tabSessions = new Map();
    sessionsByTabId.set(session.tabId, tabSessions);
  }
  tabSessions.set(session.sessionId, session);
}

function untrackSession(session: GlkvmSession): void {
  const tabSessions = sessionsByTabId.get(session.tabId);
  if (!tabSessions) return;
  tabSessions.delete(session.sessionId);
  if (tabSessions.size === 0) sessionsByTabId.delete(session.tabId);
}

// ---------------------------------------------------------------------------
// Page-context scripts
// ---------------------------------------------------------------------------

/**
 * Build the JavaScript to inject into the GLKVM page context for
 * establishing a WebSocket connection.
 *
 * The script:
 * 1. Reads the auth token from localStorage
 * 2. Constructs the WebSocket URL from the current page origin
 * 3. Opens the WebSocket with auth_token query parameter
 * 4. Resolves when the connection is open or rejects on error/timeout
 * 5. Stores the WebSocket on window[sessionKey] for later reuse
 */
function buildConnectScript(sessionKey: string, timeoutMs: number): string {
  return `
    (async () => {
      try {
        const sessionKey = ${JSON.stringify(sessionKey)};
        // --- Read auth token ---
        let token = null;
        const multiRaw = localStorage.getItem(${JSON.stringify(TOKEN_KEY_MULTI)});
        if (multiRaw) {
          try {
            const parsed = JSON.parse(multiRaw);
            // Token object is keyed by device name; take the first value
            const values = Object.values(parsed);
            if (values.length > 0) token = values[0];
          } catch {}
        }
        if (!token) {
          token = localStorage.getItem(${JSON.stringify(TOKEN_KEY_SINGLE)});
        }
        if (!token) {
          return { ok: false, error: "No GLKVM auth token found in localStorage. Log in to the GLKVM web interface first.", errorCode: "AUTH_FAILED" };
        }

        // --- Build WebSocket URL ---
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = proto + "//" + location.host + "/api/ws?auth_token=" + encodeURIComponent(token);

        // --- Open WebSocket ---
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";

        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try { ws.close(); } catch {}
            resolve({ ok: false, error: "WebSocket connection timed out after ${timeoutMs}ms", errorCode: "TIMEOUT" });
          }, ${timeoutMs});

          ws.addEventListener("open", () => {
            clearTimeout(timer);
            resolve({ ok: true });
          });

          ws.addEventListener("error", () => {
            clearTimeout(timer);
            resolve({ ok: false, error: "WebSocket connection failed. The GLKVM device may be offline or unreachable.", errorCode: "CONNECTION_FAILED" });
          });

          ws.addEventListener("close", (e) => {
            clearTimeout(timer);
            if (e.code === 1008 || e.code === 4401 || e.code === 4403) {
              resolve({ ok: false, error: "WebSocket authentication rejected (close code " + e.code + "). Re-authenticate in the GLKVM web interface.", errorCode: "AUTH_FAILED" });
            } else {
              resolve({ ok: false, error: "WebSocket closed before connecting (code " + e.code + ", reason: " + (e.reason || "none") + ")", errorCode: "CONNECTION_FAILED" });
            }
          });
        });

        if (!result.ok) return result;

        // --- Store session ---
        const session = {
          ws,
          pressedKeys: new Set(),
          pressedButtons: new Set(),
        };
        ws.addEventListener("close", () => {
          if (window[sessionKey] === session) {
            delete window[sessionKey];
          }
        });
        window[sessionKey] = session;
        return { ok: true, sessionId: sessionKey, readyState: ws.readyState };
      } catch (e) {
        return { ok: false, error: "Unexpected error: " + (e && e.message || String(e)), errorCode: "CONNECTION_FAILED" };
      }
    })()
  `;
}

/**
 * Build JavaScript to check if an existing session's WebSocket is still open.
 */
function buildCheckSessionScript(sessionKey: string): string {
  return `
    (() => {
      const stored = window[${JSON.stringify(sessionKey)}];
      if (!stored) return { ok: false, error: "Session not found", errorCode: "PROTOCOL_ERROR" };
      const ws = stored.ws || stored;
      return { ok: true, sessionId: ${JSON.stringify(sessionKey)}, readyState: ws.readyState };
    })()
  `;
}

/** Shared page-context helper for wrapper sessions, legacy raw WebSocket sessions, and releases. */
function buildSessionHelperScript(sessionKey: string): string {
  return `
      const sessionKey = ${JSON.stringify(sessionKey)};
      const stored = window[sessionKey];
      if (!stored) return { ok: false, error: "Session not found. The WebSocket may have been closed.", errorCode: "PROTOCOL_ERROR" };
      const session = stored.ws ? stored : {
        ws: stored,
        pressedKeys: new Set(),
        pressedButtons: new Set(),
      };
      if (!stored.ws) window[sessionKey] = session;
      const ws = session.ws;
      if (!session.pressedKeys) session.pressedKeys = new Set();
      if (!session.pressedButtons) session.pressedButtons = new Set();
      const decodeName = (arr) => String.fromCharCode(...arr.slice(2));
      const sendPacket = (arr) => ws.send(new Uint8Array(arr).buffer);
      const releaseTracked = () => {
        const keys = Array.from(session.pressedKeys);
        const buttons = Array.from(session.pressedButtons);
        for (const key of keys) {
          ws.send(new Uint8Array([1, 0, ...Array.from(String(key), (ch) => ch.charCodeAt(0))]).buffer);
        }
        for (const button of buttons) {
          ws.send(new Uint8Array([2, 0, ...Array.from(String(button), (ch) => ch.charCodeAt(0))]).buffer);
        }
        session.pressedKeys.clear();
        session.pressedButtons.clear();
        return { releasedKeys: keys.length, releasedButtons: buttons.length };
      };
  `;
}

/**
 * Build JavaScript to send binary packets on an existing session.
 *
 * The packets are passed as JSON arrays of numbers, then converted
 * to Uint8Array in page context for WebSocket.send().
 */
function buildSendScript(
  sessionKey: string,
  packetArrays: number[][],
): string {
  const packetsJson = JSON.stringify(packetArrays);
  return `
    (() => {
${buildSessionHelperScript(sessionKey)}
      if (ws.readyState !== WebSocket.OPEN) {
        return { ok: false, error: "WebSocket is not open (readyState=" + ws.readyState + ")", errorCode: "PROTOCOL_ERROR" };
      }
      try {
        const packets = ${packetsJson};
        for (const arr of packets) {
          sendPacket(arr);
          if (arr[0] === 1) {
            const key = decodeName(arr);
            if (arr[1] === 1) session.pressedKeys.add(key);
            if (arr[1] === 0) session.pressedKeys.delete(key);
          }
          if (arr[0] === 2) {
            const button = decodeName(arr);
            if (arr[1] === 1) session.pressedButtons.add(button);
            if (arr[1] === 0) session.pressedButtons.delete(button);
          }
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: "Send failed: " + (e && e.message || String(e)), errorCode: "PROTOCOL_ERROR" };
      }
    })()
  `;
}

/**
 * Build JavaScript to send text through KVMD's authenticated paste-as-keys API.
 */
function buildPasteTextScript(text: string, timeoutMs: number): string {
  return `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${timeoutMs});
      try {
        const response = await fetch("/api/hid/print", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: ${JSON.stringify(text)},
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
          let detail = "";
          try { detail = (await response.text()).trim(); } catch {}
          const suffix = detail || response.statusText || "HTTP error";
          const authFailed = response.status === 401 || response.status === 403;
          const tooLarge = response.status === 413;
          const hidOffline = response.status === 503;
          let message = "GLKVM paste-as-keys endpoint returned " + response.status + ": " + suffix;
          if (authFailed) message += ". Re-authenticate in the GLKVM web interface.";
          if (tooLarge) message += ". Reduce the text size and retry.";
          if (hidOffline) message += ". HID may be offline or disabled.";
          return {
            ok: false,
            status: response.status,
            error: message,
            errorCode: authFailed ? "AUTH_FAILED" : "PROTOCOL_ERROR",
          };
        }
        return { ok: true, status: response.status };
      } catch (e) {
        clearTimeout(timer);
        if (e && e.name === "AbortError") {
          return { ok: false, error: "GLKVM paste-as-keys endpoint timed out after ${timeoutMs}ms", errorCode: "TIMEOUT" };
        }
        return { ok: false, error: "GLKVM paste-as-keys endpoint request failed: " + (e && e.message || String(e)), errorCode: "CONNECTION_FAILED" };
      }
    })()
  `;
}

/**
 * Build JavaScript to release tracked inputs and optionally close a session.
 */
function buildCleanupScript(
  sessionKey: string,
  options: Required<CleanupOptions>,
): string {
  const closeBlock = options.close
    ? `
      try { ws.close(); } catch (e) {
        return { ok: false, cleanupFailed: true, error: "Close failed: " + (e && e.message || String(e)), errorCode: "PROTOCOL_ERROR", releasedKeys, releasedButtons };
      }
      delete window[sessionKey];
    `
    : "";
  return `
    (() => {
${buildSessionHelperScript(sessionKey)}
      let releasedKeys = 0;
      let releasedButtons = 0;
      let cleanupError = null;
      let cleanupErrorCode = null;
      if (${JSON.stringify(options.releaseAll)}) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            const released = releaseTracked();
            releasedKeys = released.releasedKeys;
            releasedButtons = released.releasedButtons;
          } catch (e) {
            cleanupError = "Release-all failed: " + (e && e.message || String(e));
            cleanupErrorCode = "PROTOCOL_ERROR";
          }
        } else {
          cleanupError = "Release-all failed: WebSocket is not open (readyState=" + ws.readyState + ")";
          cleanupErrorCode = "PROTOCOL_ERROR";
        }
      }
${closeBlock}
      if (cleanupError) {
        return { ok: false, cleanupFailed: true, error: cleanupError, errorCode: cleanupErrorCode, releasedKeys, releasedButtons };
      }
      return { ok: true, releasedKeys, releasedButtons };
    })()
  `;
}

// ---------------------------------------------------------------------------
// CDP evaluation helper
// ---------------------------------------------------------------------------

/** CDP Runtime.evaluate response shape */
interface EvaluateResponse {
  result: {
    type: string;
    value?: PageContextResult;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

/**
 * Execute a script in a tab's page context and return the result.
 * Handles CDP attachment, evaluation errors, and result extraction.
 */
async function evaluateInPage(
  tabId: number,
  expression: string,
  awaitPromise: boolean,
): Promise<PageContextResult> {
  // Ensure CDP is attached
  if (!cdpManager.isAttached(tabId)) {
    try {
      await cdpManager.attach(tabId);
    } catch (err) {
      throw new GlkvmTransportError(
        "TAB_NOT_FOUND",
        `Cannot attach debugger to tab ${tabId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let evalResult: EvaluateResponse;
  try {
    evalResult = await cdpManager.sendCommand<EvaluateResponse>(
      tabId,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
      },
    );
  } catch (err) {
    throw new GlkvmTransportError(
      "EVAL_ERROR",
      `CDP Runtime.evaluate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Handle CDP-level exceptions
  if (evalResult.exceptionDetails) {
    const msg =
      evalResult.exceptionDetails.exception?.description ??
      evalResult.exceptionDetails.text ??
      "Unknown evaluation error";
    throw new GlkvmTransportError("EVAL_ERROR", `Page script error: ${msg}`);
  }

  const value = evalResult.result.value;
  if (!value) {
    throw new GlkvmTransportError(
      "EVAL_ERROR",
      "No result returned from page context evaluation",
    );
  }

  return value;
}

// ---------------------------------------------------------------------------
// Transport functions
// ---------------------------------------------------------------------------

/**
 * Generate a unique session key for storing the WebSocket on the page window.
 */
export function generateSessionId(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return `${SESSION_PREFIX}${id}`;
}

/** Return tracked HID sessions for a tab from service-worker memory. */
export function getHidSessionsForTab(tabId: number): GlkvmSession[] {
  return Array.from(sessionsByTabId.get(tabId)?.values() ?? []);
}

/**
 * Serialize HID-affecting operations per browser tab.
 *
 * Same-tab operations run FIFO so key/button packets from independent callers
 * cannot interleave. Different tabs use independent queues. Failures release the
 * queue so later cleanup or input operations can still run.
 */
export function withTabHidOperationLock<T>(
  tabId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = hidOperationQueuesByTabId.get(tabId);
  let run: Promise<T>;
  if (previous) {
    run = previous.catch(() => undefined).then(operation);
  } else {
    try {
      run = Promise.resolve(operation());
    } catch (err) {
      run = Promise.reject(err);
    }
  }
  const tail = run
    .catch(() => undefined)
    .then(() => undefined)
    .finally(() => {
      if (hidOperationQueuesByTabId.get(tabId) === tail) {
        hidOperationQueuesByTabId.delete(tabId);
      }
    });
  hidOperationQueuesByTabId.set(tabId, tail);
  return run;
}

/**
 * Register the service-worker tab-removal hook that forgets tracked HID sessions.
 * Once a tab is gone, page-context release packets are no longer possible; the
 * explicit tabs_close path performs release-all before removal.
 */
export function initKvmHidCleanup(): void {
  if (tabRemovalCleanupInitialized) return;
  const onRemoved = globalThis.chrome?.tabs?.onRemoved;
  if (!onRemoved) return;

  onRemoved.addListener((tabId: number) => {
    sessionsByTabId.delete(tabId);
  });
  tabRemovalCleanupInitialized = true;
}

/** Release/close every tracked HID session for a tab before destructive actions. */
export async function cleanupSessionsForTab(
  tabId: number,
  options: CleanupOptions = { releaseAll: true, close: true },
): Promise<SessionCleanupOutcome[]> {
  return withTabHidOperationLock(tabId, async () => {
    const sessions = getHidSessionsForTab(tabId);
    const outcomes: SessionCleanupOutcome[] = [];

    for (const session of sessions) {
      const outcome = await cleanupSession(session, options);
      if (options.close && outcome.ok) untrackSession(session);
      outcomes.push({ ...outcome, tabId, sessionId: session.sessionId });
    }

    return outcomes;
  });
}

/**
 * Establish a WebSocket connection to the GLKVM HID endpoint.
 *
 * Opens a WebSocket in the GLKVM tab's page context, authenticating
 * with the token from localStorage. The WebSocket is stored on the
 * page's window object for later reuse.
 *
 * @param options - Connection options (tabId required)
 * @returns A session handle for subsequent send/close operations
 * @throws GlkvmTransportError with appropriate error code
 */
export async function connect(options: ConnectOptions): Promise<GlkvmSession> {
  const { tabId, timeout = DEFAULT_CONNECT_TIMEOUT_MS } = options;
  let reconnect: GlkvmReconnectDiagnostics | undefined;

  // --- Reuse existing session if requested ---
  if (options.sessionId) {
    const result = await evaluateInPage(
      tabId,
      buildCheckSessionScript(options.sessionId),
      false,
    );

    if (result.ok && result.readyState === 1 /* WebSocket.OPEN */) {
      const session = {
        sessionId: options.sessionId,
        tabId,
        createdAt: Date.now(),
        reconnect: {
          requestedSessionId: options.sessionId,
          action: "reused" as const,
          readyState: result.readyState,
        },
      };
      trackSession(session);
      return session;
    }
    reconnect = {
      requestedSessionId: options.sessionId,
      action: result.ok ? "closed" : "missing",
      readyState: result.readyState,
      error: result.error,
      errorCode: result.errorCode,
    };
    // Session is gone or not open — fall through to create new one
  }

  // --- Create new session ---
  const sessionId = generateSessionId();
  const result = await evaluateInPage(
    tabId,
    buildConnectScript(sessionId, timeout),
    true, // await the promise
  );

  if (!result.ok) {
    throw new GlkvmTransportError(
      result.errorCode ?? "CONNECTION_FAILED",
      result.error ?? "Failed to establish WebSocket connection",
      reconnect ? { ...reconnect, reconnected: false } : undefined,
    );
  }

  const resolvedReconnect = reconnect
    ? { ...reconnect, reconnected: true, replacementSessionId: sessionId }
    : undefined;
  const session = {
    sessionId,
    tabId,
    createdAt: Date.now(),
    reconnect: resolvedReconnect,
  };
  trackSession(session);
  return session;
}

/**
 * Send HID packets on an established session.
 *
 * Converts Uint8Array packets to JSON number arrays, injects them
 * into the page context, and sends them via the stored WebSocket.
 *
 * @param options - Session and packets to send
 * @throws GlkvmTransportError if the session is invalid or send fails
 */
export async function send(options: SendOptions): Promise<void> {
  const { session, packets } = options;

  if (packets.length === 0) return;

  // Convert Uint8Arrays to plain number arrays for JSON serialization
  const packetArrays = packets.map((p) => Array.from(p));

  const result = await evaluateInPage(
    session.tabId,
    buildSendScript(session.sessionId, packetArrays),
    false,
  );

  if (!result.ok) {
    throw new GlkvmTransportError(
      result.errorCode ?? "PROTOCOL_ERROR",
      result.error ?? "Failed to send HID packets",
    );
  }
}

/**
 * Send text through KVMD's /api/hid/print endpoint in the authenticated page context.
 */
export async function pasteText(options: PasteTextOptions): Promise<void> {
  const { tabId, text, timeout = DEFAULT_PASTE_TIMEOUT_MS } = options;
  const result = await evaluateInPage(
    tabId,
    buildPasteTextScript(text, timeout),
    true,
  );

  if (!result.ok) {
    throw new GlkvmTransportError(
      result.errorCode ?? "PROTOCOL_ERROR",
      result.error ?? "Failed to use GLKVM paste-as-keys endpoint",
    );
  }
}

/**
 * Explicitly release tracked HID keys/buttons and/or clean up page session state.
 *
 * This API is intentionally non-throwing for page-reported cleanup failures so
 * callers can report cleanup failure separately from a primary action failure.
 * CDP/evaluation failures are also returned as cleanup outcomes.
 */
export async function cleanupSession(
  session: GlkvmSession,
  options: CleanupOptions = {},
): Promise<CleanupOutcome> {
  try {
    const result = await evaluateInPage(
      session.tabId,
      buildCleanupScript(session.sessionId, {
        releaseAll: options.releaseAll ?? false,
        close: options.close ?? false,
      }),
      false,
    );

    const outcome = {
      ok: result.ok,
      cleanupFailed: result.cleanupFailed,
      error: result.error,
      errorCode: result.errorCode,
      releasedKeys: result.releasedKeys,
      releasedButtons: result.releasedButtons,
    };
    if (options.close && outcome.ok) untrackSession(session);
    return outcome;
  } catch (err) {
    return {
      ok: false,
      cleanupFailed: true,
      error: err instanceof Error ? err.message : String(err),
      errorCode: err instanceof GlkvmTransportError ? err.code : "EVAL_ERROR",
    };
  }
}

/** Release all tracked keys/buttons without closing the WebSocket session. */
export async function releaseAll(session: GlkvmSession): Promise<CleanupOutcome> {
  return cleanupSession(session, { releaseAll: true });
}

/**
 * Close a session's WebSocket connection and clean up the page global.
 *
 * Safe to call multiple times or on already-closed sessions.
 *
 * @param session - The session to close
 */
export async function close(session: GlkvmSession): Promise<void> {
  await cleanupSession(session, { releaseAll: true, close: true });
}

/**
 * Check the status of an existing session's WebSocket.
 *
 * @param session - The session to check
 * @returns The WebSocket readyState (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)
 *          or null if the session doesn't exist
 */
export async function getSessionStatus(
  session: GlkvmSession,
): Promise<number | null> {
  try {
    const result = await evaluateInPage(
      session.tabId,
      buildCheckSessionScript(session.sessionId),
      false,
    );
    if (result.ok && result.readyState !== undefined) {
      return result.readyState;
    }
    return null;
  } catch {
    return null;
  }
}
