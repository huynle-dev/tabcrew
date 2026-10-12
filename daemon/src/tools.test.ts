import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { V2Request } from "@chromeuse/shared/v2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningDaemon } from "./daemon.js";
import { SessionRegistry } from "./sessions.js";
import { flightsSnapshot } from "./testing/fixtures.js";
import { call, FakeExtension, mcpClient, startTestDaemon, tempHome, until, WireError } from "./testing/helpers.js";

let home: string;
let cleanupHome: () => void;
let daemon: RunningDaemon | null;
const clients: Client[] = [];
const extensions: FakeExtension[] = [];

beforeEach(() => {
  ({ home, cleanup: cleanupHome } = tempHome());
  daemon = null;
});

afterEach(async () => {
  for (const ext of extensions.splice(0)) ext.ws.terminate();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await daemon?.close();
  cleanupHome();
});

async function setup(overrides = {}) {
  daemon = await startTestDaemon(home, overrides);
  const client = await mcpClient(daemon.mcpPort, daemon.token);
  clients.push(client);
  const ext = await FakeExtension.connect(daemon.extensionPort, daemon.token);
  extensions.push(ext);
  return { d: daemon, client, ext };
}

async function openWithTab(client: Client, label = "agent"): Promise<{ S: string; short_id: string; tab: number }> {
  const s = await call(client, "session_open", { label });
  if (!s.ok) throw new Error("open failed");
  const t = await call(client, "tab_create", { session: s.value.session, url: "https://example.com/" });
  if (!t.ok) throw new Error(`tab_create failed: ${JSON.stringify(t.error)}`);
  return { S: s.value.session, short_id: s.value.short_id, tab: t.value.tab_id };
}

/** Make the fake extension hold requests matching `match` until released (FIFO). */
function gate(ext: FakeExtension, match: (req: V2Request) => boolean) {
  const held: { req: V2Request; release: () => void }[] = [];
  ext.handler = (req) => {
    if (!match(req)) return ext.simulate(req);
    return new Promise((resolve, reject) => {
      held.push({
        req,
        release: () => {
          try {
            resolve(ext.simulate(req));
          } catch (err) {
            reject(err);
          }
        },
      });
    });
  };
  return held;
}

const errCode = (r: Awaited<ReturnType<typeof call>>) => (r.ok ? "ok" : r.error.code);
const opsOf = (ext: FakeExtension, op: string) => ext.requests.filter((r) => r.op === op);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("per-tab scheduling", () => {
  it("runs ops on one tab in order while another tab proceeds", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, "A");
    const b = await openWithTab(client, "B");
    const held = gate(ext, (req) => (req.args as { tab_id?: number }).tab_id === a.tab);
    const base = ext.requests.length;

    const first = call(client, "observe", { session: a.S, tab_id: a.tab });
    await ext.waitForRequests(base + 1);
    const second = call(client, "screenshot", { session: a.S, tab_id: a.tab });
    const other = call(client, "observe", { session: b.S, tab_id: b.tab });
    expect((await other).ok).toBe(true); // tab B is not blocked by tab A's slow op
    await sleep(50);
    expect(held.map((h) => h.req.op)).toEqual(["snapshot"]); // tab A's second op has not been sent

    held[0].release();
    expect((await first).ok).toBe(true);
    await until(() => held.length === 2);
    expect(held[1].req.op).toBe("screenshot");
    held[1].release();
    expect((await second).ok).toBe(true);
    const tabAOps = ext.requests.slice(base).filter((r) => (r.args as { tab_id?: number }).tab_id === a.tab);
    expect(tabAOps.map((r) => r.op)).toEqual(["snapshot", "screenshot"]);
  });

  it("serialises tab_create per session but not across sessions", async () => {
    const { client, ext } = await setup();
    const s1 = await call(client, "session_open", { label: "one" });
    const s2 = await call(client, "session_open", { label: "two" });
    if (!s1.ok || !s2.ok) throw new Error("open failed");
    const held = gate(ext, (req) => req.op === "tab_create" && req.session.short_id === s1.value.short_id);

    const c1 = call(client, "tab_create", { session: s1.value.session });
    await until(() => held.length === 1);
    const c2 = call(client, "tab_create", { session: s1.value.session });
    const other = call(client, "tab_create", { session: s2.value.session });
    expect((await other).ok).toBe(true);
    await sleep(50);
    expect(held.length).toBe(1);

    held[0].release();
    expect((await c1).ok).toBe(true);
    await until(() => held.length === 2);
    held[1].release();
    const r2 = await c2;
    expect(r2.ok).toBe(true);
    const list = await call(client, "tab_list", { session: s1.value.session });
    expect(list.ok && list.value.tabs.length).toBe(2);
  });

  it("rejects queued ops with tab_gone when the tab is removed", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    const held = gate(ext, (req) => req.op === "snapshot");
    const running = call(client, "observe", { session: a.S, tab_id: a.tab });
    await until(() => held.length === 1);
    const queued = call(client, "screenshot", { session: a.S, tab_id: a.tab });
    await sleep(30);
    ext.send({ type: "event", event: "tab_removed", short_id: a.short_id, tab_id: a.tab });
    expect(errCode(await queued)).toBe("tab_gone");
    held[0].release();
    await running;
    expect(errCode(await call(client, "screenshot", { session: a.S, tab_id: a.tab }))).toBe("tab_not_owned");
  });
});

