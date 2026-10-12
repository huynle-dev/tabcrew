import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeSystem, type FakeSystem } from "../testing/fakeSystem.js";
import { tempHome } from "../testing/helpers.js";
import { cliMain } from "./main.js";
import { runChecks } from "./doctor.js";
import { setup } from "./setup.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const KEY = "sk-or-good-1";

function installed(opts: { claude?: boolean } = {}): { root: string; sys: FakeSystem } {
  const t = tempHome();
  cleanup = t.cleanup;
  const root = t.home;
  const runtimeDir = join(root, "pkg");
  mkdirSync(runtimeDir);
  writeFileSync(join(runtimeDir, "daemon.mjs"), "");
  writeFileSync(join(runtimeDir, "pair-host.mjs"), "");
  mkdirSync(join(root, ".config", "opencode"), { recursive: true });
  writeFileSync(join(root, ".config", "opencode", "opencode.json"), '{ "mcp": {} }\n');
  const sys = fakeSystem(root, { runtimeDir, which: (cmd) => (cmd === "claude" && opts.claude !== false ? "/fake/claude" : null) });
  (sys.env as Record<string, string>).OPENROUTER_API_KEY = KEY;
  return { root, sys };
}

const byName = (checks: { name: string; status: string }[]) => Object.fromEntries(checks.map((c) => [c.name, c.status]));

describe("tabcrew doctor", () => {
  it("reports every check OK after setup with the extension connected", async () => {
    const { sys } = installed();
    await setup(sys, { yes: true, harness: true });
    sys.state.extensionConnected = true;
    sys.lines.length = 0;
    expect(await cliMain(["doctor"], sys)).toBe(0);
    expect(byName(await runChecks(sys, { online: false }))).toEqual({
      node: "ok",
      home: "ok",
      token: "ok",
      "openrouter key": "ok",
      "launchd plist": "ok",
      service: "ok",
      daemon: "ok",
      extension: "ok",
      "pairing host (Google Chrome)": "ok",
      "pairing wrapper": "ok",
      opencode: "ok",
      "claude code": "ok",
    });
    expect(sys.output()).toContain("All required checks passed.");
  });

  it("fails with one-line fixes when nothing is installed", async () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const sys = fakeSystem(t.home, { nodeVersion: "18.19.0" });
    expect(await cliMain(["doctor"], sys)).toBe(1);
    const out = sys.output();
    expect(out).toMatch(/FAIL node: v18\.19\.0\n\s+fix: install Node\.js 20 or newer/);
    expect(out).toMatch(/FAIL token: missing\n\s+fix: run: npx tabcrew setup/);
    expect(out).toMatch(/FAIL service: com\.tabcrew\.daemon not loaded/);
    expect(out).toMatch(/FAIL daemon: no answer/);
    expect(out).toMatch(/FAIL pairing host \(Google Chrome\): missing/);
    expect(out).not.toContain("extension:");
  });

  it("flags a disconnected extension, loose permissions, stale host manifests and the legacy job", async () => {
    const { root, sys } = installed({ claude: false });
    await setup(sys, { yes: true, harness: false });
    chmodSync(join(root, ".tabcrew", "token"), 0o644);
    const manifest = join(root, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.tabcrew.pair.json");
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...m, allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"] }));
    sys.state.loaded.add("com.chromeuse.daemon");
    const checks = await runChecks(sys, { online: false });
    expect(byName(checks)).toMatchObject({
      token: "fail",
      extension: "fail",
      "pairing host (Google Chrome)": "fail",
      "legacy service": "warn",
      opencode: "warn",
    });
    expect(checks.find((c) => c.name === "token")?.fix).toBe(`chmod 600 ${join(root, ".tabcrew", "token")}`);
    expect(checks.find((c) => c.name === "pairing host (Google Chrome)")?.detail).toContain("allowed_origins");
  });

  it("validates the key only with --online", async () => {
    const { sys } = installed({ claude: false });
    await setup(sys, { yes: true, harness: false });
    sys.fetchUrls.length = 0;
    await runChecks(sys, { online: false });
    expect(sys.fetchUrls.some((u) => u.includes("openrouter"))).toBe(false);
    sys.state.keyStatus = () => 401;
    const checks = await runChecks(sys, { online: true });
    expect(checks.find((c) => c.name === "openrouter key")).toMatchObject({ status: "fail", detail: "rejected by OpenRouter" });
  });
});

describe("tabcrew uninstall", () => {
  it("removes the service, host manifests and runtime but keeps the token and harness entries by default", async () => {
    const { root, sys } = installed();
    await setup(sys, { yes: true, harness: true });
    sys.calls.length = 0;
    expect(await cliMain(["uninstall"], sys)).toBe(0);
    expect(sys.calls.filter((c) => c[0] === "launchctl").map((c) => c.slice(1).join(" "))).toEqual([
      "print gui/501/com.tabcrew.daemon",
      "bootout gui/501/com.tabcrew.daemon",
    ]);
    expect(existsSync(join(root, "Library", "LaunchAgents", "com.tabcrew.daemon.plist"))).toBe(false);
    expect(existsSync(join(root, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.tabcrew.pair.json"))).toBe(false);
    expect(existsSync(join(root, ".tabcrew", "app"))).toBe(false);
    expect(existsSync(join(root, ".tabcrew", "token"))).toBe(true);
    expect(readFileSync(join(root, ".config", "opencode", "opencode.json"), "utf8")).toContain('"tabcrew"');
    expect(sys.state.claudeServers.has("tabcrew")).toBe(true);
  });

  it("--purge --yes also deletes token, env, sessions and logs, the legacy link and harness entries", async () => {
    const { root, sys } = installed();
    const legacy = join(root, ".chromeuse");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "token"), "x".repeat(43), { mode: 0o600 });
    await setup(sys, { yes: true, harness: true });
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    writeFileSync(join(root, ".tabcrew", "sessions.json"), "[]");
    expect(await cliMain(["uninstall", "--purge", "--yes"], sys)).toBe(0);
    expect(existsSync(join(root, ".tabcrew"))).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(root, ".config", "opencode", "opencode.json"), "utf8")).not.toContain("tabcrew");
    expect(sys.state.claudeServers.has("tabcrew")).toBe(false);
  });

  it("--purge never deletes unknown files in the home", async () => {
    const { root, sys } = installed({ claude: false });
    await setup(sys, { yes: true, harness: false });
    writeFileSync(join(root, ".tabcrew", "notes.txt"), "mine");
    await cliMain(["uninstall", "--purge"], sys);
    expect(readFileSync(join(root, ".tabcrew", "notes.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(root, ".tabcrew", "token"))).toBe(false);
    rmSync(join(root, ".tabcrew"), { recursive: true });
  });
});
