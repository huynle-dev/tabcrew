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

  constructor(code: GlkvmTransportErrorCode, message: string) {
    super(message);
    this.name = "GlkvmTransportError";
    this.code = code;
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
}

/** Session state tracked by the transport */
export interface GlkvmSession {
  /** Random session ID used as the window property name in page context */
  readonly sessionId: string;
  /** Tab ID where the WebSocket lives */
  readonly tabId: number;
  /** When the session was created */
  readonly createdAt: number;
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for WebSocket connection in milliseconds */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Prefix for session globals on the GLKVM page window object */
const SESSION_PREFIX = "__oc_kvm_";

/** localStorage keys where GLKVM stores auth tokens */
const TOKEN_KEY_MULTI = "gl-kvm-token-keys";
const TOKEN_KEY_SINGLE = "gl-kvm-token-key";

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
        window[${JSON.stringify(sessionKey)}] = ws;
        return { ok: true, sessionId: ${JSON.stringify(sessionKey)}, readyState: ws.readyState };
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
      const ws = window[${JSON.stringify(sessionKey)}];
      if (!ws) return { ok: false, error: "Session not found", errorCode: "PROTOCOL_ERROR" };
      return { ok: true, sessionId: ${JSON.stringify(sessionKey)}, readyState: ws.readyState };
    })()
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
      const ws = window[${JSON.stringify(sessionKey)}];
      if (!ws) return { ok: false, error: "Session not found. The WebSocket may have been closed.", errorCode: "PROTOCOL_ERROR" };
      if (ws.readyState !== WebSocket.OPEN) {
        return { ok: false, error: "WebSocket is not open (readyState=" + ws.readyState + ")", errorCode: "PROTOCOL_ERROR" };
      }
      try {
        const packets = ${packetsJson};
        for (const arr of packets) {
          ws.send(new Uint8Array(arr).buffer);
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: "Send failed: " + (e && e.message || String(e)), errorCode: "PROTOCOL_ERROR" };
      }
    })()
  `;
}

/**
 * Build JavaScript to close an existing session's WebSocket.
 */
function buildCloseScript(sessionKey: string): string {
  return `
    (() => {
      const ws = window[${JSON.stringify(sessionKey)}];
      if (ws) {
        try { ws.close(); } catch {}
        delete window[${JSON.stringify(sessionKey)}];
      }
      return { ok: true };
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

  // --- Reuse existing session if requested ---
  if (options.sessionId) {
    const result = await evaluateInPage(
      tabId,
      buildCheckSessionScript(options.sessionId),
      false,
    );

    if (result.ok && result.readyState === 1 /* WebSocket.OPEN */) {
      return {
        sessionId: options.sessionId,
        tabId,
        createdAt: Date.now(),
      };
    }
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
    );
  }

  return {
    sessionId,
    tabId,
    createdAt: Date.now(),
  };
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
 * Close a session's WebSocket connection and clean up the page global.
 *
 * Safe to call multiple times or on already-closed sessions.
 *
 * @param session - The session to close
 */
export async function close(session: GlkvmSession): Promise<void> {
  try {
    await evaluateInPage(
      session.tabId,
      buildCloseScript(session.sessionId),
      false,
    );
  } catch {
    // Best-effort cleanup — tab may already be closed
  }
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