describe("observe and act", () => {
  async function observed(fingerprint = "fp-flights-1") {
    const ctx = await setup();
    const a = await openWithTab(ctx.client);
    ctx.ext.snapshots.set(a.tab, flightsSnapshot(fingerprint));
    return { ...ctx, a };
  }

  it("returns the element table and forwards each mapped action", async () => {
    const { client, ext, a } = await observed();
    const obs = await call(client, "observe", { session: a.S, tab_id: a.tab });
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(Object.keys(obs.value).sort()).toEqual(
      ["controls", "elements", "fingerprint", "omitted_actions", "text", "title", "url"].sort(),
    );
    expect(obs.value.elements[0]).toEqual({
      index: 1,
      role: "combobox",
      label: "Where from?",
      value: "Zürich",
      operations: ["TYPE_TEXT", "CLICK"],
    });
    expect(obs.value.elements[2].options.map((o: { index: string }) => o.index)).toEqual(["3:1", "3:2", "3:3"]);
    expect(obs.value.controls.map((c: { operation: string }) => c.operation)).toEqual(["SCROLL_DOWN", "WAIT"]);

    const cases: [Record<string, unknown>, string, string | undefined, unknown][] = [
      [{ operation: "CLICK", target: 1 }, "e2", undefined, { operation: "CLICK", target: "1", label: "Open Where from?" }],
      [{ operation: "TYPE_TEXT", target: "1", text: "Zurich" }, "e1", "Zurich", { operation: "TYPE_TEXT", target: "1", label: "Where from?" }],
      [{ operation: "SELECT", target: "3:2" }, "e5", undefined, { operation: "SELECT", target: "3:2", label: "Sort by → Duration" }],
      [{ operation: "CLICK", target: 4, text: "ignored" }, "e7", undefined, { operation: "CLICK", target: "4", label: "Nonstop only" }],
      [{ operation: "SCROLL_DOWN" }, "scroll_down", undefined, { operation: "SCROLL_DOWN", target: null, label: "Scroll down" }],
      [{ operation: "WAIT" }, "wait", undefined, { operation: "WAIT", target: null, label: "Wait for the page to update" }],
    ];
    for (const [args, actionId, text, executed] of cases) {
      const o = await call(client, "observe", { session: a.S, tab_id: a.tab });
      const fp = o.ok && o.value.fingerprint;
      const r = await call(client, "act", { session: a.S, tab_id: a.tab, fingerprint: fp, ...args });
      expect(r).toEqual({ ok: true, value: { executed, page_changed: true } });
      const sent = opsOf(ext, "act").at(-1)!;
      const expectedArgs: Record<string, unknown> = { tab_id: a.tab, fingerprint: fp, action_id: actionId };
      if (text) expectedArgs.text = text;
      expect(sent.args).toEqual(expectedArgs);
    }
  });

  it("returns stale_page without calling the extension for an unknown or old fingerprint", async () => {
    const { client, ext, a } = await observed();
    expect(errCode(await call(client, "act", { session: a.S, tab_id: a.tab, fingerprint: "fp-flights-1", operation: "WAIT" }))).toBe(
      "stale_page",
    ); // never observed
    await call(client, "observe", { session: a.S, tab_id: a.tab });
    ext.snapshots.set(a.tab, flightsSnapshot("fp-flights-2"));
    await call(client, "observe", { session: a.S, tab_id: a.tab }); // newer observe replaces the cache
    const r = await call(client, "act", { session: a.S, tab_id: a.tab, fingerprint: "fp-flights-1", operation: "WAIT" });
    expect(errCode(r)).toBe("stale_page");
    expect(!r.ok && r.error.message).toMatch(/observe/);
    expect(opsOf(ext, "act")).toHaveLength(0);
  });

  it("invalidates the observation after a successful act", async () => {
    const { client, ext, a } = await observed();
    await call(client, "observe", { session: a.S, tab_id: a.tab });
    const args = { session: a.S, tab_id: a.tab, fingerprint: "fp-flights-1", operation: "CLICK", target: 2 };
    expect((await call(client, "act", args)).ok).toBe(true);
    expect(errCode(await call(client, "act", args))).toBe("stale_page");
    expect(opsOf(ext, "act")).toHaveLength(1);
  });

  it("rejects targets outside the table and bad TYPE_TEXT input before calling the extension", async () => {
    const { client, ext, a } = await observed();
    await call(client, "observe", { session: a.S, tab_id: a.tab });
    const act = (extra: Record<string, unknown>) =>
      call(client, "act", { session: a.S, tab_id: a.tab, fingerprint: "fp-flights-1", ...extra });
    expect(errCode(await act({ operation: "CLICK", target: 42 }))).toBe("target_invalid");
    expect(errCode(await act({ operation: "SELECT", target: "3" }))).toBe("target_invalid");
    expect(errCode(await act({ operation: "TYPE_TEXT", target: 2, text: "x" }))).toBe("target_invalid");
    expect(errCode(await act({ operation: "SCROLL_UP" }))).toBe("target_invalid");
    expect(errCode(await act({ operation: "TYPE_TEXT", target: 1 }))).toBe("invalid_args");
    expect(errCode(await act({ operation: "TYPE_TEXT", target: 1, text: "" }))).toBe("invalid_args");
    expect(errCode(await act({ operation: "TYPE_TEXT", target: 1, text: "x".repeat(2001) }))).toBe("invalid_args");
    expect(errCode(await act({ operation: "EVAL", target: 1 }))).toBe("invalid_args");
    expect(errCode(await act({ operation: "CLICK", target: { x: 1, y: 2 } }))).toBe("invalid_args");
    const hint = await act({ operation: "CLICK", target: 42 });
    expect(!hint.ok && hint.error.message).toContain("valid CLICK targets: 1, 2, 4, 5, 6");
    expect(opsOf(ext, "act")).toHaveLength(0);
    // The observation is still valid after rejected targets.
    expect((await act({ operation: "WAIT" })).ok).toBe(true);
  });

  it("never retries act on an extension error", async () => {
    const { client, ext, a } = await observed();
    await call(client, "observe", { session: a.S, tab_id: a.tab });
    ext.handler = (req) => {
      if (req.op === "act") throw new WireError({ code: "outcome_unknown", message: "input sent, result unknown" });
      return ext.simulate(req);
    };
    const r = await call(client, "act", { session: a.S, tab_id: a.tab, fingerprint: "fp-flights-1", operation: "CLICK", target: 2 });
    expect(errCode(r)).toBe("outcome_unknown");
    await sleep(50);
    expect(opsOf(ext, "act")).toHaveLength(1);
    // The page may have changed: the observation is gone.
    const again = await call(client, "act", { session: a.S, tab_id: a.tab, fingerprint: "fp-flights-1", operation: "WAIT" });
    expect(errCode(again)).toBe("stale_page");
    expect(opsOf(ext, "act")).toHaveLength(1);
  });

  it("keeps the observation when the extension reports target_covered (nothing executed)", async () => {
    const { client, ext, a } = await observed();
    await call(client, "observe", { session: a.S, tab_id: a.tab });
    let first = true;
    ext.handler = (req) => {
      if (req.op === "act" && first) {
        first = false;
        throw new WireError({ code: "target_covered", message: "covered by a dialog" });
      }
      return ext.simulate(req);
    };
    const args = { session: a.S, tab_id: a.tab, fingerprint: "fp-flights-1" };
    expect(errCode(await call(client, "act", { ...args, operation: "CLICK", target: 2 }))).toBe("target_covered");
    expect((await call(client, "act", { ...args, operation: "CLICK", target: 6 })).ok).toBe(true);
    expect(opsOf(ext, "act")).toHaveLength(2);
  });

  it("checks ownership on observe and act", async () => {
    const { client, ext, a } = await observed();
    const b = await openWithTab(client, "B");
    expect(errCode(await call(client, "observe", { session: b.S, tab_id: a.tab }))).toBe("tab_not_owned");
    expect(
      errCode(await call(client, "act", { session: b.S, tab_id: a.tab, fingerprint: "fp-flights-1", operation: "WAIT" })),
    ).toBe("tab_not_owned");
    expect(opsOf(ext, "snapshot")).toHaveLength(0);
  });
});

