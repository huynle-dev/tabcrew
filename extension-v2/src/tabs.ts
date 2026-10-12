/**
 * Sessions → one never-focused window per session, holding that session's tab group.
 *
 * - Chrome throttles every tab that is not the active tab of its window (even with focus
 *   emulation), so each session gets its own normal window created with `focused: false`
 *   (never minimized: minimized windows are throttled too). Sessions never share a window.
 * - Each session maps to one tab group titled `v2GroupTitle(session)`, created lazily on the
 *   first `tab_create` together with the window. `short_id → windowId` and `short_id → group`
 *   are persisted in chrome.storage.session and can always be rebuilt by scanning group titles
 *   (the group's window is the session's window). A closed window is recreated on demand.
 * - Page-driving ops call `activate` so the target tab becomes the active tab of its own
 *   (unfocused) window. No window is ever focused; windows not created for a session are
 *   never touched.
 * - Every tab-scoped op goes through `assertOwned` (independent of the daemon's own check).
 */

import {
  v2GroupTitle,
  v2ParseGroupTitle,
  type V2Event,
  type V2SessionRef,
  type V2TabInfo,
} from "@chromeuse/shared/v2";
import { GROUPS_KEY, SESSION_WINDOWS_KEY, TAB_SESSIONS_KEY, type PopupSessionInfo } from "./config.js";
import { OpError } from "./errors.js";

const NO_GROUP = -1;
const BLANK_URL = "about:blank";

interface GroupEntry {
  groupId: number;
  label: string;
}

interface State {
  /** short_id → id of the window created for that session. */
  sessionWindows: Record<string, number>;
  groups: Record<string, GroupEntry>;
  /** tabId → short_id, so onRemoved (when the tab can no longer be queried) knows the owner. */
  tabSessions: Record<string, string>;
}

export type GroupsPayload = Extract<V2Event, { event: "groups" }>["groups"];

export function toTabInfo(tab: chrome.tabs.Tab): V2TabInfo {
  const info: { tab_id: number; url: string; title: string; opener_tab_id?: number } = {
    tab_id: tab.id ?? -1,
    url: tab.url || tab.pendingUrl || "",
    title: tab.title ?? "",
  };
  if (typeof tab.openerTabId === "number") info.opener_tab_id = tab.openerTabId;
  return info;
}

/** Runs async tasks one at a time per key. */
class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export class TabManager {
  private state: State | null = null;
  private loading: Promise<State> | null = null;
  private readonly locks = new KeyedLock();
  /** Tabs we are closing on the daemon's behalf: no `tab_removed` echo for these. */
  private readonly expectedRemovals = new Set<number>();

  constructor(private readonly emit: (event: V2Event) => void) {}

  // ---------------------------------------------------------------------------
  // Ops
  // ---------------------------------------------------------------------------

  tabCreate(session: V2SessionRef, args: { url?: unknown }): Promise<V2TabInfo> {
    if (args.url !== undefined && typeof args.url !== "string") {
      throw new OpError("invalid_args", "url must be a string");
    }
    const url = (args.url as string | undefined) || BLANK_URL;
    return this.locks.run(`session:${session.short_id}`, async () => {
      const { windowId, firstTab } = await this.ensureSessionWindow(session.short_id, url);
      const created = firstTab ?? (await chrome.tabs.create({ windowId, url, active: false }));
      const tabId = created.id;
      if (typeof tabId !== "number") throw new OpError("internal", "Chrome did not return a tab id");
      try {
        await this.addToSessionGroup(session, tabId, windowId);
      } catch (err) {
        await chrome.tabs.remove(tabId).catch(() => undefined);
        throw err;
      }
      const tab = await chrome.tabs.get(tabId);
      return toTabInfo(tab);
    });
  }

  async tabList(session: V2SessionRef): Promise<{ tabs: V2TabInfo[] }> {
    const groupId = await this.resolveGroup(session.short_id);
    if (groupId === null) return { tabs: [] };
    const tabs = await chrome.tabs.query({ groupId });
    const state = await this.load();
    for (const t of tabs) if (typeof t.id === "number") state.tabSessions[t.id] = session.short_id;
    await this.save();
    return { tabs: tabs.map(toTabInfo) };
  }

