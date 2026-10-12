import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningDaemon } from "./daemon.js";
import { sanitizeLogs, stripUrl } from "./mcp/tools.js";
import { call, FakeExtension, HOLD, mcpClient, startTestDaemon, tempHome, until, WireError } from "./testing/helpers.js";

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

async function openWithTab(client: Client, label = "agent") {
  const s = await call(client, "session_open", { label });
  if (!s.ok) throw new Error("open failed");
  const t = await call(client, "tab_create", { session: s.value.session, url: "https://example.com/" });
  if (!t.ok) throw new Error("tab_create failed");
  return { S: s.value.session as string, short_id: s.value.short_id as string, tab: t.value.tab_id as number };
}

const errCode = (r: Awaited<ReturnType<typeof call>>) => (r.ok ? "ok" : r.error.code);
const opsOf = (ext: FakeExtension, op: string) => ext.requests.filter((r) => r.op === op);

describe("navigate", () => {
  it("opens a URL, goes back, and reloads through the extension", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    const go = await call(client, "navigate", { session: a.S, tab_id: a.tab, url: "https://www.iana.org/help/example-domains" });
    expect(go).toEqual({
      ok: true,
      value: { tab_id: a.tab, url: "https://www.iana.org/help/example-domains", title: "Title of https://www.iana.org/help/example-domains" },
    });
    const back = await call(client, "navigate", { session: a.S, tab_id: a.tab, action: "back" });
    expect(back.ok && back.value.url).toBe("https://example.com/");
    expect((await call(client, "navigate", { session: a.S, tab_id: a.tab, action: "reload" })).ok).toBe(true);
    expect(opsOf(ext, "navigate").map((r) => r.args)).toEqual([
      { tab_id: a.tab, url: "https://www.iana.org/help/example-domains", action: "url" },
      { tab_id: a.tab, action: "back" },
      { tab_id: a.tab, action: "reload" },
    ]);
  });

  it("passes target_invalid through when there is no history entry", async () => {
    const { client } = await setup();
    const a = await openWithTab(client);
    expect(errCode(await call(client, "navigate", { session: a.S, tab_id: a.tab, action: "back" }))).toBe("target_invalid");
  });

  it.each([
    [{ url: "javascript:alert(1)" }],
    [{ url: "file:///etc/passwd" }],
    [{ url: "chrome://settings" }],
    [{ url: "not a url" }],
    [{}],
    [{ url: "https://x.test/", action: "back" }],
    [{ action: "home" }],
    [{ action: "url" }],
  ])("rejects %j with invalid_args without calling the extension", async (extra) => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    expect(errCode(await call(client, "navigate", { session: a.S, tab_id: a.tab, ...extra }))).toBe("invalid_args");
    expect(opsOf(ext, "navigate")).toHaveLength(0);
  });

  it("checks ownership", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, "A");
    const b = await openWithTab(client, "B");
    expect(errCode(await call(client, "navigate", { session: b.S, tab_id: a.tab, action: "reload" }))).toBe("tab_not_owned");
    expect(opsOf(ext, "navigate")).toHaveLength(0);
  });

  it("invalidates the tab's cached observation, so act needs a new observe", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    const obs = await call(client, "observe", { session: a.S, tab_id: a.tab });
    const fingerprint = obs.ok && obs.value.fingerprint;
    expect((await call(client, "navigate", { session: a.S, tab_id: a.tab, action: "reload" })).ok).toBe(true);
    const r = await call(client, "act", { session: a.S, tab_id: a.tab, fingerprint, operation: "WAIT" });
    expect(errCode(r)).toBe("stale_page");
    expect(opsOf(ext, "act")).toHaveLength(0);
  });

  it("invalidates the observation even when navigate fails", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    const obs = await call(client, "observe", { session: a.S, tab_id: a.tab });
    const fingerprint = obs.ok && obs.value.fingerprint;
    ext.handler = (req) => {
      if (req.op === "navigate") throw new WireError({ code: "outcome_unknown", message: "sent, result unknown" });
      return ext.simulate(req);
    };
    expect(errCode(await call(client, "navigate", { session: a.S, tab_id: a.tab, url: "https://b.test/" }))).toBe("outcome_unknown");
    expect(opsOf(ext, "navigate")).toHaveLength(1); // never retried
    expect(errCode(await call(client, "act", { session: a.S, tab_id: a.tab, fingerprint, operation: "WAIT" }))).toBe("stale_page");
  });

  it("is mutating: a disconnect mid-flight is outcome_unknown, not extension_offline", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    ext.handler = (req) => (req.op === "navigate" ? HOLD : ext.simulate(req));
    const pending = call(client, "navigate", { session: a.S, tab_id: a.tab, url: "https://b.test/" });
    await until(() => opsOf(ext, "navigate").length === 1);
    ext.ws.terminate();
    expect(errCode(await pending)).toBe("outcome_unknown");
  });

  it("returns stopped_by_user for a stopped session", async () => {
    const { d, client, ext } = await setup();
    const a = await openWithTab(client);
    ext.send({ type: "event", event: "stop", short_id: a.short_id });
    await until(() => d.registry.getByShortId(a.short_id)?.stopped === true);
    for (const [name, args] of [
      ["navigate", { action: "reload" }],
      ["read_text", {}],
      ["debug_logs", { source: "console" }],
    ] as const) {
      expect(errCode(await call(client, name, { session: a.S, tab_id: a.tab, ...args }))).toBe("stopped_by_user");
    }
    expect(opsOf(ext, "navigate")).toHaveLength(0);
  });
});

