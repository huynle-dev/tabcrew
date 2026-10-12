import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const DEV_ORIGIN = "chrome-extension://aejgcpbbemekfbmmkabpbgdkgmddfamo/";

describe("tabcrew package metadata", () => {
  it("is publishable with only the bundles, README and LICENSE", () => {
    expect(pkg.name).toBe("tabcrew");
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ tabcrew: "dist/cli.mjs" });
    expect(pkg.files).toEqual(["dist/cli.mjs", "dist/daemon.mjs", "dist/pair-host.mjs", "README.md", "LICENSE"]);
    expect(pkg.engines.node).toBe(">=20.0.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository).toBe("github:huynle/tabcrew");
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe("bundles", () => {
  let out;
  let home;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "tabcrew-bundle-"));
    home = mkdtempSync(join(tmpdir(), "tabcrew-bundle-home-"));
    execFileSync(process.execPath, [join(root, "build.mjs")], { env: { ...process.env, TABCREW_BUILD_OUT: out }, stdio: "pipe" });
  }, 60_000);
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("are three executable ESM files that import only node built-ins", () => {
    expect(readdirSync(out).sort()).toEqual(["cli.mjs", "daemon.mjs", "pair-host.mjs"]);
    for (const file of readdirSync(out)) {
      const text = readFileSync(join(out, file), "utf8");
      expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
      const imports = [...text.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const spec of imports) expect(spec).toMatch(/^node:|^(fs|path|os|url|crypto|http|https|net|events|stream|util|child_process|readline|zlib|buffer|module|tls|querystring|string_decoder|assert|async_hooks|process|worker_threads)$/);
    }
  });

  it("run from outside the repository (no node_modules)", () => {
    const env = { ...process.env, TABCREW_HOME: join(home, "h"), NODE_PATH: "" };
    const help = spawnSync(process.execPath, [join(out, "cli.mjs"), "--help"], { cwd: out, env, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: tabcrew");
    const token = spawnSync(process.execPath, [join(out, "cli.mjs"), "token"], { cwd: out, env, encoding: "utf8" });
    expect(token.status).toBe(0);
    expect(token.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const daemonHelp = spawnSync(process.execPath, [join(out, "daemon.mjs"), "--help"], { cwd: out, env, encoding: "utf8" });
    expect(daemonHelp.status).toBe(0);
    expect(daemonHelp.stdout).toContain("TabCrew daemon");

    const body = Buffer.from(JSON.stringify({ type: "get_token" }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const pair = spawnSync(process.execPath, [join(out, "pair-host.mjs"), DEV_ORIGIN], { cwd: out, env, input: Buffer.concat([header, body]) });
    expect(pair.status).toBe(0);
    const reply = JSON.parse(pair.stdout.subarray(4, 4 + pair.stdout.readUInt32LE(0)).toString("utf8"));
    expect(reply).toEqual({ token: token.stdout.trim() });
    expect(pair.stderr.toString()).not.toContain(reply.token);
  });
});