  tabClose(session: V2SessionRef, args: { tab_id?: unknown }): Promise<{ closed: true }> {
    const tabId = requireTabId(args);
    return this.locks.run(`session:${session.short_id}`, async () => {
      await this.assertOwned(session, tabId);
      this.expectedRemovals.add(tabId);
      try {
        await chrome.tabs.remove(tabId);
      } catch (err) {
        this.expectedRemovals.delete(tabId);
        throw err;
      }
      const state = await this.load();
      delete state.tabSessions[tabId];
      await this.save();
      return { closed: true as const };
    });
  }

  sessionClose(session: V2SessionRef): Promise<{ closed_tabs: number }> {
    return this.locks.run(`session:${session.short_id}`, async () => {
      const groupId = await this.resolveGroup(session.short_id);
      const state = await this.load();
      let closed = 0;
      if (groupId !== null) {
        const tabIds = (await chrome.tabs.query({ groupId }))
          .map((t) => t.id)
          .filter((id): id is number => typeof id === "number");
        for (const id of tabIds) this.expectedRemovals.add(id);
        if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
        closed = tabIds.length;
      }
      delete state.groups[session.short_id];
      delete state.sessionWindows[session.short_id];
      for (const [tabId, owner] of Object.entries(state.tabSessions)) {
        if (owner === session.short_id) delete state.tabSessions[tabId];
      }
      await this.save();
      return { closed_tabs: closed };
    });
  }

  /**
   * User action from the popup: close every tab of one session's group(s). Unlike sessionClose
   * this is not on the daemon's behalf, so each closed tab is reported as `tab_removed`.
   */
  closeSessionTabsLocally(shortId: string): Promise<{ closed_tabs: number }> {
    return this.locks.run(`session:${shortId}`, async () => {
      const entry = (await this.scanGroups()).get(shortId);
      if (!entry) return { closed_tabs: 0 };
      const tabIds: number[] = [];
      for (const groupId of entry.groupIds) {
        for (const t of await chrome.tabs.query({ groupId })) if (typeof t.id === "number") tabIds.push(t.id);
      }
      const state = await this.load();
      for (const id of tabIds) state.tabSessions[id] ??= shortId;
      await this.save();
      if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
      return { closed_tabs: tabIds.length };
    });
  }

