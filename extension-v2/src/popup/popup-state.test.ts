import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Event } from "@chromeuse/shared/v2";
import type { PopupCloseResult, PopupRequest, PopupState, PopupStopResult } from "../config.js";
import { TabManager } from "../tabs.js";
import { createFakeChrome, flush, type FakeChrome, type FakePort } from "../test/fakes.js";
import { sessionRows } from "./view.js";

describe("sessionRows", () => {
  it("shows label · short_id and tab count, Stop for live sessions and Close tabs for stopped ones", () => {
    expect(
      sessionRows([
        { short_id: "aaaa1111", label: "alice", tab_count: 1 },
        { short_id: "bbbb2222", label: "bob", tab_count: 3, stopped: true },
        { short_id: "cccc3333", label: "carol", tab_count: 0, stopped: true },
      ]),
    ).toEqual([
      { short_id: "aaaa1111", name: "alice · aaaa1111", meta: "1 tab", stopped: false, action: "stop" },
      { short_id: "bbbb2222", name: "bob · bbbb2222", meta: "3 tabs · stopped", stopped: true, action: "close_tabs" },
      { short_id: "cccc3333", name: "carol · cccc3333", meta: "0 tabs · stopped", stopped: true, action: null },
    ]);
  });
});

describe("TabManager.closeSessionTabsLocally", () => {
  it("closes every tab of the session and reports each as tab_removed (a user action)", async () => {
    const fake = createFakeChrome();
    fake.install();
    const events: V2Event[] = [];
    const tabs = new TabManager((e) => events.push(e));
    const alice = { short_id: "aaaa1111", label: "alice" };
    const bob = { short_id: "bbbb2222", label: "bob" };
    const a1 = await tabs.tabCreate(alice, {});
    const a2 = await tabs.tabCreate(alice, {});
    const b1 = await tabs.tabCreate(bob, {});
    expect(await tabs.closeSessionTabsLocally(alice.short_id)).toEqual({ closed_tabs: 2 });
    expect(fake.tabs.has(a1.tab_id) || fake.tabs.has(a2.tab_id)).toBe(false);
    expect(fake.tabs.has(b1.tab_id)).toBe(true);
    for (const id of [a1.tab_id, a2.tab_id]) await tabs.handleTabRemoved(id);
    expect(events).toEqual([
      { type: "event", event: "tab_removed", short_id: alice.short_id, tab_id: a1.tab_id },
      { type: "event", event: "tab_removed", short_id: alice.short_id, tab_id: a2.tab_id },
    ]);
    expect(await tabs.closeSessionTabsLocally(alice.short_id)).toEqual({ closed_tabs: 0 });
  });
});

describe("service worker stop state", () => {
  let fake: FakeChrome;
  let port: FakePort;
  const alice = { short_id: "aaaa1111", label: "alice" };
  const bob = { short_id: "bbbb2222", label: "bob" };

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  function message<T>(msg: PopupRequest): Promise<T> {
    return new Promise((resolve) => fake.chrome.runtime.onMessage.fire(msg, {}, (r) => resolve(r as T)));
  }

  async function request(id: string, op: string, session: typeof alice, args: object = {}): Promise<{ ok: boolean; result?: any }> {
    port.postMessage({ type: "request", request: { type: "request", id, op, session, args } });
    await settle();
    const frame = port
      .messages<{ type: string; frame: { id: string; ok: boolean; result?: unknown } }>()
      .find((m) => m.type === "frame" && m.frame.id === id)!.frame;
    return frame;
  }

  const sentEvents = () =>
    port
      .messages<{ type: string; frame: V2Event }>()
      .filter((m) => m.type === "frame" && m.frame.type === "event")
      .map((m) => m.frame);

  beforeEach(async () => {
    fake = createFakeChrome();
    fake.install();
    await fake.chrome.storage.local.set({ "v2:token": "secret-token" });
    vi.resetModules();
    await import("../service-worker.js");
    await settle();
    port = fake.chrome.runtime.connect({ name: "v2-bridge" });
    port.postMessage({ type: "status", status: "connected" });
    await settle();
  });

  it("marks a stopped session in the popup state until its group disappears", async () => {
    const a = await request("r1", "tab_create", alice);
    await request("r2", "tab_create", bob);
    expect((await message<PopupStopResult>({ type: "v2:stop", short_id: alice.short_id })).ok).toBe(true);
    await settle();
    expect(sentEvents()).toContainEqual({ type: "event", event: "stop", short_id: alice.short_id });

    const state = await message<PopupState>({ type: "v2:get_state" });
    expect(state.sessions.map((s) => [s.short_id, s.stopped])).toEqual([
      [alice.short_id, true],
      [bob.short_id, false],
    ]);

    // Closing the stopped session's tabs from the popup is allowed; the group then disappears.
    const closed = await message<PopupCloseResult>({ type: "v2:close_session_tabs", short_id: alice.short_id });
    expect(closed).toEqual({ ok: true, closed_tabs: 1 });
    expect(fake.tabs.has(a.result.tab_id)).toBe(false);
    fake.chrome.tabs.onRemoved.fire(a.result.tab_id);
    await settle();
    expect(sentEvents()).toContainEqual({ type: "event", event: "tab_removed", short_id: alice.short_id, tab_id: a.result.tab_id });

    const after = await message<PopupState>({ type: "v2:get_state" });
    expect(after.sessions.map((s) => s.short_id)).toEqual([bob.short_id]);
    expect((await fake.chrome.storage.session.get("v2:stoppedSessions"))["v2:stoppedSessions"]).toEqual([]);
  });

  it("Stop all marks every listed session stopped", async () => {
    await request("r1", "tab_create", alice);
    await request("r2", "tab_create", bob);
    expect((await message<PopupStopResult>({ type: "v2:stop", short_id: null })).ok).toBe(true);
    const state = await message<PopupState>({ type: "v2:get_state" });
    expect(state.sessions.every((s) => s.stopped)).toBe(true);
    expect(sentEvents()).toContainEqual({ type: "event", event: "stop", short_id: null });
  });

  it("refuses to close tabs of a session that was not stopped", async () => {
    const a = await request("r1", "tab_create", alice);
    const r = await message<PopupCloseResult>({ type: "v2:close_session_tabs", short_id: alice.short_id });
    expect(r.ok).toBe(false);
    expect(fake.tabs.has(a.result.tab_id)).toBe(true);
  });

  it("does not mark a session stopped when the daemon is not connected", async () => {
    await request("r1", "tab_create", alice);
    port.postMessage({ type: "status", status: "offline" });
    await settle();
    const r = await message<PopupStopResult>({ type: "v2:stop", short_id: alice.short_id });
    expect(r.ok).toBe(false);
    const state = await message<PopupState>({ type: "v2:get_state" });
    expect(state.sessions[0]!.stopped).toBe(false);
  });
});
