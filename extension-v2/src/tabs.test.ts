import { beforeEach, describe, expect, it } from "vitest";
import type { V2Event, V2Request } from "@chromeuse/shared/v2";
import { CdpManager } from "./cdp.js";
import { handleRequest } from "./ops.js";
import { TabManager } from "./tabs.js";
import { createFakeChrome, type FakeChrome } from "./test/fakes.js";

const alice = { short_id: "aaaa1111", label: "alice" };
const bob = { short_id: "bbbb2222", label: "bob" };

let fake: FakeChrome;
let events: V2Event[];
let tabs: TabManager;
let cdp: CdpManager;

function req(session: typeof alice, op: V2Request["op"], args: object = {}): V2Request {
  return { type: "request", id: "x", op, session, args } as V2Request;
}
const call = (session: typeof alice, op: V2Request["op"], args: object = {}) =>
  handleRequest(req(session, op, args), { tabs, cdp });

beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
  events = [];
  tabs = new TabManager((e) => events.push(e));
  cdp = new CdpManager();
});

function expectNoFocusOrActivation() {
  expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  for (const [args] of fake.chrome.windows.create.mock.calls) expect(args.focused).toBe(false);
  for (const [args] of fake.chrome.tabs.create.mock.calls) expect(args.active).toBe(false);
}

describe("tab_create", () => {
  it("creates the Agents window unfocused, reusing its first tab, grouped under the session title", async () => {
    const userWin = fake.addWindow({ focused: true });
    fake.addTab({ windowId: userWin.id, url: "https://user.example", active: true });

    const info = (await call(alice, "tab_create", { url: "https://a.example" })) as { tab_id: number; url: string };
    expect(info.url).toBe("https://a.example");
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.windows.create.mock.calls[0]![0]).toMatchObject({ focused: false, state: "normal", url: "https://a.example" });

    const tab = fake.tabs.get(info.tab_id)!;
    const group = fake.groups.get(tab.groupId)!;
    expect(group.title).toBe("alice · aaaa1111");
    expect(tab.windowId).not.toBe(userWin.id);
    // no leftover blank tab: the window holds exactly the one session tab
    expect([...fake.tabs.values()].filter((t) => t.windowId === tab.windowId)).toHaveLength(1);
    expectNoFocusOrActivation();
  });

  it("adds later tabs with active:false to the same window and group", async () => {
    const first = (await call(alice, "tab_create", { url: "https://a.example/1" })) as { tab_id: number };
    const second = (await call(alice, "tab_create", { url: "https://a.example/2" })) as { tab_id: number };
    const bobTab = (await call(bob, "tab_create", {})) as { tab_id: number };

    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.tabs.create).toHaveBeenCalledTimes(2);
    const t1 = fake.tabs.get(first.tab_id)!;
    const t2 = fake.tabs.get(second.tab_id)!;
    const tb = fake.tabs.get(bobTab.tab_id)!;
    expect(t2.groupId).toBe(t1.groupId);
    expect(t2.windowId).toBe(t1.windowId);
    expect(tb.windowId).toBe(t1.windowId);
    expect(tb.groupId).not.toBe(t1.groupId);
    expect(fake.groups.get(tb.groupId)!.title).toBe("bob · bbbb2222");
    expectNoFocusOrActivation();
  });

  it("recreates the Agents window if it was closed", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await call(alice, "tab_close", { tab_id: a.tab_id });
    expect(fake.windows.size).toBe(0);
    await call(alice, "tab_create", {});
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(2);
    expectNoFocusOrActivation();
  });

  it("concurrent creates from two sessions share one Agents window", async () => {
    await Promise.all([call(alice, "tab_create", {}), call(bob, "tab_create", {})]);
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.windows.size).toBe(1);
    expect(fake.tabs.size).toBe(2);
  });
});

