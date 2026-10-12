import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDefaultHome, migrateLegacyHome, productEnv } from "./home.js";
import { tempHome } from "./testing/helpers.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});
function userHome(): string {
  const t = tempHome();
  cleanup = t.cleanup;
  return t.home;
}

function legacyHomeWithFiles(root: string): string {
  const legacy = join(root, ".chromeuse");
  mkdirSync(join(legacy, "logs"), { recursive: true, mode: 0o700 });
  chmodSync(legacy, 0o700);
  writeFileSync(join(legacy, "token"), "t".repeat(43), { mode: 0o600 });
  writeFileSync(join(legacy, "env"), "OPENROUTER_API_KEY=k\n", { mode: 0o600 });
  writeFileSync(join(legacy, "sessions.json"), "[]", { mode: 0o600 });
  writeFileSync(join(legacy, "config.toml"), "mcp_port = 8770\n", { mode: 0o600 });
  writeFileSync(join(legacy, "logs", "daemon.err.log"), "old log\n", { mode: 0o644 });
  return legacy;
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("productEnv", () => {
  it("prefers TABCREW_, falls back to CHROMEUSE_, ignores blanks", () => {
    expect(productEnv({ TABCREW_LOG: "debug", CHROMEUSE_LOG: "silent" }, "LOG")).toEqual({ value: "debug", from: "TABCREW_LOG" });
    expect(productEnv({ TABCREW_LOG: "  ", CHROMEUSE_LOG: "silent" }, "LOG")).toEqual({ value: "silent", from: "CHROMEUSE_LOG" });
    expect(productEnv({}, "LOG")).toBeUndefined();
  });
});

describe("migrateLegacyHome", () => {
  it("moves everything into ~/.tabcrew, keeps modes, and links ~/.chromeuse to it", () => {
    const root = userHome();
    const legacy = legacyHomeWithFiles(root);
    const home = join(root, ".tabcrew");
    const result = migrateLegacyHome(home, legacy);
    expect(result.status).toBe("migrated");
    expect(result.status === "migrated" && [...result.moved].sort()).toEqual(["config.toml", "env", "logs", "sessions.json", "token"]);
    expect(mode(home)).toBe(0o700);
    for (const f of ["token", "env", "sessions.json", "config.toml"]) expect(mode(join(home, f))).toBe(0o600);
    expect(readFileSync(join(home, "logs", "daemon.err.log"), "utf8")).toBe("old log\n");
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readlinkSync(legacy)).toBe(home);
    // Old paths keep working through the link.
    expect(readFileSync(join(legacy, "token"), "utf8")).toBe("t".repeat(43));
    expect(readdirSync(root).sort()).toEqual([".chromeuse", ".tabcrew"]);
  });

  it("is idempotent", () => {
    const root = userHome();
    const legacy = legacyHomeWithFiles(root);
    const home = join(root, ".tabcrew");
    migrateLegacyHome(home, legacy);
    expect(migrateLegacyHome(home, legacy)).toEqual({ status: "none" });
    expect(readFileSync(join(home, "token"), "utf8")).toBe("t".repeat(43));
  });

  it("does nothing without a legacy home, and never touches an existing ~/.tabcrew", () => {
    const root = userHome();
    expect(migrateLegacyHome(join(root, ".tabcrew"), join(root, ".chromeuse"))).toEqual({ status: "none" });

    const legacy = legacyHomeWithFiles(root);
    const home = join(root, ".tabcrew");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, "token"), "n".repeat(43), { mode: 0o600 });
    expect(migrateLegacyHome(home, legacy).status).toBe("skipped");
    expect(readFileSync(join(home, "token"), "utf8")).toBe("n".repeat(43));
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "token"), "utf8")).toBe("t".repeat(43));
  });

  it("resumes an interrupted migration without overwriting what was already moved", () => {
    const root = userHome();
    const legacy = legacyHomeWithFiles(root);
    const home = join(root, ".tabcrew");
    // A previous run moved token into the staging dir, then a newer token appeared in the legacy home.
    mkdirSync(`${home}.migrating`, { mode: 0o700 });
    writeFileSync(join(`${home}.migrating`, "token"), "s".repeat(43), { mode: 0o600 });
    const result = migrateLegacyHome(home, legacy, () => new Date("2026-10-12T00:00:00Z"));
    expect(result.status).toBe("migrated");
    expect(readFileSync(join(home, "token"), "utf8")).toBe("s".repeat(43));
    expect(readFileSync(join(home, "env"), "utf8")).toContain("OPENROUTER_API_KEY");
    // The conflicting legacy token is kept in a backup, not deleted.
    const backup = result.status === "migrated" ? result.backup : undefined;
    expect(backup).toBe(join(root, ".chromeuse.bak-2026-10-12T00-00-00-000Z"));
    expect(readFileSync(join(backup!, "token"), "utf8")).toBe("t".repeat(43));
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
  });

  it("migrateDefaultHome leaves custom homes alone", () => {
    const root = userHome();
    legacyHomeWithFiles(root);
    expect(migrateDefaultHome(join(root, "custom"), root)).toEqual({ status: "none" });
    expect(lstatSync(join(root, ".chromeuse")).isDirectory()).toBe(true);
    expect(migrateDefaultHome(join(root, ".tabcrew"), root).status).toBe("migrated");
  });
});