describe("stop", () => {
  it("makes every call of a stopped session return stopped_by_user and leaves its tabs open", async () => {
    const { d, client, ext } = await setup();
    const a = await openWithTab(client, "A");
    const b = await openWithTab(client, "B");
    const held = gate(ext, (req) => req.op === "snapshot" && req.session.short_id === a.short_id);
    const running = call(client, "observe", { session: a.S, tab_id: a.tab });
    await until(() => held.length === 1);
    const queued = call(client, "screenshot", { session: a.S, tab_id: a.tab });
    await sleep(30);

    ext.send({ type: "event", event: "stop", short_id: a.short_id });
    expect(errCode(await queued)).toBe("stopped_by_user");
    held[0].release();
    await running;
    for (const [name, args] of [
      ["tab_list", { session: a.S }],
      ["observe", { session: a.S, tab_id: a.tab }],
      ["act", { session: a.S, tab_id: a.tab, fingerprint: "x", operation: "WAIT" }],
      ["tab_create", { session: a.S }],
      ["tab_close", { session: a.S, tab_id: a.tab }],
      ["session_close", { session: a.S }],
    ] as const) {
      expect(errCode(await call(client, name, args))).toBe("stopped_by_user");
    }
    expect(opsOf(ext, "tab_close")).toHaveLength(0);
    expect(opsOf(ext, "session_close")).toHaveLength(0);
    expect(opsOf(ext, "session_release")).toHaveLength(0);
    expect(d.registry.getByShortId(a.short_id)?.tabs.has(a.tab)).toBe(true);
    // Other sessions are unaffected; a new session works.
    expect((await call(client, "observe", { session: b.S, tab_id: b.tab })).ok).toBe(true);
    expect((await call(client, "session_open", { label: "fresh" })).ok).toBe(true);
  });

  it("stops all sessions on a null short_id and persists the stop", async () => {
    const { d, client, ext } = await setup();
    const a = await openWithTab(client, "A");
    const b = await openWithTab(client, "B");
    ext.send({ type: "event", event: "stop", short_id: null });
    await until(() => d.registry.list().every((s) => s.stopped));
    expect(errCode(await call(client, "tab_list", { session: a.S }))).toBe("stopped_by_user");
    expect(errCode(await call(client, "tab_list", { session: b.S }))).toBe("stopped_by_user");
    const reg = new SessionRegistry({ file: join(home, "sessions.json"), idleTimeoutMs: 0 });
    reg.load();
    expect(reg.list().every((s) => s.stopped)).toBe(true);
  });

  it("forgets an idle stopped session without closing its tabs", async () => {
    const { d, client, ext } = await setup({ idleTimeoutMs: 400, sweepIntervalMs: 20 });
    const a = await openWithTab(client, "A");
    ext.send({ type: "event", event: "stop", short_id: a.short_id });
    await until(() => d.registry.size === 0);
    await sleep(30);
    expect(opsOf(ext, "session_close")).toHaveLength(0);
    expect(opsOf(ext, "session_release")).toHaveLength(0);
  });
});