describe("ownership", () => {
  it("rejects a tab from another session's group with tab_not_owned", async () => {
    await call(alice, "tab_create", {});
    const bobTab = (await call(bob, "tab_create", {})) as { tab_id: number };
    await expect(call(alice, "tab_close", { tab_id: bobTab.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(call(alice, "screenshot", { tab_id: bobTab.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(fake.tabs.has(bobTab.tab_id)).toBe(true);
  });

  it("rejects a user tab outside any session group", async () => {
    await call(alice, "tab_create", {});
    const win = fake.addWindow();
    const userTab = fake.addTab({ windowId: win.id });
    await expect(call(alice, "screenshot", { tab_id: userTab.id })).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("rejects a missing tab with tab_gone", async () => {
    await expect(call(alice, "tab_close", { tab_id: 99999 })).rejects.toMatchObject({ code: "tab_gone" });
  });

  it("rejects bad tab ids with invalid_args", async () => {
    await expect(call(alice, "tab_close", { tab_id: "1" })).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("tab_list / tab_close / session_close", () => {
  it("tab_list returns only the session's tabs", async () => {
    const a1 = (await call(alice, "tab_create", { url: "https://a/1" })) as { tab_id: number };
    const a2 = (await call(alice, "tab_create", { url: "https://a/2" })) as { tab_id: number };
    await call(bob, "tab_create", { url: "https://b/1" });
    const listed = (await call(alice, "tab_list")) as { tabs: { tab_id: number; url: string }[] };
    expect(listed.tabs.map((t) => t.tab_id).sort()).toEqual([a1.tab_id, a2.tab_id].sort());
    expect((await call({ short_id: "cccc3333", label: "c" }, "tab_list")) as object).toEqual({ tabs: [] });
  });

  it("session_close closes all session tabs and forgets the group", async () => {
    await call(alice, "tab_create", {});
    await call(alice, "tab_create", {});
    const b = (await call(bob, "tab_create", {})) as { tab_id: number };
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 2 });
    expect([...fake.tabs.keys()]).toEqual([b.tab_id]);
    expect(await call(alice, "tab_list")).toEqual({ tabs: [] });
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 0 });
  });

  it("does not echo tab_removed for tabs closed on the daemon's behalf", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await call(alice, "tab_close", { tab_id: a.tab_id });
    await tabs.handleTabRemoved(a.tab_id);
    expect(events).toEqual([]);
  });
});

describe("events", () => {
  it("adopts a tab opened by an owned tab, moving it into the Agents window group", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    const agentTab = fake.tabs.get(a.tab_id)!;
    const otherWin = fake.addWindow();
    const child = fake.addTab({ windowId: otherWin.id, openerTabId: a.tab_id, url: "https://popup.example" });

    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);

    expect(child.windowId).toBe(agentTab.windowId);
    expect(child.groupId).toBe(agentTab.groupId);
    expect(events).toEqual([
      {
        type: "event",
        event: "tab_adopted",
        short_id: "aaaa1111",
        tab: { tab_id: child.id, url: "https://popup.example", title: "", opener_tab_id: a.tab_id },
      },
    ]);
    // the adopted tab is now owned by alice
    await expect(tabs.assertOwned(alice, child.id)).resolves.toBeTruthy();
    expectNoFocusOrActivation();
  });

  it("ignores tabs opened by user tabs", async () => {
    const win = fake.addWindow();
    const parent = fake.addTab({ windowId: win.id });
    const child = fake.addTab({ windowId: win.id, openerTabId: parent.id });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(events).toEqual([]);
    expect(fake.chrome.tabs.group).not.toHaveBeenCalled();
  });

  it("sends tab_removed when a session tab is closed by the user", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await fake.chrome.tabs.remove(a.tab_id); // user closes it
    await tabs.handleTabRemoved(a.tab_id);
    expect(events).toEqual([{ type: "event", event: "tab_removed", short_id: "aaaa1111", tab_id: a.tab_id }]);
  });

  it("reconcile rebuilds groups from titles and drops stale mappings", async () => {
    const a = (await call(alice, "tab_create", { url: "https://a" })) as { tab_id: number };
    const b = (await call(bob, "tab_create", { url: "https://b" })) as { tab_id: number };
    // Simulate a service-worker restart: a fresh manager with stale persisted state.
    await fake.chrome.storage.session.set({
      "v2:groups": { zzzz9999: { groupId: 424242, label: "gone" } },
      "v2:tabSessions": { "777": "zzzz9999" },
    });
    // A user group that is not a v2 session group is ignored.
    const userWin = fake.addWindow();
    const userTab = fake.addTab({ windowId: userWin.id });
    await fake.chrome.tabs.group({ tabIds: [userTab.id] });

    const fresh = new TabManager((e) => events.push(e));
    const groups = await fresh.reconcile();
    expect(groups).toEqual([
      { short_id: "aaaa1111", tabs: [{ tab_id: a.tab_id, url: "https://a", title: "" }] },
      { short_id: "bbbb2222", tabs: [{ tab_id: b.tab_id, url: "https://b", title: "" }] },
    ]);
    const stored = await fake.chrome.storage.session.get(["v2:groups", "v2:tabSessions"]);
    expect(Object.keys(stored["v2:groups"] as object).sort()).toEqual(["aaaa1111", "bbbb2222"]);
    expect(stored["v2:tabSessions"]).toEqual({ [a.tab_id]: "aaaa1111", [b.tab_id]: "bbbb2222" });
    // ownership still works after the rebuild
    await expect(fresh.assertOwned(alice, a.tab_id)).resolves.toBeTruthy();
    await expect(fresh.assertOwned(alice, b.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
  });
});

describe("screenshot", () => {
  it("attaches once, enables focus emulation and Page, and never activates the tab", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    const shot1 = await call(alice, "screenshot", { tab_id: a.tab_id });
    const shot2 = await call(alice, "screenshot", { tab_id: a.tab_id, format: "png" });
    expect(shot1).toEqual({ media_type: "image/jpeg", data: "SU1BR0U=", width: 1280, height: 720 });
    expect(shot2).toMatchObject({ media_type: "image/png" });

    expect(fake.chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(fake.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: a.tab_id }, "1.3");
    const methods = fake.chrome.debugger.sendCommand.mock.calls.map((c) => [c[1], c[2]]);
    expect(methods.slice(0, 2)).toEqual([
      ["Emulation.setFocusEmulationEnabled", { enabled: true }],
      ["Page.enable", undefined],
    ]);
    expect(methods).toContainEqual(["Page.captureScreenshot", { format: "jpeg", quality: 80 }]);
    expect(methods).toContainEqual(["Page.captureScreenshot", { format: "png" }]);
    expectNoFocusOrActivation();
  });

  it("reattaches after the debugger is detached (e.g. infobar canceled)", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await call(alice, "screenshot", { tab_id: a.tab_id });
    fake.attachedDebuggee.delete(a.tab_id);
    cdp.handleDetach({ tabId: a.tab_id }, "canceled_by_user");
    await call(alice, "screenshot", { tab_id: a.tab_id });
    expect(fake.chrome.debugger.attach).toHaveBeenCalledTimes(2);
  });

  it("concurrent screenshots on one tab attach only once", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await Promise.all([
      call(alice, "screenshot", { tab_id: a.tab_id }),
      call(alice, "screenshot", { tab_id: a.tab_id }),
    ]);
    expect(fake.chrome.debugger.attach).toHaveBeenCalledTimes(1);
  });
});

describe("not-yet ops", () => {
  it.each(["snapshot", "act", "navigate", "read_text", "debug_logs"] as const)("%s → internal", async (op) => {
    await expect(call(alice, op, { tab_id: 1 })).rejects.toMatchObject({
      code: "internal",
      message: "not implemented in this phase",
    });
  });
});

