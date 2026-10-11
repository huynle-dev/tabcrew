/**
 * ChromeUse v2 wire protocol between the daemon and extension-v2.
 *
 * Transport: one WebSocket (JSON text frames) from extension-v2 to the daemon at
 * ws://127.0.0.1:{V2_EXTENSION_PORT}. The extension connects out and must send a
 * `hello` with the shared token as its first frame. The daemon owns sessions and
 * policy; the extension only observes and acts on tabs inside a session's group.
 * See docs/plans/2026-10-11-v2-sessions-jev-design.md.
 */

export const V2_PROTOCOL_VERSION = 2;
export const V2_MCP_PORT = 8770;
export const V2_EXTENSION_PORT = 8771;

/** Typed error codes returned to agents (design §4). */
export const V2_ERROR_CODES = [
  "bad_session",
  "tab_not_owned",
  "tab_gone",
  "stale_page",
  "target_covered",
  "target_invalid",
  "stopped_by_user",
  "extension_offline",
  "model_error",
  "outcome_unknown",
  "invalid_args",
  "unauthorized",
  "internal",
] as const;
export type V2ErrorCode = (typeof V2_ERROR_CODES)[number];

export interface V2Error {
  readonly code: V2ErrorCode;
  /** One-line hint for the agent. Never a stack trace. */
  readonly message: string;
}

/** Session identity as the extension sees it. The full handle never leaves the daemon. */
export interface V2SessionRef {
  /** Random 8-char id assigned by the daemon, independent of the secret handle. */
  readonly short_id: string;
  /** Human label shown in the tab group title as `<label> · <short_id>`. */
  readonly label: string;
}

export interface V2TabInfo {
  readonly tab_id: number;
  readonly url: string;
  readonly title: string;
  /** Tab that opened this one (pop-ups / target=_blank), if any. */
  readonly opener_tab_id?: number;
}

// ---------------------------------------------------------------------------
// Operations (daemon -> extension). Each has typed args and result.
// Phase 2 implements: tab_create, tab_list, tab_close, session_close, screenshot.
// Later phases add: snapshot, act, navigate, read_text, debug_logs.
// ---------------------------------------------------------------------------

export interface V2OpMap {
  tab_create: { args: { url?: string }; result: V2TabInfo };
  tab_list: { args: Record<string, never>; result: { tabs: V2TabInfo[] } };
  tab_close: { args: { tab_id: number }; result: { closed: true } };
  /** Close every tab in the session's group and forget the group. */
  session_close: { args: Record<string, never>; result: { closed_tabs: number } };
  screenshot: {
    args: { tab_id: number; format?: "jpeg" | "png"; quality?: number };
    result: { media_type: "image/jpeg" | "image/png"; data: string; width: number; height: number };
  };
  snapshot: { args: { tab_id: number }; result: unknown };
  act: { args: { tab_id: number; fingerprint: string; [k: string]: unknown }; result: unknown };
  navigate: {
    args: { tab_id: number; url?: string; action?: "url" | "back" | "forward" | "reload" };
    result: V2TabInfo;
  };
  read_text: { args: { tab_id: number; max_length?: number }; result: { text: string; url: string; title: string } };
  debug_logs: { args: { tab_id: number; source: "console" | "network"; limit?: number }; result: unknown };
}
export type V2Op = keyof V2OpMap;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** extension -> daemon, first frame. */
export interface V2Hello {
  readonly type: "hello";
  readonly protocol: typeof V2_PROTOCOL_VERSION;
  readonly token: string;
  readonly extension_version: string;
}

/** daemon -> extension after a valid hello. Invalid hello closes with code 4401. */
export interface V2Welcome {
  readonly type: "welcome";
  readonly protocol: typeof V2_PROTOCOL_VERSION;
  /** Sessions the daemon knows, so the extension can reconcile its tab groups. */
  readonly sessions: readonly V2SessionRef[];
}

/** daemon -> extension */
export interface V2Request<K extends V2Op = V2Op> {
  readonly type: "request";
  readonly id: string;
  readonly op: K;
  readonly session: V2SessionRef;
  readonly args: V2OpMap[K]["args"];
}

/** extension -> daemon */
export type V2Response<K extends V2Op = V2Op> =
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly result: V2OpMap[K]["result"] }
  | { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: V2Error };

/** extension -> daemon, unsolicited. */
export type V2Event =
  /** Sent right after welcome: the session groups that exist in the browser. */
  | { readonly type: "event"; readonly event: "groups"; readonly groups: readonly { readonly short_id: string; readonly tabs: readonly V2TabInfo[] }[] }
  /** A tab opened by an owned tab joined that tab's session group. */
  | { readonly type: "event"; readonly event: "tab_adopted"; readonly short_id: string; readonly tab: V2TabInfo }
  /** A session tab was closed (by the user or the page). */
  | { readonly type: "event"; readonly event: "tab_removed"; readonly short_id: string; readonly tab_id: number }
  /** The user pressed Stop for one session, or for all (short_id null). */
  | { readonly type: "event"; readonly event: "stop"; readonly short_id: string | null };

export interface V2Ping {
  readonly type: "ping";
  readonly t: number;
}
export interface V2Pong {
  readonly type: "pong";
  readonly t: number;
}

export type V2ExtensionFrame = V2Hello | V2Response | V2Event | V2Pong;
export type V2DaemonFrame = V2Welcome | V2Request | V2Ping;

export function v2GroupTitle(session: V2SessionRef): string {
  return `${session.label} · ${session.short_id}`;
}

/** Parse `<label> · <short_id>`; returns null for groups that are not v2 session groups. */
export function v2ParseGroupTitle(title: string): V2SessionRef | null {
  const m = /^(.*) · ([A-Za-z0-9_-]{8})$/.exec(title);
  return m ? { label: m[1], short_id: m[2] } : null;
}
