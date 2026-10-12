#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadEnvFile, resolveHome } from "./config.js";
import { startDaemon } from "./daemon.js";
import { writeLaunchdPlist } from "./launchd.js";
import { log } from "./log.js";
import { ensureToken } from "./token.js";

const USAGE = `usage: chromeuse-daemon [command]

commands:
  (none)           run the daemon
  token            print the auth token (paste it into the ChromeUse v2 extension and MCP config)
  install-launchd  write ~/Library/LaunchAgents/com.chromeuse.daemon.plist and print how to load it
  help             show this help

OPENROUTER_API_KEY is read from the environment, or from <home>/env (KEY=VALUE lines, chmod 600).
Home is $CHROMEUSE_HOME or ~/.chromeuse.`;

async function run(): Promise<void> {
  const home = resolveHome();
  const loaded = loadEnvFile(home);
  if (loaded.length) log.info(`loaded ${loaded.length} variable(s) from ${join(home, "env")}`);
  const config = loadConfig();
  const daemon = await startDaemon(config);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${signal}, shutting down`);
    daemon.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

function installLaunchd(): void {
  const home = resolveHome();
  const scriptPath = realpathSync(fileURLToPath(import.meta.url));
  const path = writeLaunchdPlist({
    home,
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    nodePath: stableNodePath(),
    scriptPath,
    pathEnv: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    chromeuseHome: process.env.CHROMEUSE_HOME ? home : undefined,
  });
  process.stdout.write(
    `Wrote ${path}\n` +
      `Put OPENROUTER_API_KEY=... in ${join(home, "env")} (chmod 600); it is not stored in the plist.\n` +
      `Load it with:\n  launchctl bootstrap gui/$(id -u) ${path}\n` +
      `Unload with:\n  launchctl bootout gui/$(id -u) ${path}\n`,
  );
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  switch (command) {
    case undefined:
    case "run":
      await run();
      return;
    case "token":
      process.stdout.write(`${ensureToken(resolveHome())}\n`);
      return;
    case "install-launchd":
      installLaunchd();
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}\n`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err) => {
  log.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});

/**
 * Prefer a stable link (e.g. /opt/homebrew/bin/node) over process.execPath, which on Homebrew is a
 * versioned Cellar path that disappears on the next upgrade.
 */
function stableNodePath(): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const target = real(process.execPath);
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (target && real(candidate) === target) return candidate;
  }
  return process.execPath;
}
