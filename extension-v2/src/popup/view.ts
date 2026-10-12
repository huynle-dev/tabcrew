import type { PopupSessionInfo } from "../config.js";

export interface SessionRow {
  readonly short_id: string;
  /** `<label> · <short_id>` */
  readonly name: string;
  /** e.g. "2 tabs" or "2 tabs · stopped" */
  readonly meta: string;
  readonly stopped: boolean;
  readonly action: "stop" | "close_tabs" | null;
}

export function sessionRows(sessions: readonly PopupSessionInfo[]): SessionRow[] {
  return sessions.map((s) => {
    const stopped = s.stopped === true;
    const tabs = `${s.tab_count} tab${s.tab_count === 1 ? "" : "s"}`;
    return {
      short_id: s.short_id,
      name: `${s.label} · ${s.short_id}`,
      meta: stopped ? `${tabs} · stopped` : tabs,
      stopped,
      action: stopped ? (s.tab_count > 0 ? "close_tabs" : null) : "stop",
    };
  });
}
