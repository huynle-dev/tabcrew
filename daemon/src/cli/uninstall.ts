import { existsSync, lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeClaudeServer } from "./claude.js";
import { removeNativeHostManifests } from "./nativeHost.js";
import { inspectOpencode, opencodeConfigPath, readText, removeOpencodeEntry, writeText } from "./opencode.js";
import { tabcrewPaths } from "./paths.js";
import { removeService } from "./service.js";
import type { System } from "./system.js";

export interface UninstallOptions {
  /** Also delete token, env, sessions, config and logs. */
  readonly purge: boolean;
  readonly yes: boolean;
}

/** Files under the home removed by --purge (never anything else). */
export const PURGED_ENTRIES = ["token", "env", "sessions.json", "config.toml", "logs"] as const;

export async function uninstall(sys: System, opts: UninstallOptions): Promise<number> {
  const paths = tabcrewPaths(sys);
  if (sys.platform === "darwin") {
    if (await removeService(sys, paths)) sys.out(`✓ Stopped the daemon and removed ${paths.plist}`);
  }
  for (const removed of removeNativeHostManifests(sys)) sys.out(`✓ Removed ${removed}`);
  if (existsSync(paths.app)) {
    rmSync(paths.app, { recursive: true, force: true });
    sys.out(`✓ Removed ${paths.app}`);
  }

  if (opts.purge) {
    for (const name of PURGED_ENTRIES) {
      const path = join(paths.home, name);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    if (existsSync(paths.home) && readdirSync(paths.home).length === 0) rmdirSync(paths.home);
    sys.out(`✓ Purged token, env, sessions, config and logs from ${paths.home}`);
    try {
      if (lstatSync(paths.legacyHome).isSymbolicLink() && resolve(readlinkSync(paths.legacyHome)) === resolve(paths.home)) {
        unlinkSync(paths.legacyHome);
      }
    } catch {
      // no legacy link
    }
  }

  const ask = (question: string) => (opts.yes ? Promise.resolve(true) : sys.prompt.confirm(question, false));
  const opencode = opencodeConfigPath(sys);
  if (opencode) {
    try {
      const text = readText(opencode);
      if (inspectOpencode(text).entry && (await ask(`Remove the tabcrew entry from ${opencode}?`))) {
        writeText(opencode, removeOpencodeEntry(text).text);
        sys.out("✓ OpenCode: removed tabcrew");
      }
    } catch (err) {
      sys.out(`! OpenCode: ${(err as Error).message}`);
    }
  }
  const claude = sys.which("claude");
  if (claude && (await ask("Remove tabcrew from Claude Code?"))) {
    if (await removeClaudeServer(sys, claude)) sys.out("✓ Claude Code: removed tabcrew");
  }
  sys.out(opts.purge ? "TabCrew is uninstalled." : `TabCrew is uninstalled (token and settings kept in ${paths.home}; --purge removes them).`);
  return 0;
}
