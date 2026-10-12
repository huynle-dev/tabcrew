import type { PopupFinishedInfo, PopupSessionInfo } from "../config.js";

export interface SessionRow {
  readonly short_id: string;
  /** `<label> · <short_id>` */
  readonly name: string;
  /** e.g. "2 tabs" or "2 tabs · stopped" */
  readonly meta: string;
  readonly stopped: boolean;
  readonly action: "stop" | "close_tabs" | null;
}

export interface FinishedRow {
  readonly group_id: number;
  /** `✓ <label>` */
  readonly name: string;
  /** e.g. "2 tabs" */
  readonly meta: string;
}

function tabCount(n: number): string {
  return `${n} tab${n === 1 ? "" : "s"}`;
}

export function finishedRows(finished: readonly PopupFinishedInfo[]): FinishedRow[] {
  return finished.map((f) => ({ group_id: f.group_id, name: `✓ ${f.label}`, meta: tabCount(f.tab_count) }));
}

export function sessionRows(sessions: readonly PopupSessionInfo[]): SessionRow[] {
  return sessions.map((s) => {
    const stopped = s.stopped === true;
    const tabs = tabCount(s.tab_count);
    return {
      short_id: s.short_id,
      name: `${s.label} · ${s.short_id}`,
      meta: stopped ? `${tabs} · stopped` : tabs,
      stopped,
      action: stopped ? (s.tab_count > 0 ? "close_tabs" : null) : "stop",
    };
  });
}
