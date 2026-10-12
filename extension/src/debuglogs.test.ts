import { beforeEach, describe, expect, it } from "vitest";
import type { V2Request } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import { CONSOLE_CAPACITY, DebugLogStore, NETWORK_CAPACITY, sanitizeUrl } from "./debuglogs.js";
import { handleRequest } from "./ops.js";
import { PageController } from "./snapshot/controller.js";
import { TabManager } from "./tabs.js";
import { createFakeChrome, flush, type FakeChrome } from "./test/fakes.js";

const TAB = 5;
const SECRETS = ["Bearer s3cret", "sid=abc123", "password=hunter2", "token=xyz", "BODY-CONTENT", "frag-secret"];

function request(store: DebugLogStore, id: string, url: string, extra: Record<string, unknown> = {}) {
  store.handleEvent(TAB, "Network.requestWillBeSent", {
    requestId: id,
    loaderId: "L1",
    documentURL: url,
    request: {
      url,
      method: "POST",
      headers: { Authorization: "Bearer s3cret", Cookie: "sid=abc123" },
      postData: "password=hunter2",
      hasPostData: true,
      postDataEntries: [{ bytes: "cGFzc3dvcmQ9aHVudGVyMg==" }],
    },
    timestamp: 100,
    wallTime: 1_700_000_000,
    initiator: { type: "script", url: "https://x.test/app.js?token=xyz" },
    type: "XHR",
    ...extra,
  });
}

function respond(store: DebugLogStore, id: string, status: number) {
  store.handleEvent(TAB, "Network.responseReceived", {
    requestId: id,
    type: "XHR",
    timestamp: 100.1,
    response: {
      url: "https://api.test/v1/items?token=xyz",
      status,
      statusText: "OK",
      headers: { "set-cookie": "sid=abc123", "x-secret": "Bearer s3cret" },
      requestHeaders: { Cookie: "sid=abc123" },
      securityDetails: { subjectName: "api.test" },
    },
  });
}

function finish(store: DebugLogStore, id: string, timestamp = 100.25) {
  store.handleEvent(TAB, "Network.loadingFinished", { requestId: id, timestamp, encodedDataLength: 1234 });
}

describe("sanitizeUrl", () => {
  it.each([
    ["https://api.test/v1/items?token=xyz#frag-secret", "https://api.test/v1/items"],
    ["https://user:pass@api.test:8443/a/b?q=1", "https://api.test:8443/a/b"],
    ["data:text/html;base64,BODY-CONTENT", "data:"],
    ["blob:https://x.test/0d8f-uuid", "blob:"],
    ["about:blank?x=1", "about:blank"],
    ["not a url?token=xyz", "not a url"],
    ["", ""],
  ])("%s → %s", (raw, expected) => {
    expect(sanitizeUrl(raw)).toBe(expected);
  });
});