describe("persistence and reconcile", () => {
  it("restores ownership after a restart from the groups event and leaves unknown groups alone", async () => {
    let d = await startTestDaemon(home);
    daemon = d;
    let client = await mcpClient(d.mcpPort, d.token);
    let ext = await FakeExtension.connect(d.extensionPort, d.token);
    const a = await openWithTab(client, "A");
    const b = await openWithTab(client, "B");
    ext.ws.terminate();
    await client.close();
    await d.close();

    d = await startTestDaemon(home);
    daemon = d;
    client = await mcpClient(d.mcpPort, d.token);
    clients.push(client);
    ext = await FakeExtension.connect(d.extensionPort, d.token);
    extensions.push(ext);
    expect(ext.welcome?.sessions.map((s) => s.short_id).sort()).toEqual([a.short_id, b.short_id].sort());

    // A's group gained a pop-up (900) while the daemon was down; B's group is gone and B's old
    // tab now sits in a group of a session this daemon does not know.
    const tab = (id: number) => ({ tab_id: id, url: "https://x/", title: "" });
    ext.groups.set(a.short_id, [tab(a.tab), tab(900)]);
    ext.groups.set("Unknown1", [tab(b.tab), tab(901)]);
    ext.send({
      type: "event",
      event: "groups",
      groups: [
        { short_id: a.short_id, tabs: [tab(a.tab), tab(900)] },
        { short_id: "Unknown1", tabs: [tab(b.tab), tab(901)] },
        { short_id: 5, tabs: "junk" },
      ],
    });
    await until(() => d.registry.getByShortId(a.short_id)!.tabs.has(900));
    expect([...d.registry.getByShortId(a.short_id)!.tabs].sort()).toEqual([a.tab, 900].sort());
    expect([...d.registry.getByShortId(b.short_id)!.tabs]).toEqual([]);

    expect((await call(client, "observe", { session: a.S, tab_id: 900 })).ok).toBe(true);
    for (const id of [b.tab, 901]) {
      expect(errCode(await call(client, "screenshot", { session: b.S, tab_id: id }))).toBe("tab_not_owned");
      expect(errCode(await call(client, "screenshot", { session: a.S, tab_id: id }))).toBe("tab_not_owned");
    }
    // An adoption event can never move a tab out of another session.
    ext.send({ type: "event", event: "tab_adopted", short_id: b.short_id, tab: tab(900) });
    await sleep(30);
    expect(d.registry.getByShortId(a.short_id)!.tabs.has(900)).toBe(true);
    expect(d.registry.getByShortId(b.short_id)!.tabs.has(900)).toBe(false);
  });

  it("keeps sessions.json consistent under concurrent open/close/create", async () => {
    const { d, client } = await setup();
    const opened = await Promise.all(Array.from({ length: 12 }, (_, i) => call(client, "session_open", { label: `s${i}` })));
    const handles = opened.map((o) => (o.ok ? o.value.session : ""));
    await Promise.all(
      handles.map((h, i) =>
        i % 3 === 0 ? call(client, "session_close", { session: h }) : call(client, "tab_create", { session: h }),
      ),
    );
    const saved = JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"));
    const live = d.registry.list();
    expect(saved.sessions.map((s: { short_id: string }) => s.short_id).sort()).toEqual(live.map((s) => s.short_id).sort());
    expect(live).toHaveLength(8);
    for (const s of saved.sessions) expect(s.tabs).toHaveLength(1);
  });
});

