import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadEnvFile } from "./config.js";
import { launchdPlist, writeLaunchdPlist } from "./launchd.js";
import { tempHome } from "./testing/helpers.js";
import { ensureToken, safeEqual } from "./token.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});
function home(): string {
  const t = tempHome();
  cleanup = t.cleanup;
  return t.home;
}

describe("config", () => {
  it("uses defaults", () => {
    const h = home();
    const c = loadConfig({ CHROMEUSE_HOME: h });
    expect(c).toMatchObject({
      home: h,
      mcpPort: 8770,
      extensionPort: 8771,
      idleTimeoutMinutes: 30,
      browseConcurrency: 8,
      jevModel: "typesafe/jev-1.13",
      textModel: "inception/mercury-2.5",
      allowedOrigins: [],
      openrouterApiKey: undefined,
    });
  });

  it("reads config.toml and lets env override it; port 0 allowed", () => {
    const h = home();
    writeFileSync(
      join(h, "config.toml"),
      'mcp_port = 9000\nextension_port = 9001\nidle_timeout_minutes = 5\njev_model = "x/y"\nallowed_origins = ["http://ok"]\nopenrouter_api_key = "nope"\n',
    );
    const c = loadConfig({ CHROMEUSE_HOME: h, CHROMEUSE_MCP_PORT: "0", JEV_MODEL: "env/model", OPENROUTER_API_KEY: "k" });
    expect(c.mcpPort).toBe(0);
    expect(c.extensionPort).toBe(9001);
    expect(c.idleTimeoutMinutes).toBe(5);
    expect(c.jevModel).toBe("env/model");
    expect(c.allowedOrigins).toEqual(["http://ok"]);
    expect(c.openrouterApiKey).toBe("k");
  });

  it("rejects invalid values", () => {
    const h = home();
    expect(() => loadConfig({ CHROMEUSE_HOME: h, CHROMEUSE_MCP_PORT: "70000" })).toThrow(/CHROMEUSE_MCP_PORT/);
    writeFileSync(join(h, "config.toml"), "mcp_port = -1\n");
    expect(() => loadConfig({ CHROMEUSE_HOME: h })).toThrow(/mcp_port/);
  });

  it("loads <home>/env without overriding existing vars, only when 0600", () => {
    const h = home();
    const file = join(h, "env");
    writeFileSync(file, '# comment\nOPENROUTER_API_KEY="abc"\nexport FOO=bar\nKEEP=new\n', { mode: 0o600 });
    const env: Record<string, string | undefined> = { KEEP: "old" };
    expect(loadEnvFile(h, env).sort()).toEqual(["FOO", "OPENROUTER_API_KEY"]);
    expect(env).toEqual({ KEEP: "old", OPENROUTER_API_KEY: "abc", FOO: "bar" });

    chmodSync(file, 0o644);
    const env2: Record<string, string | undefined> = {};
    expect(loadEnvFile(h, env2)).toEqual([]);
    expect(env2).toEqual({});
  });
});

describe("token", () => {
  it("creates a 0600 token once in a 0700 home", () => {
    const h = join(home(), "nested");
    const t1 = ensureToken(h);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(h, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(h).mode & 0o777).toBe(0o700);
    expect(ensureToken(h)).toBe(t1);
    expect(safeEqual(t1, t1)).toBe(true);
    expect(safeEqual(t1, `${t1}x`)).toBe(false);
  });
});

describe("launchd", () => {
  it("writes a plist without secrets and with logs under home", () => {
    const h = home();
    const opts = {
      home: h,
      launchAgentsDir: join(h, "LaunchAgents"),
      nodePath: "/usr/local/bin/node",
      scriptPath: "/opt/chromeuse/daemon/dist/index.js",
      pathEnv: "/usr/bin:/bin",
    };
    const path = writeLaunchdPlist(opts);
    expect(path).toBe(join(h, "LaunchAgents", "com.chromeuse.daemon.plist"));
    const plist = launchdPlist(opts);
    expect(plist).toContain("<string>/opt/chromeuse/daemon/dist/index.js</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain(join(h, "logs", "daemon.err.log"));
    expect(plist).not.toMatch(/OPENROUTER/);
    expect(statSync(join(h, "logs")).isDirectory()).toBe(true);
  });
});