  /** Ownership check for every tab-scoped op. Returns the live tab. */
  async assertOwned(session: V2SessionRef, tabId: number): Promise<chrome.tabs.Tab> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new OpError("tab_gone", `tab ${tabId} no longer exists`);
    }
    const groupId = await this.resolveGroup(session.short_id);
    if (groupId === null || tab.groupId !== groupId) {
      throw new OpError("tab_not_owned", `tab ${tabId} is not in this session's tab group`);
    }
    const state = await this.load();
    if (state.tabSessions[tabId] !== session.short_id) {
      state.tabSessions[tabId] = session.short_id;
      await this.save();
    }
    return tab;
  }

  /**
   * Make an owned tab the active tab of its (unfocused) session window so Chrome does not
   * throttle it. Switches tabs within that window only; never focuses the window.
   */
  async activate(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.active || typeof tab.id !== "number") return;
    await chrome.tabs.update(tab.id, { active: true });
  }

  /** Ownership check plus activation, for ops that read or drive the page. */
  async prepareForPage(session: V2SessionRef, tabId: number): Promise<chrome.tabs.Tab> {
    const tab = await this.assertOwned(session, tabId);
    await this.activate(tab);
    return tab;
  }

  // ---------------------------------------------------------------------------
  // Reconcile + popup
  // ---------------------------------------------------------------------------

  /** Rebuild the map from group titles (dropping stale entries) and return the `groups` payload. */
  async reconcile(): Promise<GroupsPayload> {
    const state = await this.load();
    const scanned = await this.scanGroups();
    state.groups = {};
    state.sessionWindows = {};
    state.tabSessions = {};
    const payload: { short_id: string; tabs: V2TabInfo[] }[] = [];
    for (const [shortId, entry] of scanned) {
      state.groups[shortId] = { groupId: entry.groupIds[0], label: entry.label };
      state.sessionWindows[shortId] = entry.windowId;
      const tabs: V2TabInfo[] = [];
      for (const groupId of entry.groupIds) {
        for (const tab of await chrome.tabs.query({ groupId })) {
          if (typeof tab.id !== "number") continue;
          state.tabSessions[tab.id] = shortId;
          tabs.push(toTabInfo(tab));
        }
      }
      payload.push({ short_id: shortId, tabs });
    }
    await this.save();
    return payload;
  }

  async listSessionGroups(): Promise<PopupSessionInfo[]> {
    const scanned = await this.scanGroups();
    const out: PopupSessionInfo[] = [];
    for (const [shortId, entry] of scanned) {
      let count = 0;
      for (const groupId of entry.groupIds) count += (await chrome.tabs.query({ groupId })).length;
      out.push({ short_id: shortId, label: entry.label, tab_count: count });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Chrome events
  // ---------------------------------------------------------------------------

  /**
   * A tab opened by an owned tab (pop-up, target=_blank) is moved into the opener's session
   * window and joins its group.
   */
  async handleTabCreated(tab: chrome.tabs.Tab): Promise<void> {
    const tabId = tab.id;
    if (typeof tabId !== "number" || typeof tab.openerTabId !== "number") return;
    let opener: chrome.tabs.Tab;
    try {
      opener = await chrome.tabs.get(tab.openerTabId);
    } catch {
      return;
    }
    if (typeof opener.groupId !== "number" || opener.groupId === NO_GROUP) return;
    let group: chrome.tabGroups.TabGroup;
    try {
      group = await chrome.tabGroups.get(opener.groupId);
    } catch {
      return;
    }
    const parsed = v2ParseGroupTitle(group.title ?? "");
    if (!parsed) return;
    const shortId = parsed.short_id;

    await this.locks.run(`session:${shortId}`, async () => {
      let current: chrome.tabs.Tab;
      try {
        current = await chrome.tabs.get(tabId);
      } catch {
        return;
      }
      if (current.groupId !== group.id) {
        if (current.windowId !== group.windowId) {
          const win = await chrome.windows.get(current.windowId).catch(() => null);
          if (!win || win.type !== "normal") {
            // Chrome cannot move tabs out of popup/app windows, so they cannot join the group.
            console.warn(`[v2 tabs] cannot adopt tab ${tabId} from a ${win?.type ?? "missing"} window`);
            return;
          }
          await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
        }
        await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
        current = await chrome.tabs.get(tabId);
      }
      const state = await this.load();
      state.groups[shortId] = { groupId: group.id, label: parsed.label };
      state.sessionWindows[shortId] = group.windowId;
      state.tabSessions[tabId] = shortId;
      await this.save();
      const info = toTabInfo(current);
      this.emit({
        type: "event",
        event: "tab_adopted",
        short_id: shortId,
        tab: info.opener_tab_id === undefined ? { ...info, opener_tab_id: opener.id } : info,
      });
    });
  }

  async handleTabRemoved(tabId: number): Promise<void> {
    const state = await this.load();
    const shortId = state.tabSessions[tabId];
    const expected = this.expectedRemovals.delete(tabId);
    if (shortId === undefined) return;
    delete state.tabSessions[tabId];
    await this.save();
    if (!expected) this.emit({ type: "event", event: "tab_removed", short_id: shortId, tab_id: tabId });
  }

  async handleWindowRemoved(windowId: number): Promise<void> {
    const state = await this.load();
    let changed = false;
    for (const [shortId, id] of Object.entries(state.sessionWindows)) {
      if (id === windowId) {
        delete state.sessionWindows[shortId];
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Return the session's window, creating it unfocused if needed. Callers hold the session
   * lock, so concurrent tab_creates in one session create one window. The window's group
   * is authoritative when it exists (rebuilds a stale mapping). A brand-new window comes
   * with one tab; we open it directly at `url` and hand it back as `firstTab` so the caller
   * uses it instead of leaving a blank tab behind. When a session's last tab closes, Chrome
   * closes the window and the next tab_create recreates it.
   */
  private async ensureSessionWindow(
    shortId: string,
    url: string,
  ): Promise<{ windowId: number; firstTab?: chrome.tabs.Tab }> {
    const state = await this.load();
    const groupId = await this.resolveGroup(shortId);
    if (groupId !== null) {
      const group = await chrome.tabGroups.get(groupId).catch(() => null);
      if (group && (await isNormalWindow(group.windowId))) {
        if (state.sessionWindows[shortId] !== group.windowId) {
          state.sessionWindows[shortId] = group.windowId;
          await this.save();
        }
        return { windowId: group.windowId };
      }
    }
    const stored = state.sessionWindows[shortId];
    if (stored !== undefined) {
      const sharedWith = Object.entries(state.sessionWindows).some(([other, id]) => other !== shortId && id === stored);
      if (!sharedWith && (await isNormalWindow(stored))) return { windowId: stored };
      delete state.sessionWindows[shortId];
    }
    const win = await chrome.windows.create({ url, focused: false, state: "normal", type: "normal" });
    if (!win || typeof win.id !== "number") throw new OpError("internal", "could not create the session window");
    state.sessionWindows[shortId] = win.id;
    await this.save();
    const firstTab = win.tabs?.[0];
    return firstTab ? { windowId: win.id, firstTab } : { windowId: win.id };
  }

  private async addToSessionGroup(session: V2SessionRef, tabId: number, windowId: number): Promise<void> {
    const state = await this.load();
    const existing = await this.resolveGroup(session.short_id);
    if (existing !== null) {
      await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: v2GroupTitle(session), collapsed: false });
      state.groups[session.short_id] = { groupId, label: session.label };
    }
    state.tabSessions[tabId] = session.short_id;
    await this.save();
  }

  /** Group id for a session, verifying the persisted mapping and falling back to a title scan. */
  private async resolveGroup(shortId: string): Promise<number | null> {
    const state = await this.load();
    const entry = state.groups[shortId];
    if (entry) {
      const group = await chrome.tabGroups.get(entry.groupId).catch(() => null);
      if (group && v2ParseGroupTitle(group.title ?? "")?.short_id === shortId) return group.id;
      delete state.groups[shortId];
    }
    const found = (await this.scanGroups()).get(shortId);
    if (found) {
      state.groups[shortId] = { groupId: found.groupIds[0], label: found.label };
      state.sessionWindows[shortId] = found.windowId;
    }
    await this.save();
    return found ? found.groupIds[0] : null;
  }

  /** Session groups by short_id; `windowId` is the window of the first (primary) group. */
  private async scanGroups(): Promise<Map<string, { label: string; groupIds: number[]; windowId: number }>> {
    const out = new Map<string, { label: string; groupIds: number[]; windowId: number }>();
    for (const group of await chrome.tabGroups.query({})) {
      const parsed = v2ParseGroupTitle(group.title ?? "");
      if (!parsed) continue;
      const entry = out.get(parsed.short_id);
      if (entry) entry.groupIds.push(group.id);
      else out.set(parsed.short_id, { label: parsed.label, groupIds: [group.id], windowId: group.windowId });
    }
    return out;
  }

  private load(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= chrome.storage.session
      .get([SESSION_WINDOWS_KEY, GROUPS_KEY, TAB_SESSIONS_KEY])
      .then((stored) => {
        this.state ??= {
          sessionWindows: isRecord(stored[SESSION_WINDOWS_KEY])
            ? (stored[SESSION_WINDOWS_KEY] as Record<string, number>)
            : {},
          groups: isRecord(stored[GROUPS_KEY]) ? (stored[GROUPS_KEY] as Record<string, GroupEntry>) : {},
          tabSessions: isRecord(stored[TAB_SESSIONS_KEY]) ? (stored[TAB_SESSIONS_KEY] as Record<string, string>) : {},
        };
        return this.state;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async save(): Promise<void> {
    if (!this.state) return;
    await chrome.storage.session.set({
      [SESSION_WINDOWS_KEY]: this.state.sessionWindows,
      [GROUPS_KEY]: this.state.groups,
      [TAB_SESSIONS_KEY]: this.state.tabSessions,
    });
  }
}

export function requireTabId(args: { tab_id?: unknown }): number {
  const id = args?.tab_id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new OpError("invalid_args", "tab_id must be a non-negative integer");
  }
  return id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function isNormalWindow(windowId: number): Promise<boolean> {
  const win = await chrome.windows.get(windowId).catch(() => null);
  return win !== null && win.type === "normal";
}
