import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TabCrewPaths } from "./paths.js";

export interface RuntimeLocation {
  /** Script launchd runs with node (no arguments = run the daemon). */
  readonly daemonScript: string;
  /** Script the pairing wrapper runs with node. */
  readonly pairHostScript: string;
  /** "installed" = copied into ~/.tabcrew/app; "source" = a development checkout. */
  readonly kind: "installed" | "source";
}

export class SetupError extends Error {}

/** Copy the bundled daemon.mjs and pair-host.mjs into `<home>/app` (overwriting older copies). */
export function installRuntime(paths: TabCrewPaths, runtimeDir: string | null): RuntimeLocation {
  if (!runtimeDir) throw new SetupError("cannot find the bundled runtime; run tabcrew from its npm package or use --from-source <repo>");
  const daemon = join(runtimeDir, "daemon.mjs");
  const pairHost = join(runtimeDir, "pair-host.mjs");
  for (const file of [daemon, pairHost]) {
    if (!existsSync(file)) throw new SetupError(`missing ${file}; build the cli package first (npm run build -w cli)`);
  }
  mkdirSync(paths.app, { recursive: true, mode: 0o700 });
  chmodSync(paths.app, 0o700);
  copyFileSync(daemon, paths.installedDaemon);
  copyFileSync(pairHost, paths.installedPairHost);
  chmodSync(paths.installedDaemon, 0o755);
  chmodSync(paths.installedPairHost, 0o755);
  return { daemonScript: paths.installedDaemon, pairHostScript: paths.installedPairHost, kind: "installed" };
}

/** Development: run straight from a built checkout (`npm run build`). */
export function sourceRuntime(repoDir: string): RuntimeLocation {
  const repo = resolve(repoDir);
  const daemonScript = join(repo, "daemon", "dist", "index.js");
  const pairHostScript = join(repo, "cli", "dist", "pair-host.mjs");
  for (const file of [daemonScript, pairHostScript]) {
    if (!existsSync(file)) throw new SetupError(`missing ${file}; run npm run build in ${repo}`);
  }
  return { daemonScript, pairHostScript, kind: "source" };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function pairWrapperScript(nodePath: string, pairHostScript: string, home: string): string {
  return [
    "#!/bin/sh",
    "# TabCrew pairing host launcher, written by `tabcrew setup`. Chrome starts it via com.tabcrew.pair.",
    `export TABCREW_HOME=${shellQuote(home)}`,
    `exec ${shellQuote(nodePath)} ${shellQuote(pairHostScript)} "$@"`,
    "",
  ].join("\n");
}

/** Write `<home>/app/pair-host` (mode 0755). */
export function writePairWrapper(paths: TabCrewPaths, nodePath: string, pairHostScript: string): string {
  mkdirSync(paths.app, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pairWrapper, pairWrapperScript(nodePath, pairHostScript, paths.home), { mode: 0o755 });
  chmodSync(paths.pairWrapper, 0o755);
  return paths.pairWrapper;
}