describe("read_text", () => {
  it("returns url, title and text, with the default max_length", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    const r = await call(client, "read_text", { session: a.S, tab_id: a.tab });
    expect(r).toEqual({ ok: true, value: { url: "https://example.com/", title: "", text: "Example Domain", truncated: false } });
    expect(opsOf(ext, "read_text")[0].args).toEqual({ tab_id: a.tab, max_length: 20000 });
  });

  it("truncates to max_length and says so", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    ext.pageText.set(a.tab, "abcdefghij".repeat(10));
    const r = await call(client, "read_text", { session: a.S, tab_id: a.tab, max_length: 25 });
    expect(r.ok && r.value).toMatchObject({ text: "abcdefghij".repeat(2) + "abcde", truncated: true });
    // A misbehaving extension cannot exceed max_length either.
    ext.handler = (req) => (req.op === "read_text" ? { text: "x".repeat(100), url: "u", title: "t" } : ext.simulate(req));
    const r2 = await call(client, "read_text", { session: a.S, tab_id: a.tab, max_length: 10 });
    expect(r2.ok && r2.value.text).toBe("x".repeat(10));
  });

  it("validates max_length and ownership", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, "A");
    const b = await openWithTab(client, "B");
    for (const max_length of [0, 100_001, 1.5, "10"]) {
      expect(errCode(await call(client, "read_text", { session: a.S, tab_id: a.tab, max_length }))).toBe("invalid_args");
    }
    expect(errCode(await call(client, "read_text", { session: b.S, tab_id: a.tab }))).toBe("tab_not_owned");
    expect(opsOf(ext, "read_text")).toHaveLength(0);
  });
});

describe("debug_logs", () => {
  const dirty = {
    entries: [
      {
        method: "POST",
        url: "https://api.test/login?token=xyz#frag",
        status: 401,
        type: "Fetch",
        ms: 12,
        t: 5,
        headers: { Authorization: "Bearer s3cret" },
        cookies: "sid=abc123",
        postData: "password=hunter2",
        body: "BODY-CONTENT",
      },
      { method: "GET", url: "data:text/html;base64,BODY-CONTENT", status: 200, type: "Document", ms: null, t: 6 },
    ],
    dropped: 3,
    extra: "ignored",
  };

  it("forwards source/limit/only_errors and re-whitelists entries", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client);
    ext.logs.set(`${a.tab}:network`, dirty);
    const r = await call(client, "debug_logs", { session: a.S, tab_id: a.tab, source: "network", only_errors: true, limit: 10 });
    expect(opsOf(ext, "debug_logs")[0].args).toEqual({ tab_id: a.tab, source: "network", limit: 10, only_errors: true });
    expect(r).toEqual({
      ok: true,
      value: {
        source: "network",
        entries: [
          { method: "POST", url: "https://api.test/login", status: 401, type: "Fetch", ms: 12, t: 5 },
          { method: "GET", url: "data:", status: 200, type: "Document", ms: null, t: 6 },
        ],
        dropped: 3,
      },
    });
    const json = JSON.stringify(r);
    for (const secret of ["s3cret", "abc123", "hunter2", "BODY-CONTENT", "token=", "?", "#frag"]) expect(json).not.toContain(secret);
  });

  it("defaults limit to 50 and validates arguments and ownership", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, "A");
    const b = await openWithTab(client, "B");
    expect((await call(client, "debug_logs", { session: a.S, tab_id: a.tab, source: "console" })).ok).toBe(true);
    expect(opsOf(ext, "debug_logs")[0].args).toEqual({ tab_id: a.tab, source: "console", limit: 50 });
    for (const bad of [{ source: "dom" }, {}, { source: "console", limit: 201 }, { source: "console", limit: 0 }, { source: "console", only_errors: "yes" }]) {
      expect(errCode(await call(client, "debug_logs", { session: a.S, tab_id: a.tab, ...bad }))).toBe("invalid_args");
    }
    expect(errCode(await call(client, "debug_logs", { session: b.S, tab_id: a.tab, source: "console" }))).toBe("tab_not_owned");
    expect(opsOf(ext, "debug_logs")).toHaveLength(1);
  });
});

describe("sanitizeLogs", () => {
  it("keeps only console fields and caps text and limit", () => {
    const out = sanitizeLogs(
      "console",
      {
        entries: [
          { level: "error", text: "x".repeat(900), url: "https://a.test/app.js?k=v", t: 1, args: [{ value: "secret" }], stack: "s" },
          { level: "weird", text: 5, t: "x" },
          { level: "log", text: "newest", t: 3 },
        ],
        dropped: -1,
      },
      2,
    );
    expect(out.dropped).toBe(0);
    expect(out.entries).toEqual([
      { level: "log", text: "", t: 0 },
      { level: "log", text: "newest", t: 3 },
    ]);
    const first = sanitizeLogs("console", { entries: [{ level: "error", text: "x".repeat(900), url: "https://a.test/app.js?k=v", t: 1, stack: "s" }] }, 50);
    expect(first.entries[0]).toEqual({ level: "error", text: "x".repeat(500), url: "https://a.test/app.js", t: 1 });
  });

  it("tolerates garbage", () => {
    expect(sanitizeLogs("network", null, 50)).toEqual({ source: "network", entries: [], dropped: 0 });
    expect(sanitizeLogs("network", { entries: "nope" }, 50).entries).toEqual([]);
    expect(stripUrl("blob:https://a.test/uuid")).toBe("blob:");
    expect(stripUrl("weird?x=1")).toBe("weird");
  });
});
