/**
 * Groups of finished sessions that were handed to the user, kept in chrome.storage.session so the
 * popup can list them under "Finished" and adoption can ignore tabs they open. Entries are pruned
 * once their group no longer exists.
 */

import { RELEASED_KEY } from "./config.js";

export interface ReleasedGroup {
  readonly label: string;
  /** Epoch ms when the session was released. */
  readonly released_at: number;
}

export class ReleasedGroups {
  /** Serialises read-modify-write updates (releases of different sessions may run concurrently). */
  private tail: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: (all: Record<string, ReleasedGroup>) => T | null): Promise<T | null> {
    const run = this.tail.then(async () => {
      const all = await this.all();
      const result = fn(all);
      if (result !== null) await chrome.storage.session.set({ [RELEASED_KEY]: all });
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async all(): Promise<Record<string, ReleasedGroup>> {
    const stored = (await chrome.storage.session.get(RELEASED_KEY))[RELEASED_KEY];
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    const out: Record<string, ReleasedGroup> = {};
    for (const [id, v] of Object.entries(stored as Record<string, unknown>)) {
      const e = v as Partial<ReleasedGroup> | null;
      if (e && typeof e.label === "string" && typeof e.released_at === "number") {
        out[id] = { label: e.label, released_at: e.released_at };
      }
    }
    return out;
  }

  async has(groupId: number): Promise<boolean> {
    return String(groupId) in (await this.all());
  }

  async add(groupId: number, label: string, now = Date.now()): Promise<void> {
    await this.mutate((all) => {
      all[groupId] = { label, released_at: now };
      return true;
    });
  }

  async remove(groupId: number): Promise<void> {
    await this.mutate((all) => {
      if (!(String(groupId) in all)) return null;
      delete all[groupId];
      return true;
    });
  }

  /** Drop entries whose group is gone; returns the remaining entries. */
  async prune(liveGroupIds: ReadonlySet<number>): Promise<Record<string, ReleasedGroup>> {
    let kept: Record<string, ReleasedGroup> = {};
    await this.mutate((all) => {
      let changed = false;
      for (const id of Object.keys(all)) {
        if (!liveGroupIds.has(Number(id))) {
          delete all[id];
          changed = true;
        }
      }
      kept = { ...all };
      return changed ? true : null;
    });
    return kept;
  }
}
