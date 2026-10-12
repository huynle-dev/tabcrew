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
 * - A finished session is released (`releaseSession`): its group moves into the user's window,
 *   collapsed and retitled `✓ <label>` (which never parses as a session group), the debugger is
 *   detached and the tabs stop being owned. Released group ids are kept in `ReleasedGroups`.
 * - Placement (user setting `v2:placement`, decided per session at its first `tab_create` and
 *   remembered): the above is `own_window`. With `user_window` the session's group lives,
 *   collapsed, in the user's window (picked like the release destination). Its tabs are created
 *   with `active: false`, never activated, and the user's active tab is restored if Chrome
 *   changed it. That window is still the user's: it never counts as a session window, is never
 *   focused, and is never closed. Release retitles and collapses the group in place.
 */

import {
  v2GroupTitle,
  v2ParseGroupTitle,
  v2ReleasedGroupTitle,
  type V2Event,
  type V2SessionRef,
  type V2TabInfo,
} from "@tabcrew/shared/v2";
import {
  FOCUS_ORDER_KEY,
  GROUPS_KEY,
  PLACEMENTS_KEY,
  SESSION_WINDOWS_KEY,
  TAB_SESSIONS_KEY,
  loadPlacement,
  type Placement,
  type PopupFinishedInfo,
  type PopupSessionInfo,
} from "./config.js";
import { OpError } from "./errors.js";
import { ReleasedGroups } from "./released.js";

const NO_GROUP = -1;
const BLANK_URL = "about:blank";
const FOCUS_ORDER_MAX = 20;
const ACTIVE_HISTORY_MAX = 5;

interface GroupEntry {
  groupId: number;
  label: string;
}

interface ScannedSession {
  label: string;
  groupIds: number[];
  windowId: number;
}

interface State {
  /** short_id → id of the window created for that session (own_window sessions only). */
  sessionWindows: Record<string, number>;
  /** short_id → where the session's tabs live, decided at its first tab_create. */
  placements: Record<string, Placement>;
  groups: Record<string, GroupEntry>;
  /** tabId → short_id, so onRemoved (when the tab can no longer be queried) knows the owner. */
  tabSessions: Record<string, string>;
  /** Window ids in most-recently-focused order (first = latest). */
  focusOrder: number[];
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
  /** windowId → recently activated tab ids (latest first), to undo activations we caused. */
  private readonly activeHistory = new Map<number, number[]>();

  constructor(
    private readonly emit: (event: V2Event) => void,
    readonly released: ReleasedGroups = new ReleasedGroups(),
  ) {}

  // ---------------------------------------------------------------------------
  // Ops
  // ---------------------------------------------------------------------------

  tabCreate(session: V2SessionRef, args: { url?: unknown }): Promise<V2TabInfo> {
    if (args.url !== undefined && typeof args.url !== "string") {
      throw new OpError("invalid_args", "url must be a string");
    }
    const url = (args.url as string | undefined) || BLANK_URL;
    return this.locks.run(`session:${session.short_id}`, async () => {
      const state = await this.load();
      const placement = (await this.placementFor(session.short_id)) ?? (await loadPlacement());
      if (placement === "user_window") {
        const created = await this.createInUserWindow(session, url);
        if (created) return created;
        // No user window to use: this session falls back to its own window.
      }
      state.placements[session.short_id] = "own_window";
      const { windowId, firstTab } = await this.ensureSessionWindow(session.short_id, url);
      const created = firstTab ?? (await chrome.tabs.create({ windowId, url, active: false }));
      const tabId = created.id;
      if (typeof tabId !== "number") throw new OpError("internal", "Chrome did not return a tab id");
      try {
        await this.addToSessionGroup(session, tabId, windowId);
      } catch (err) {
        await closeTabsUngrouped([tabId]).catch(() => undefined);
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
        await this.removeTabs(session.short_id, [tabId]);
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
        await this.removeTabs(session.short_id, tabIds);
        closed = tabIds.length;
      }
      delete state.groups[session.short_id];
      delete state.sessionWindows[session.short_id];
      delete state.placements[session.short_id];
      for (const [tabId, owner] of Object.entries(state.tabSessions)) {
        if (owner === session.short_id) delete state.tabSessions[tabId];
      }
      await this.save();
      return { closed_tabs: closed };
    });
  }