describe("cleanup when agents are done", () => {
  it("tells agents at connect time to close their session, and that their tabs are handed to the user for review", async () => {
    const { client } = await setup();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/session_close/);
    expect(instructions).toMatch(/review/);
    expect(instructions).toMatch(/tab_close/);
    const tools = await client.listTools();
    const open = tools.tools.find((t) => t.name === "session_open")?.description ?? "";
    const close = tools.tools.find((t) => t.name === "session_close")?.description ?? "";
    expect(open).toMatch(/session_close/);
    expect(open).toMatch(/review/);
    expect(close).toMatch(/hand its tabs to the user for review/);
    expect(close).toMatch(/tab_close/);
    for (const text of [instructions, open, close]) {
      expect(text).not.toMatch(/closes? your tabs|window closes|tabs and window are closed/i);
    }
  });

  it("session_close hands the tabs over (session_release), never closes them, and the handle is dead afterwards", async () => {
    const { client, ext } = await setup();
    const s = await openWithTab(client, "done");
    const r = await call(client, "session_close", { session: s.S });
    expect(r).toEqual({
      ok: true,
      value: { closed: true, kept_tabs: 1, moved: true, note: "Your tabs were handed to the user for review; you no longer control them." },
    });
    expect(opsOf(ext, "session_release").map((q) => q.session.short_id)).toEqual([s.short_id]);
    expect(opsOf(ext, "session_close")).toHaveLength(0);
    expect(opsOf(ext, "tab_close")).toHaveLength(0);
    expect(errCode(await call(client, "tab_list", { session: s.S }))).toBe("bad_session");
    expect(errCode(await call(client, "session_close", { session: s.S }))).toBe("bad_session");
  });

  it("session_close with the extension offline forgets the session and reports the tabs left open", async () => {
    const { d, client, ext } = await setup();
    const s = await openWithTab(client, "offline");
    ext.ws.terminate();
    await until(() => !d.bridge.connected);
    const r = await call(client, "session_close", { session: s.S });
    expect(r).toEqual({ ok: true, value: { closed: true, kept_tabs: 0, tabs_left_open: 1 } });
    expect(errCode(await call(client, "tab_list", { session: s.S }))).toBe("bad_session");
  });

  it("hands over the browser sessions a connection opened when that connection ends, and only those", async () => {
    const { d, client, ext } = await setup();
    const other = await mcpClient(d.mcpPort, d.token);
    clients.push(other);
    const mine = await openWithTab(client, "mine");
    const theirs = await openWithTab(other, "theirs");

    // End the first connection the way a harness does on shutdown (HTTP DELETE of the MCP session).
    await (client.transport as { terminateSession(): Promise<void> }).terminateSession();
    await client.close();

    await until(() => ext.requests.some((r) => r.op === "session_release" && r.session.short_id === mine.short_id));
    expect(ext.requests.some((r) => r.op === "session_release" && r.session.short_id === theirs.short_id)).toBe(false);
    expect(opsOf(ext, "session_close")).toHaveLength(0);
    const still = await call(other, "tab_list", { session: theirs.S });
    expect(still.ok).toBe(true);
    expect(d.registry.size).toBe(1);
  });

  it("does not double-close a session the agent already closed", async () => {
    const { client, ext } = await setup();
    const s = await openWithTab(client, "tidy");
    expect((await call(client, "session_close", { session: s.S })).ok).toBe(true);
    await (client.transport as { terminateSession(): Promise<void> }).terminateSession();
    await client.close();
    await sleep(100);
    expect(opsOf(ext, "session_release")).toHaveLength(1);
    expect(opsOf(ext, "session_close")).toHaveLength(0);
  });

  it("leaves a stopped session's tabs as they are when its connection ends", async () => {
    const { d, client, ext } = await setup();
    const s = await openWithTab(client, "stopped");
    ext.send({ type: "event", event: "stop", short_id: s.short_id });
    await until(() => d.registry.getByShortId(s.short_id)?.stopped === true);
    await (client.transport as { terminateSession(): Promise<void> }).terminateSession();
    await client.close();
    await until(() => d.registry.size === 0);
    await sleep(50);
    expect(opsOf(ext, "session_release")).toHaveLength(0);
    expect(opsOf(ext, "session_close")).toHaveLength(0);
  });
});

describe("cleanup does not fire on daemon shutdown", () => {
  it("keeps sessions open across a daemon restart even though connections close", async () => {
    let d = await startTestDaemon(home);
    daemon = d;
    const client = await mcpClient(d.mcpPort, d.token);
    let ext = await FakeExtension.connect(d.extensionPort, d.token);
    const s = await openWithTab(client, "survivor");
    await d.close();
    expect(ext.requests.some((r) => r.op === "session_close" || r.op === "session_release")).toBe(false);
    ext.ws.terminate();
    d = await startTestDaemon(home);
    daemon = d;
    expect(d.registry.size).toBe(1);
    void s;
  });
});
