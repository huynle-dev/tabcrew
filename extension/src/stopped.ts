/**
 * Sessions the user stopped from the popup, kept in chrome.storage.session so the popup can show
 * them as "stopped" until their tab group disappears.
 */

import { STOPPED_KEY, type PopupSessionInfo } from "./config.js";

export class StoppedSessions {
  async list(): Promise<string[]> {
    const stored = (await chrome.storage.session.get(STOPPED_KEY))[STOPPED_KEY];
    return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : [];
  }

  async has(shortId: string): Promise<boolean> {
    return (await this.list()).includes(shortId);
  }

  async add(shortIds: readonly string[]): Promise<void> {
    if (shortIds.length === 0) return;
    const current = await this.list();
    const next = [...new Set([...current, ...shortIds])];
    if (next.length !== current.length) await chrome.storage.session.set({ [STOPPED_KEY]: next });
  }

  /** Mark listed sessions as stopped and forget stopped ids whose group no longer exists. */
  async annotate(sessions: readonly PopupSessionInfo[]): Promise<PopupSessionInfo[]> {
    const stopped = await this.list();
    const live = new Set(sessions.map((s) => s.short_id));
    const kept = stopped.filter((id) => live.has(id));
    if (kept.length !== stopped.length) await chrome.storage.session.set({ [STOPPED_KEY]: kept });
    const set = new Set(kept);
    return sessions.map((s) => ({ ...s, stopped: set.has(s.short_id) }));
  }
}
