/**
 * In-memory fakes for the chrome.* APIs this extension uses, plus a fake WebSocket.
 * Just enough behaviour to exercise tab groups, windows, storage and chrome.debugger.
 */

import { vi } from "vitest";
import type { SocketLike } from "../bridge.js";

interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
  url: string;
  title: string;
  active: boolean;
  openerTabId?: number;
  index: number;
}
interface FakeWindow {
  id: number;
  type: "normal" | "popup";
  focused: boolean;
}
interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  collapsed: boolean;
}

function storageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...structuredClone(items) };
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
    _data: () => data,
  };
}

function event<A extends unknown[]>() {
  const listeners: ((...args: A) => void)[] = [];
  return {
    addListener: (fn: (...args: A) => void) => listeners.push(fn),
    removeListener: () => undefined,
    fire: (...args: A) => listeners.forEach((fn) => fn(...args)),
  };
}

export function createFakeChrome() {
  let nextId = 100;
  const windows = new Map<number, FakeWindow>();
  const tabs = new Map<number, FakeTab>();
  const groups = new Map<number, FakeGroup>();
  const attachedDebuggee = new Set<number>();

  const tabOut = (t: FakeTab) => ({ ...t, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, frozen: false });
  const notFound = (what: string, id: number) => new Error(`No ${what} with id: ${id}.`);

  const dropEmpty = () => {
    for (const g of [...groups.values()]) {
      if (![...tabs.values()].some((t) => t.groupId === g.id)) groups.delete(g.id);
    }
    for (const w of [...windows.values()]) {
      if (![...tabs.values()].some((t) => t.windowId === w.id)) windows.delete(w.id);
    }
  };

  const addTab = (props: Partial<FakeTab> & { windowId: number }): FakeTab => {
    const tab: FakeTab = {
      id: nextId++,
      groupId: -1,
      url: "about:blank",
      title: "",
      active: false,
      index: [...tabs.values()].filter((t) => t.windowId === props.windowId).length,
      ...props,
    };
    tabs.set(tab.id, tab);
    return tab;
  };

  const addWindow = (props: Partial<FakeWindow> = {}): FakeWindow => {
    const win: FakeWindow = { id: nextId++, type: "normal", focused: false, ...props };
    windows.set(win.id, win);
    return win;
  };

  const chrome = {
    runtime: { getManifest: () => ({ version: "0.3.0" }) },
    storage: { local: storageArea(), session: storageArea() },
    windows: {
      get: vi.fn(async (id: number) => {
        const w = windows.get(id);
        if (!w) throw notFound("window", id);
        return { ...w };
      }),
      create: vi.fn(async (data: { url?: string; focused?: boolean; type?: "normal" | "popup" }) => {
        const win = addWindow({ type: data.type ?? "normal", focused: data.focused ?? true });
        const tab = addTab({ windowId: win.id, url: data.url ?? "chrome://newtab/", active: true });
        return { ...win, tabs: [tabOut(tab)] };
      }),
      update: vi.fn(async () => ({})),
      onRemoved: event<[number]>(),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw notFound("tab", id);
        return tabOut(t);
      }),
      query: vi.fn(async (q: { groupId?: number }) =>
        [...tabs.values()].filter((t) => q.groupId === undefined || t.groupId === q.groupId).map(tabOut),
      ),
      create: vi.fn(async (props: { windowId: number; url?: string; active?: boolean }) => {
        if (!windows.has(props.windowId)) throw notFound("window", props.windowId);
        return tabOut(addTab({ windowId: props.windowId, url: props.url ?? "chrome://newtab/", active: props.active ?? true }));
      }),
      remove: vi.fn(async (ids: number | number[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          if (!tabs.delete(id)) throw notFound("tab", id);
        }
        dropEmpty();
      }),
      group: vi.fn(async (opts: { groupId?: number; tabIds: number | number[]; createProperties?: { windowId?: number } }) => {
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
        let group: FakeGroup;
        if (opts.groupId !== undefined) {
          const g = groups.get(opts.groupId);
          if (!g) throw notFound("group", opts.groupId);
          group = g;
        } else {
          const first = tabs.get(ids[0]!);
          group = { id: nextId++, windowId: opts.createProperties?.windowId ?? first!.windowId, title: "", collapsed: false };
          groups.set(group.id, group);
        }
        for (const id of ids) {
          const t = tabs.get(id);
          if (!t) throw notFound("tab", id);
          t.groupId = group.id;
          t.windowId = group.windowId;
        }
        dropEmpty();
        return group.id;
      }),
      move: vi.fn(async (id: number, props: { windowId?: number }) => {
        const t = tabs.get(id);
        if (!t) throw notFound("tab", id);
        if (props.windowId !== undefined) t.windowId = props.windowId;
        dropEmpty();
        return tabOut(t);
      }),
      update: vi.fn(async () => ({})),
      onCreated: event<[chrome.tabs.Tab]>(),
      onRemoved: event<[number]>(),
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        const g = groups.get(id);
        if (!g) throw notFound("group", id);
        return { ...g, color: "grey" };
      }),
      query: vi.fn(async () => [...groups.values()].map((g) => ({ ...g, color: "grey" }))),
      update: vi.fn(async (id: number, props: { title?: string; collapsed?: boolean }) => {
        const g = groups.get(id);
        if (!g) throw notFound("group", id);
        Object.assign(g, props);
        return { ...g };
      }),
    },
    debugger: {
      attach: vi.fn(async (target: { tabId: number }) => {
        if (!tabs.has(target.tabId)) throw new Error(`No tab with given id ${target.tabId}.`);
        if (attachedDebuggee.has(target.tabId)) throw new Error("Another debugger is already attached");
        attachedDebuggee.add(target.tabId);
      }),
      sendCommand: vi.fn(async (target: { tabId: number }, method: string, _params?: object) => {
        if (!attachedDebuggee.has(target.tabId)) throw new Error("Debugger is not attached to the tab");
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } };
        if (method === "Page.captureScreenshot") return { data: "SU1BR0U=" };
        return {};
      }),
      onDetach: event<[{ tabId?: number }, string]>(),
    },
    alarms: { create: vi.fn(async () => undefined), onAlarm: event<[{ name: string }]>() },
  };

  return {
    chrome,
    windows,
    tabs,
    groups,
    attachedDebuggee,
    addWindow,
    addTab,
    install() {
      (globalThis as unknown as { chrome: unknown }).chrome = chrome;
    },
  };
}

export type FakeChrome = ReturnType<typeof createFakeChrome>;

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = { code };
    this.readyState = 3;
  }

  // --- test helpers ---
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** Let pending microtasks / promise chains settle. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
