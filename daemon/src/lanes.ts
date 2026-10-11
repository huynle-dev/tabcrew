import { DaemonError } from "./errors.js";
import type { Scheduler } from "./scheduler.js";
import type { Session, SessionRegistry } from "./sessions.js";

export interface LaneContext {
  readonly registry: SessionRegistry;
  readonly scheduler: Scheduler;
}

export function isCode(err: unknown, ...codes: string[]): boolean {
  return err instanceof DaemonError && codes.includes(err.code);
}

/** Queue `fn` on the tab's FIFO lane; ownership and session state are re-checked when it starts. */
export function onTab<T>(ctx: LaneContext, session: Session, tabId: number, fn: () => Promise<T>): Promise<T> {
  const { registry, scheduler } = ctx;
  registry.requireTab(session, tabId);
  return scheduler.runTab(tabId, async () => {
    registry.requireActive(session);
    registry.requireTab(session, tabId);
    try {
      return await fn();
    } catch (err) {
      if (isCode(err, "tab_gone")) registry.removeTab(session.short_id, tabId);
      throw err;
    }
  });
}
