import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonError } from "./errors.js";
import { normaliseLabel, SessionRegistry } from "./sessions.js";
import { tempHome } from "./testing/helpers.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as DaemonError).code;
  }
  return undefined;
}

describe("SessionRegistry", () => {
  it("issues unguessable handles and independent short ids", () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    const { handle, session } = reg.open("Flights · search");
    expect(handle).toMatch(/^s_[A-Za-z0-9_-]{22}$/);
    expect(session.short_id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(handle).not.toContain(session.short_id);
    expect(session.label).toBe("Flights - search");
    expect(reg.use(handle)).toBe(session);
    expect(codeOf(() => reg.use("s_AAAAAAAAAAAAAAAAAAAAAA"))).toBe("bad_session");
    expect(codeOf(() => reg.use(session.short_id))).toBe("bad_session");
    expect(normaliseLabel("  ")).toBe("agent");
  });

  it("keeps a tab in at most one session and enforces ownership", () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    const a = reg.open("a").session;
    const b = reg.open("b").session;
    reg.addTab(a.short_id, 1);
    expect(codeOf(() => reg.requireTab(b, 1))).toBe("tab_not_owned");
    reg.addTab(b.short_id, 1);
    expect(a.tabs.has(1)).toBe(false);
    expect(b.tabs.has(1)).toBe(true);
    expect(reg.addTab("unknown1", 2)).toBe(false);
  });

  it("persists to sessions.json (0600, no raw handles) and reloads", () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const file = join(t.home, "sessions.json");
    const reg = new SessionRegistry({ file, idleTimeoutMs: 0 });
    const { handle, session } = reg.open("persist");
    reg.addTab(session.short_id, 42);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(handle);

    const reg2 = new SessionRegistry({ file, idleTimeoutMs: 0 });
    reg2.load();
    const restored = reg2.use(handle);
    expect(restored.short_id).toBe(session.short_id);
    expect(restored.label).toBe("persist");
    expect([...restored.tabs]).toEqual([42]);

    reg2.close(restored);
    const reg3 = new SessionRegistry({ file, idleTimeoutMs: 0 });
    reg3.load();
    expect(reg3.size).toBe(0);
  });

  it("reconciles with the extension's groups", () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    const a = reg.open("a").session;
    const b = reg.open("b").session;
    reg.addTab(a.short_id, 1);
    reg.addTab(a.short_id, 2);
    reg.addTab(b.short_id, 3);
    reg.reconcile([
      { short_id: a.short_id, tabs: [{ tab_id: 2, url: "", title: "" }, { tab_id: 5, url: "", title: "" }] },
      { short_id: "zzzzzzzz", tabs: [{ tab_id: 9, url: "", title: "" }] },
    ]);
    expect([...a.tabs].sort()).toEqual([2, 5]);
    expect([...b.tabs]).toEqual([]);
    expect(reg.size).toBe(2);
  });

  it("reports idle sessions after the timeout", () => {
    let now = 1_000;
    const reg = new SessionRegistry({ idleTimeoutMs: 100, now: () => now });
    const { handle: h1 } = reg.open("one");
    const { session: s2 } = reg.open("two");
    now += 60;
    reg.use(h1);
    now += 50;
    expect(reg.idleSessions()).toEqual([s2]);
  });
});
