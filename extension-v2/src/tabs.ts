/**
 * Sessions → tab groups inside one dedicated, never-focused "Agents" window.
 *
 * - The Agents window is a normal window created with `focused: false`. Its id lives in
 *   chrome.storage.session; it is recreated when it was closed. No window is ever focused
 *   and no tab is ever activated by this module; the user's other windows are never touched.
 * - Each session maps to one tab group titled `v2GroupTitle(session)`, created lazily on the
 *   first `tab_create`. The map is persisted in chrome.storage.session and can always be
 *   rebuilt by scanning group titles.
 * - Every tab-scoped op goes through `assertOwned` (independent of the daemon's own check).
 */

import {
  v2GroupTitle,
  v2ParseGroupTitle,
  type V2Event,
  type V2SessionRef,
  type V2TabInfo,
} from "@chromeuse/shared/v2";
import { AGENTS_WINDOW_KEY, GROUPS_KEY, TAB_SESSIONS_KEY, type PopupSessionInfo } from "./config.js";
import { OpError } from "./errors.js";

const NO_GROUP = -1;
const BLANK_URL = "about:blank";

interface GroupEntry {
  groupId: number;
  label: string;
}

interface State {
  agentsWindowId: number | null;
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
      const { windowId, firstTab } = await this.locks.run("agents-window", () => this.ensureAgentsWindow(url));
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
      for (const [tabId, owner] of Object.entries(state.tabSessions)) {
        if (owner === session.short_id) delete state.tabSessions[tabId];
      }
      await this.save();
      return { closed_tabs: closed };
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

  // ---------------------------------------------------------------------------
  // Reconcile + popup
  // ---------------------------------------------------------------------------

  /** Rebuild the map from group titles (dropping stale entries) and return the `groups` payload. */
  async reconcile(): Promise<GroupsPayload> {
    const state = await this.load();
    const scanned = await this.scanGroups();
    state.groups = {};
    state.tabSessions = {};
    const payload: { short_id: string; tabs: V2TabInfo[] }[] = [];
    for (const [shortId, entry] of scanned) {
      state.groups[shortId] = { groupId: entry.groupIds[0], label: entry.label };
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
    if (state.agentsWindowId !== null && !(await windowExists(state.agentsWindowId))) {
      state.agentsWindowId = null;
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

  /** A tab opened by an owned tab (pop-up, target=_blank) joins the opener's session group. */
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
    if (state.agentsWindowId === windowId) {
      state.agentsWindowId = null;
      await this.save();
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Return the Agents window, creating it unfocused if needed. A brand-new window comes
   * with one tab; we open it directly at `url` and hand it back as `firstTab` so the caller
   * uses it instead of leaving a blank tab behind. When a session's last tab closes and the
   * window empties, Chrome closes the window and the next tab_create recreates it.
   */
  private async ensureAgentsWindow(url: string): Promise<{ windowId: number; firstTab?: chrome.tabs.Tab }> {
    const state = await this.load();
    if (state.agentsWindowId !== null) {
      const win = await chrome.windows.get(state.agentsWindowId).catch(() => null);
      if (win && win.type === "normal") return { windowId: state.agentsWindowId };
    }
    const win = await chrome.windows.create({ url, focused: false, state: "normal", type: "normal" });
    if (!win || typeof win.id !== "number") throw new OpError("internal", "could not create the Agents window");
    state.agentsWindowId = win.id;
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
    if (found) state.groups[shortId] = { groupId: found.groupIds[0], label: found.label };
    await this.save();
    return found ? found.groupIds[0] : null;
  }

  private async scanGroups(): Promise<Map<string, { label: string; groupIds: number[] }>> {
    const out = new Map<string, { label: string; groupIds: number[] }>();
    for (const group of await chrome.tabGroups.query({})) {
      const parsed = v2ParseGroupTitle(group.title ?? "");
      if (!parsed) continue;
      const entry = out.get(parsed.short_id);
      if (entry) entry.groupIds.push(group.id);
      else out.set(parsed.short_id, { label: parsed.label, groupIds: [group.id] });
    }
    return out;
  }

  private load(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= chrome.storage.session
      .get([AGENTS_WINDOW_KEY, GROUPS_KEY, TAB_SESSIONS_KEY])
      .then((stored) => {
        this.state ??= {
          agentsWindowId: typeof stored[AGENTS_WINDOW_KEY] === "number" ? stored[AGENTS_WINDOW_KEY] : null,
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
      [AGENTS_WINDOW_KEY]: this.state.agentsWindowId,
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

async function windowExists(windowId: number): Promise<boolean> {
  return (await chrome.windows.get(windowId).catch(() => null)) !== null;
}