describe("DebugLogStore", () => {
  let store: DebugLogStore;
  beforeEach(() => {
    store = new DebugLogStore(() => 42);
    store.start(TAB);
  });

  it("stores only whitelisted network fields; no headers, cookies, post data, bodies or query strings", () => {
    request(store, "r1", "https://api.test/v1/items?token=xyz#frag-secret");
    respond(store, "r1", 200);
    finish(store, "r1");
    const { entries, dropped } = store.query(TAB, { source: "network" });
    expect(dropped).toBe(0);
    expect(entries).toEqual([
      { method: "POST", url: "https://api.test/v1/items", status: 200, type: "XHR", ms: 250, t: 1_700_000_000_000 },
    ]);
    const json = JSON.stringify(entries);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    for (const e of entries) expect(Object.keys(e).sort()).toEqual(["method", "ms", "status", "t", "type", "url"]);
  });

  it("stores only whitelisted console fields and caps text at 500 chars", () => {
    store.handleEvent(TAB, "Runtime.consoleAPICalled", {
      type: "warning",
      args: [
        { type: "string", value: "hello" },
        { type: "number", value: 3 },
        { type: "object", className: "Object", description: "Object", preview: { properties: [{ name: "cookie", value: "sid=abc123" }] } },
      ],
      executionContextId: 1,
      timestamp: 1234.6,
      stackTrace: { callFrames: [{ url: "https://x.test/app.js?token=xyz", functionName: "f", lineNumber: 1 }] },
    });
    store.handleEvent(TAB, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "x".repeat(2000) }] });
    store.handleEvent(TAB, "Runtime.consoleAPICalled", { type: "assert", args: [] });
    store.handleEvent(TAB, "Runtime.consoleAPICalled", { type: "table", args: [] });
    const { entries } = store.query(TAB, { source: "console" });
    expect(entries[0]).toEqual({ level: "warning", text: "hello 3 Object", url: "https://x.test/app.js", t: 1235 });
    expect((entries[1] as { text: string }).text).toHaveLength(500);
    expect(entries[1]).toMatchObject({ level: "log", t: 42 });
    expect(entries.slice(2).map((e) => (e as { level: string }).level)).toEqual(["error", "log"]);
    expect(JSON.stringify(entries)).not.toContain("sid=abc123");
    for (const e of entries) for (const k of Object.keys(e)) expect(["level", "text", "url", "t"]).toContain(k);
  });

  it("records exceptions with their description and a stripped url", () => {
    store.handleEvent(TAB, "Runtime.exceptionThrown", {
      timestamp: 99,
      exceptionDetails: {
        text: "Uncaught",
        url: "https://x.test/app.js?token=xyz",
        exception: { type: "object", description: "TypeError: boom\n    at f (app.js:1)" },
      },
    });
    const { entries } = store.query(TAB, { source: "console" });
    expect(entries).toEqual([{ level: "exception", text: "TypeError: boom\n    at f (app.js:1)", url: "https://x.test/app.js", t: 99 }]);
  });

  it("evicts the oldest entries and counts them in dropped", () => {
    for (let i = 0; i < NETWORK_CAPACITY + 7; i++) request(store, `r${i}`, `https://x.test/${i}`);
    for (let i = 0; i < CONSOLE_CAPACITY + 3; i++) {
      store.handleEvent(TAB, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `m${i}` }] });
    }
    const net = store.query(TAB, { source: "network", limit: 200 });
    expect(net.dropped).toBe(7);
    expect(net.entries).toHaveLength(200);
    expect((net.entries.at(-1) as { url: string }).url).toBe(`https://x.test/${NETWORK_CAPACITY + 6}`);
    const con = store.query(TAB, { source: "console", limit: 5 });
    expect(con.dropped).toBe(3);
    expect(con.entries.map((e) => (e as { text: string }).text)).toEqual(
      [498, 499, 500, 501, 502].map((i) => `m${i}`),
    );
    // Updates for an evicted request are ignored.
    finish(store, "r0");
    expect(store.query(TAB, { source: "network", limit: 200 }).entries.every((e) => (e as { url: string }).url !== "https://x.test/0")).toBe(true);
  });

  it("returns the newest `limit` entries (default 50, max 200), newest last", () => {
    for (let i = 0; i < 300; i++) request(store, `r${i}`, `https://x.test/${i}`);
    expect(store.query(TAB, { source: "network" }).entries).toHaveLength(50);
    expect(store.query(TAB, { source: "network", limit: 1000 }).entries).toHaveLength(200);
    const last2 = store.query(TAB, { source: "network", limit: 2 }).entries.map((e) => (e as { url: string }).url);
    expect(last2).toEqual(["https://x.test/298", "https://x.test/299"]);
  });

  it("filters only_errors: console error/exception; network status >= 400 or failed", () => {
    for (const type of ["log", "info", "warning", "error", "debug"]) {
      store.handleEvent(TAB, "Runtime.consoleAPICalled", { type, args: [{ type: "string", value: type }] });
    }
    store.handleEvent(TAB, "Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught boom" } });
    expect(store.query(TAB, { source: "console", only_errors: true }).entries.map((e) => (e as { level: string }).level)).toEqual([
      "error",
      "exception",
    ]);

    request(store, "ok", "https://x.test/ok");
    respond(store, "ok", 200);
    request(store, "redir", "https://x.test/r");
    respond(store, "redir", 302);
    request(store, "nf", "https://x.test/nf");
    respond(store, "nf", 404);
    request(store, "boom", "https://x.test/boom");
    respond(store, "boom", 503);
    request(store, "dns", "https://nope.test/");
    store.handleEvent(TAB, "Network.loadingFailed", { requestId: "dns", timestamp: 100.5, errorText: "net::ERR_NAME_NOT_RESOLVED", type: "Fetch" });
    request(store, "pending", "https://x.test/pending");
    const errs = store.query(TAB, { source: "network", only_errors: true }).entries as { url: string; status: number | null; failed?: string; ms: number | null }[];
    expect(errs.map((e) => [e.url, e.status, e.failed])).toEqual([
      ["https://x.test/nf", 404, undefined],
      ["https://x.test/boom", 503, undefined],
      ["https://nope.test/", null, "net::ERR_NAME_NOT_RESOLVED"],
    ]);
    expect(errs[2]!.ms).toBe(500);
  });

  it("closes a redirect hop with its status and starts a new entry", () => {
    request(store, "r1", "https://x.test/old?a=1");
    request(store, "r1", "https://x.test/new?b=2", { timestamp: 100.1, redirectResponse: { status: 301, headers: { Location: "x" } } });
    respond(store, "r1", 200);
    finish(store, "r1", 100.3);
    const { entries } = store.query(TAB, { source: "network" });
    expect(entries).toEqual([
      expect.objectContaining({ url: "https://x.test/old", status: 301, ms: 100 }),
      expect.objectContaining({ url: "https://x.test/new", status: 200, ms: 200 }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("Location");
  });

  it("returned entries are copies", () => {
    request(store, "r1", "https://x.test/a");
    const first = store.query(TAB, { source: "network" }).entries[0] as { status: number | null };
    first.status = 999;
    expect((store.query(TAB, { source: "network" }).entries[0] as { status: number | null }).status).toBeNull();
  });

  it("ignores events for tabs that were never started, and forget clears the buffers", () => {
    store.handleEvent(9, "Runtime.consoleAPICalled", { type: "error", args: [] });
    expect(store.query(9, { source: "console" })).toEqual({ entries: [], dropped: 0 });
    request(store, "r1", "https://x.test/a");
    store.forget(TAB);
    expect(store.query(TAB, { source: "network" })).toEqual({ entries: [], dropped: 0 });
  });

  it("validates arguments", () => {
    expect(() => store.query(TAB, { source: "dom" })).toThrow(expect.objectContaining({ code: "invalid_args" }));
    expect(() => store.query(TAB, { source: "console", limit: 0 })).toThrow(expect.objectContaining({ code: "invalid_args" }));
    expect(() => store.query(TAB, { source: "console", limit: 1.5 })).toThrow(expect.objectContaining({ code: "invalid_args" }));
    expect(() => store.query(TAB, { source: "console", only_errors: "yes" })).toThrow(expect.objectContaining({ code: "invalid_args" }));
  });
});

describe("debug_logs op over CDP", () => {
  const alice = { short_id: "aaaa1111", label: "alice" };
  const bob = { short_id: "bbbb2222", label: "bob" };
  let fake: FakeChrome;
  let tabs: TabManager;
  let cdp: CdpManager;
  let page: PageController;
  const call = (session: typeof alice, op: V2Request["op"], args: object = {}) =>
    handleRequest({ type: "request", id: "x", op, session, args } as V2Request, { tabs, cdp, page });

  beforeEach(() => {
    fake = createFakeChrome();
    fake.install();
    tabs = new TabManager(() => undefined);
    cdp = new CdpManager();
    page = new PageController({ send: (t, m, p) => cdp.send(t, m, p), isMac: async () => true });
  });

  it("enables Runtime and Network for the attached tab only, without post data", async () => {
    const a = (await call(alice, "tab_create")) as { tab_id: number };
    await cdp.ensureAttached(a.tab_id);
    await flush();
    const calls = fake.chrome.debugger.sendCommand.mock.calls.map((c) => [c[0].tabId, c[1], c[2]]);
    expect(calls).toContainEqual([a.tab_id, "Runtime.enable", undefined]);
    expect(calls).toContainEqual([a.tab_id, "Network.enable", { maxPostDataSize: 0 }]);
    expect(calls.map((c) => c[1])).not.toContain("Network.getResponseBody");
    expect(calls.map((c) => c[1])).not.toContain("Network.setExtraHTTPHeaders");
  });

  it("does not fail the attach when the log domains cannot be enabled", async () => {
    const a = (await call(alice, "tab_create")) as { tab_id: number };
    const original = fake.chrome.debugger.sendCommand.getMockImplementation()!;
    fake.chrome.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === "Network.enable" || method === "Runtime.enable") throw new Error("not allowed");
      return original(target, method, params);
    });
    cdp.forgetTab(a.tab_id);
    fake.attachedDebuggee.clear();
    await expect(cdp.ensureAttached(a.tab_id)).resolves.toBeUndefined();
  });

  it("returns the tab's entries, checks ownership, and clears on close and detach", async () => {
    const a = (await call(alice, "tab_create")) as { tab_id: number };
    await cdp.ensureAttached(a.tab_id);
    cdp.handleEvent(a.tab_id, "Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "kaput" }], timestamp: 1 });
    expect(await call(alice, "debug_logs", { tab_id: a.tab_id, source: "console" })).toEqual({
      entries: [{ level: "error", text: "kaput", t: 1 }],
      dropped: 0,
    });
    await expect(call(bob, "debug_logs", { tab_id: a.tab_id, source: "console" })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled(); // reading logs does not activate

    cdp.handleDetach({ tabId: a.tab_id }, "canceled_by_user");
    expect(cdp.logs.has(a.tab_id)).toBe(false);
    fake.attachedDebuggee.delete(a.tab_id);
    await cdp.ensureAttached(a.tab_id);
    cdp.handleEvent(a.tab_id, "Runtime.consoleAPICalled", { type: "log", args: [], timestamp: 2 });
    cdp.forgetTab(a.tab_id); // tab closed
    expect(cdp.logs.query(a.tab_id, { source: "console" })).toEqual({ entries: [], dropped: 0 });
  });

  it("starts capture lazily for a tab that is not attached yet", async () => {
    const a = (await call(alice, "tab_create")) as { tab_id: number };
    cdp.forgetTab(a.tab_id);
    fake.attachedDebuggee.clear();
    expect(await call(alice, "debug_logs", { tab_id: a.tab_id, source: "network" })).toEqual({ entries: [], dropped: 0 });
    await flush();
    expect(cdp.isAttached(a.tab_id)).toBe(true);
    expect(cdp.logs.has(a.tab_id)).toBe(true);
  });
});
