import { V2_EXTENSION_PORT } from "@chromeuse/shared/v2";

/** chrome.storage.local keys (user settings). */
export const TOKEN_KEY = "v2:token";
export const PORT_KEY = "v2:port";

/** chrome.storage.session keys (rebuildable runtime state). */
export const SESSION_WINDOWS_KEY = "v2:sessionWindows";
export const GROUPS_KEY = "v2:groups";
export const TAB_SESSIONS_KEY = "v2:tabSessions";
/** short_ids the user stopped from the popup; pruned once their group is gone. */
export const STOPPED_KEY = "v2:stoppedSessions";

export interface BridgeConfig {
  readonly token: string | null;
  readonly port: number;
}

export function parsePort(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65536 ? n : V2_EXTENSION_PORT;
}

export async function loadConfig(): Promise<BridgeConfig> {
  const stored = await chrome.storage.local.get([TOKEN_KEY, PORT_KEY]);
  const token = typeof stored[TOKEN_KEY] === "string" && stored[TOKEN_KEY].trim() ? stored[TOKEN_KEY].trim() : null;
  return { token, port: parsePort(stored[PORT_KEY]) };
}

/** Status shown in the popup. */
export type BridgeStatus = "connected" | "connecting" | "needs_token" | "unauthorized" | "offline";

/** Messages between the popup and the service worker (chrome.runtime.sendMessage). */
export type PopupRequest =
  | { type: "v2:get_state" }
  | { type: "v2:stop"; short_id: string | null }
  | { type: "v2:close_session_tabs"; short_id: string };

export interface PopupSessionInfo {
  readonly short_id: string;
  readonly label: string;
  readonly tab_count: number;
  /** The user pressed Stop for this session (its tabs stay open until closed). */
  readonly stopped?: boolean;
}

export interface PopupState {
  readonly status: BridgeStatus;
  readonly port: number;
  readonly token_set: boolean;
  readonly sessions: readonly PopupSessionInfo[];
}

export type PopupStopResult = { ok: true } | { ok: false; error: string };
export type PopupCloseResult = { ok: true; closed_tabs: number } | { ok: false; error: string };