  /**
   * Hand a finished session's tabs to the user (op `session_release`) and forget the session.
   * `releaseTab` detaches the debugger and drops per-tab caches. The group is retitled
   * `✓ <label>`, moved into the user's window (see `pickUserWindow`) and collapsed; the user's
   * active tab is restored if the move changed it, and no window is ever focused. If no user
   * window exists the group stays where it is (`moved: false`). An emptied session window is
   * closed by Chrome; a session window that still holds other tabs is left alone.
   * A `user_window` session's group already is in the user's window: it is retitled and
   * collapsed in place, nothing moves (`moved: true`: the tabs are in the user's window).
   */
  releaseSession(
    session: V2SessionRef,
    releaseTab: (tabId: number) => Promise<void>,
  ): Promise<{ kept_tabs: number; moved: boolean }> {
    const shortId = session.short_id;
    return this.locks.run(`session:${shortId}`, async () => {
      const primary = await this.resolveGroup(shortId);
      const scanned = await this.scanGroups();
      const entry = scanned.get(shortId);
      const groupIds = [...new Set([...(primary !== null ? [primary] : []), ...(entry?.groupIds ?? [])])];
      const state = await this.load();
      const label = entry?.label ?? state.groups[shortId]?.label ?? session.label;
      const inUserWindow = (await this.placementFor(shortId)) === "user_window";
      // Windows of any own-window session (this one included) never receive a finished group.
      const sessionWindows = await this.ownSessionWindowIds(scanned);

      const tabIds: number[] = [];
      for (const groupId of groupIds) {
        for (const t of await chrome.tabs.query({ groupId })) if (typeof t.id === "number") tabIds.push(t.id);
      }
      // From here on the tabs are the user's: no ownership, and closing them is never reported.
      for (const id of tabIds) delete state.tabSessions[id];
      for (const [tabId, owner] of Object.entries(state.tabSessions)) {
        if (owner === shortId) delete state.tabSessions[tabId];
      }
      delete state.groups[shortId];
      delete state.sessionWindows[shortId];
      delete state.placements[shortId];
      await this.save();
      if (groupIds.length === 0) return { kept_tabs: 0, moved: false };

      for (const id of tabIds) await releaseTab(id).catch(() => undefined);

      const title = v2ReleasedGroupTitle(label);
      if (inUserWindow) {
        for (const groupId of groupIds) {
          await chrome.tabGroups
            .update(groupId, { title, collapsed: true })
            .catch(() => chrome.tabGroups.update(groupId, { title }).catch(() => undefined));
          await this.released.add(groupId, label);
        }
        return { kept_tabs: tabIds.length, moved: true };
      }
      const dest = await this.pickUserWindow(sessionWindows);
      const previousActive = dest !== null ? await activeTabId(dest) : undefined;
      let moved = dest !== null;
      for (const groupId of groupIds) {
        // Retitle first so nothing (reconcile, adoption) treats the group as a session group again.
        await chrome.tabGroups.update(groupId, { title }).catch(() => undefined);
        let finalId = groupId;
        if (dest !== null) {
          try {
            const g = await chrome.tabGroups.move(groupId, { windowId: dest, index: -1 });
            if (g && typeof g.id === "number") finalId = g.id;
          } catch (err) {
            moved = false;
            console.warn(`[v2 tabs] could not move finished group ${groupId} to window ${dest}:`, err);
          }
        }
        await chrome.tabGroups
          .update(finalId, { title, collapsed: true })
          .catch(() => chrome.tabGroups.update(finalId, { title }).catch(() => undefined));
        await this.released.add(finalId, label);
      }
      if (dest !== null && previousActive !== undefined && (await activeTabId(dest)) !== previousActive) {
        // Switches tabs inside that window only; it does not focus the window.
        await chrome.tabs.update(previousActive, { active: true }).catch(() => undefined);
      }
      return { kept_tabs: tabIds.length, moved };
    });
  }

  /**
   * Where a finished group goes: the last-focused normal window if it is the user's (not
   * incognito, not a session window), else the most recently focused such window, else null.
   */
  private async pickUserWindow(sessionWindows: ReadonlySet<number>): Promise<number | null> {
    const usable = (w: chrome.windows.Window | null | undefined): w is chrome.windows.Window & { id: number } =>
      !!w && typeof w.id === "number" && w.type === "normal" && !w.incognito && !sessionWindows.has(w.id);
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    if (usable(last)) return last.id;
    const candidates: number[] = [];
    for (const w of await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => [])) {
      if (usable(w)) candidates.push(w.id);
    }
    if (candidates.length === 0) return null;
    const order = (await this.load()).focusOrder;
    const rank = (id: number) => {
      const i = order.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates[0];
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
      await this.removeTabs(shortId, tabIds);
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

  /**
   * Ownership check plus activation, for ops that read or drive the page. A `user_window`
   * session's tab is never activated: that would switch the tab the user is looking at.
   */
  async prepareForPage(session: V2SessionRef, tabId: number): Promise<chrome.tabs.Tab> {
    const tab = await this.assertOwned(session, tabId);
    if ((await this.placementFor(session.short_id)) !== "user_window") await this.activate(tab);
    return tab;
  }

  /**
   * The session's remembered placement; rebuilt from its group's window when unknown.
   * Undefined for a session that has no placement and no group.
   */
  async placementFor(shortId: string): Promise<Placement | undefined> {
    const state = await this.load();
    const known = state.placements[shortId];
    if (known) return known;
    const groupId = await this.resolveGroup(shortId);
    if (groupId === null) return undefined;
    if (state.placements[shortId]) return state.placements[shortId];
    const group = await chrome.tabGroups.get(groupId).catch(() => null);
    if (!group) return undefined;
    const placement = await this.inferPlacement(shortId, { groupIds: [groupId], windowId: group.windowId });
    state.placements[shortId] = placement;
    await this.save();
    return placement;
  }

  // ---------------------------------------------------------------------------
  // Reconcile + popup
  // ---------------------------------------------------------------------------

  /** Rebuild the map from group titles (dropping stale entries) and return the `groups` payload. */
  async reconcile(): Promise<GroupsPayload> {
    const state = await this.load();
    const scanned = await this.scanGroups();
    const placements: Record<string, Placement> = {};
    for (const [shortId, entry] of scanned) placements[shortId] = await this.inferPlacement(shortId, entry);
    state.groups = {};
    state.sessionWindows = {};
    state.tabSessions = {};
    // Sessions without a group keep a remembered placement for their next tab_create.
    state.placements = { ...state.placements, ...placements };
    const payload: { short_id: string; tabs: V2TabInfo[] }[] = [];
    for (const [shortId, entry] of scanned) {
      state.groups[shortId] = { groupId: entry.groupIds[0], label: entry.label };
      if (placements[shortId] === "own_window") state.sessionWindows[shortId] = entry.windowId;
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

  /**
   * Popup Show (a user click): bring a session's window to the front. A session in the user's
   * window also gets its group expanded and its first tab activated.
   */
  async showSession(shortId: string): Promise<void> {
    const entry = (await this.scanGroups()).get(shortId);
    if (!entry) throw new OpError("invalid_args", `no tab group for session ${shortId}`);
    if ((await this.placementFor(shortId)) === "user_window") {
      const groupId = entry.groupIds[0];
      await chrome.tabGroups.update(groupId, { collapsed: false });
      const first = (await chrome.tabs.query({ groupId })).sort((a, b) => a.index - b.index)[0];
      if (first && typeof first.id === "number") await chrome.tabs.update(first.id, { active: true });
    }
    await chrome.windows.update(entry.windowId, { focused: true });
  }

  /** Finished (released) groups that still exist, newest first; forgets the ones that are gone. */
  async listFinished(): Promise<PopupFinishedInfo[]> {
    const live = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
    const kept = await this.released.prune(new Set(live.keys()));
    const out: (PopupFinishedInfo & { at: number })[] = [];
    for (const [id, entry] of Object.entries(kept)) {
      const groupId = Number(id);
      const tab_count = (await chrome.tabs.query({ groupId })).length;
      out.push({ group_id: groupId, label: entry.label, tab_count, at: entry.released_at });
    }
    out.sort((a, b) => b.at - a.at);
    return out.map(({ at: _at, ...info }) => info);
  }

  /** Popup Open (a user click): expand a finished group, activate its first tab, focus its window. */
  async openFinished(groupId: number): Promise<void> {
    await this.requireReleased(groupId);
    const group = await chrome.tabGroups.get(groupId);
    await chrome.tabGroups.update(groupId, { collapsed: false });
    const first = (await chrome.tabs.query({ groupId })).sort((a, b) => a.index - b.index)[0];
    if (first && typeof first.id === "number") await chrome.tabs.update(first.id, { active: true });
    await chrome.windows.update(group.windowId, { focused: true });
  }

  /** Popup Close: close a finished group's tabs. */
  async closeFinished(groupId: number): Promise<{ closed_tabs: number }> {
    await this.requireReleased(groupId);
    const ids = (await chrome.tabs.query({ groupId })).map((t) => t.id).filter((id): id is number => typeof id === "number");
    if (ids.length > 0) await closeTabsUngrouped(ids);
    await this.released.remove(groupId);
    return { closed_tabs: ids.length };
  }

  async closeAllFinished(): Promise<{ closed_tabs: number }> {
    let closed = 0;
    for (const f of await this.listFinished()) closed += (await this.closeFinished(f.group_id)).closed_tabs;
    return { closed_tabs: closed };
  }

  private async requireReleased(groupId: unknown): Promise<void> {
    if (typeof groupId !== "number" || !Number.isInteger(groupId) || !(await this.released.has(groupId))) {
      throw new OpError("invalid_args", "not a finished session's group");
    }
    if (!(await chrome.tabGroups.get(groupId).catch(() => null))) {
      await this.released.remove(groupId);
      throw new OpError("invalid_args", "that group no longer exists");
    }
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
    // Tabs opened from a finished (released) group belong to the user.
    if (await this.released.has(opener.groupId)) return;
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
      // The session may have been released while we waited for its lock.
      const fresh = await chrome.tabGroups.get(group.id).catch(() => null);
      if (!fresh || v2ParseGroupTitle(fresh.title ?? "")?.short_id !== shortId) return;
      if (await this.released.has(group.id)) return;
      group = fresh;
      let current: chrome.tabs.Tab;
      try {
        current = await chrome.tabs.get(tabId);
      } catch {
        return;
      }
      const placement = (await this.placementFor(shortId)) ?? "own_window";
      // In the user's window the new tab must not take over the user's view.
      let restore: number | undefined;
      if (placement === "user_window") {
        const active = await activeTabId(group.windowId);
        restore = active !== undefined && active !== tabId ? active : this.previousActive(group.windowId, tabId);
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
      if (placement === "user_window" && restore !== undefined && (await activeTabId(group.windowId)) !== restore) {
        await chrome.tabs.update(restore, { active: true }).catch(() => undefined);
        current = await chrome.tabs.get(tabId).catch(() => current);
      }
      const state = await this.load();
      state.groups[shortId] = { groupId: group.id, label: parsed.label };
      state.placements[shortId] = placement;
      if (placement === "own_window") state.sessionWindows[shortId] = group.windowId;
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

  /** chrome.tabs.onActivated: remember recent active tabs per window (in memory only). */
  handleTabActivated(info: { tabId: number; windowId: number }): void {
    const list = this.activeHistory.get(info.windowId) ?? [];
    this.activeHistory.set(
      info.windowId,
      [info.tabId, ...list.filter((id) => id !== info.tabId)].slice(0, ACTIVE_HISTORY_MAX),
    );
  }

  private previousActive(windowId: number, exclude: number): number | undefined {
    return this.activeHistory.get(windowId)?.find((id) => id !== exclude);
  }

  /** chrome.windows.onFocusChanged: remember focus order (finished groups go to the user's latest window). */
  async handleWindowFocused(windowId: number): Promise<void> {
    if (!Number.isInteger(windowId) || windowId < 0) return;
    const state = await this.load();
    if (state.focusOrder[0] === windowId) return;
    state.focusOrder = [windowId, ...state.focusOrder.filter((id) => id !== windowId)].slice(0, FOCUS_ORDER_MAX);
    await this.save();
  }

  async handleWindowRemoved(windowId: number): Promise<void> {
    const state = await this.load();
    let changed = false;
    this.activeHistory.delete(windowId);
    if (state.focusOrder.includes(windowId)) {
      state.focusOrder = state.focusOrder.filter((id) => id !== windowId);
      changed = true;
    }
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

  /** Adds the tab to the session's group (creating it in `windowId`); returns the group id. */
  private async addToSessionGroup(
    session: V2SessionRef,
    tabId: number,
    windowId: number,
    collapsed = false,
  ): Promise<number> {
    const state = await this.load();
    let groupId = await this.resolveGroup(session.short_id);
    if (groupId !== null) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: v2GroupTitle(session), collapsed });
      state.groups[session.short_id] = { groupId, label: session.label };
    }
    state.tabSessions[tabId] = session.short_id;
    await this.save();
    return groupId;
  }

  /**
   * tab_create for a `user_window` session: a background tab in the user's window, inside the
   * session's collapsed group. Never focuses a window or changes its active tab. Returns null
   * (nothing created) when there is no user window.
   */
  private async createInUserWindow(session: V2SessionRef, url: string): Promise<V2TabInfo | null> {
    const shortId = session.short_id;
    const state = await this.load();
    let windowId: number | null = null;
    let wasCollapsed = true;
    const groupId = await this.resolveGroup(shortId);
    if (groupId !== null) {
      const group = await chrome.tabGroups.get(groupId).catch(() => null);
      if (group && (await isNormalWindow(group.windowId))) {
        windowId = group.windowId;
        wasCollapsed = group.collapsed;
      }
    }
    windowId ??= await this.pickUserWindow(await this.ownSessionWindowIds());
    if (windowId === null) return null;

    const previousActive = await activeTabId(windowId);
    const created = await chrome.tabs.create({ windowId, url, active: false });
    const tabId = created.id;
    if (typeof tabId !== "number") throw new OpError("internal", "Chrome did not return a tab id");
    state.placements[shortId] = "user_window";
    delete state.sessionWindows[shortId];
    try {
      const finalGroup = await this.addToSessionGroup(session, tabId, windowId, true);
      // Adding a tab can expand a collapsed group; keep it as it was.
      if (groupId !== null && wasCollapsed) {
        await chrome.tabGroups.update(finalGroup, { collapsed: true }).catch(() => undefined);
      }
    } catch (err) {
      await closeTabsUngrouped([tabId]).catch(() => undefined);
      throw err;
    } finally {
      if (previousActive !== undefined && (await activeTabId(windowId)) !== previousActive) {
        // Switches tabs inside that window only; it does not focus the window.
        await chrome.tabs.update(previousActive, { active: true }).catch(() => undefined);
      }
    }
    return toTabInfo(await chrome.tabs.get(tabId));
  }

  /** Windows that belong to own-window sessions (never a user's window holding a session group). */
  private async ownSessionWindowIds(scanned?: Map<string, ScannedSession>): Promise<Set<number>> {
    const state = await this.load();
    const ids = new Set<number>(Object.values(state.sessionWindows));
    for (const [shortId, entry] of scanned ?? (await this.scanGroups())) {
      if ((await this.inferPlacement(shortId, entry)) === "own_window") ids.add(entry.windowId);
    }
    return ids;
  }

  /**
   * A session's placement: the remembered one, else own_window if its group is in the window
   * created for it, else user_window if that window holds any tab outside the session's groups.
   */
  private async inferPlacement(shortId: string, entry: { groupIds: number[]; windowId: number }): Promise<Placement> {
    const state = await this.load();
    const known = state.placements[shortId];
    if (known) return known;
    if (state.sessionWindows[shortId] === entry.windowId) return "own_window";
    const inWindow = await chrome.tabs.query({ windowId: entry.windowId }).catch(() => []);
    return inWindow.some((t) => !entry.groupIds.includes(t.groupId)) ? "user_window" : "own_window";
  }

  /**
   * Remove tabs. For a `user_window` session, a window that would be left empty first gets a
   * new tab, so Chrome never closes the user's window.
   */
  private async removeTabs(shortId: string, tabIds: number[]): Promise<void> {
    if (tabIds.length === 0) return;
    if ((await this.placementFor(shortId)) === "user_window") {
      const removing = new Set(tabIds);
      const windowIds = new Set<number>();
      for (const id of tabIds) {
        const tab = await chrome.tabs.get(id).catch(() => null);
        if (tab) windowIds.add(tab.windowId);
      }
      for (const windowId of windowIds) {
        const rest = (await chrome.tabs.query({ windowId })).filter((t) => typeof t.id !== "number" || !removing.has(t.id));
        if (rest.length === 0) await chrome.tabs.create({ windowId, active: false }).catch(() => undefined);
      }
    }
    await closeTabsUngrouped(tabIds);
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
      const placement = await this.inferPlacement(shortId, found);
      state.placements[shortId] = placement;
      if (placement === "own_window") state.sessionWindows[shortId] = found.windowId;
    }
    await this.save();
    return found ? found.groupIds[0] : null;
  }

  /** Session groups by short_id; `windowId` is the window of the first (primary) group. */
  private async scanGroups(): Promise<Map<string, ScannedSession>> {
    const out = new Map<string, ScannedSession>();
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
      .get([SESSION_WINDOWS_KEY, PLACEMENTS_KEY, GROUPS_KEY, TAB_SESSIONS_KEY, FOCUS_ORDER_KEY])
      .then((stored) => {
        this.state ??= {
          sessionWindows: isRecord(stored[SESSION_WINDOWS_KEY])
            ? (stored[SESSION_WINDOWS_KEY] as Record<string, number>)
            : {},
          placements: isRecord(stored[PLACEMENTS_KEY]) ? (stored[PLACEMENTS_KEY] as Record<string, Placement>) : {},
          groups: isRecord(stored[GROUPS_KEY]) ? (stored[GROUPS_KEY] as Record<string, GroupEntry>) : {},
          tabSessions: isRecord(stored[TAB_SESSIONS_KEY]) ? (stored[TAB_SESSIONS_KEY] as Record<string, string>) : {},
          focusOrder: Array.isArray(stored[FOCUS_ORDER_KEY])
            ? (stored[FOCUS_ORDER_KEY] as unknown[]).filter((v): v is number => Number.isInteger(v))
            : [],
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
      [PLACEMENTS_KEY]: this.state.placements,
      [GROUPS_KEY]: this.state.groups,
      [TAB_SESSIONS_KEY]: this.state.tabSessions,
      [FOCUS_ORDER_KEY]: this.state.focusOrder,
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

async function activeTabId(windowId: number): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ windowId, active: true }).catch(() => []);
  return typeof tab?.id === "number" ? tab.id : undefined;
}

async function isNormalWindow(windowId: number): Promise<boolean> {
  const win = await chrome.windows.get(windowId).catch(() => null);
  return win !== null && win.type === "normal";
}

/**
 * Close tabs without leaving a saved tab group behind. Chrome saves (and pins to the bookmarks
 * bar) a group whose tabs are closed while still grouped; ungrouping first lets the group vanish.
 */
export async function closeTabsUngrouped(tabIds: number[]): Promise<void> {
  if (tabIds.length === 0) return;
  await chrome.tabs.ungroup(tabIds).catch(() => undefined);
  await chrome.tabs.remove(tabIds);
}
