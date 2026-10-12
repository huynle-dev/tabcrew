import { existsSync, rmSync } from "node:fs";
import { LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL } from "@tabcrew/shared/product";
import { SERVICE_PATH, writeLaunchdPlist } from "../launchd.js";
import type { TabCrewPaths } from "./paths.js";
import type { RuntimeLocation } from "./runtime.js";
import type { System } from "./system.js";

export interface Health {
  readonly ok: boolean;
  readonly version?: string;
  readonly extension_connected?: boolean;
}

export const HEALTH_TIMEOUT_MS = 15_000;
const POLL_MS = 500;

function domain(sys: Pick<System, "uid">): string {
  return `gui/${sys.uid}`;
}

export async function serviceLoaded(sys: System, label: string = LAUNCHD_LABEL): Promise<boolean> {
  return (await sys.run("launchctl", ["print", `${domain(sys)}/${label}`])).code === 0;
}

export async function bootout(sys: System, label: string): Promise<void> {
  await sys.run("launchctl", ["bootout", `${domain(sys)}/${label}`]);
}

export async function fetchHealth(sys: Pick<System, "fetch">, port: number): Promise<Health | null> {
  try {
    const res = await sys.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body && body.ok === true ? body : null;
  } catch {
    return null;
  }
}

export async function waitForHealth(sys: System, port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Health | null> {
  const deadline = sys.now() + timeoutMs;
  for (;;) {
    const health = await fetchHealth(sys, port);
    if (health) return health;
    if (sys.now() >= deadline) return null;
    await sys.sleep(POLL_MS);
  }
}

/** After a bootout, wait (briefly) until the old daemon has released the port. */
async function waitForDown(sys: System, port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = sys.now() + timeoutMs;
  while ((await fetchHealth(sys, port)) !== null && sys.now() < deadline) await sys.sleep(POLL_MS);
}

export interface ServiceResult {
  readonly plist: string;
  readonly legacyRemoved: boolean;
  readonly health: Health | null;
  readonly bootstrapError?: string;
}

/**
 * Write the LaunchAgent and (re)start it: boot out the legacy ChromeUse job (and delete its plist),
 * boot out a loaded TabCrew job, bootstrap the new plist, then wait for /health.
 */
export async function installService(
  sys: System,
  paths: TabCrewPaths,
  runtime: RuntimeLocation,
  mcpPort: number,
): Promise<ServiceResult> {
  let stopped = false;
  let legacyRemoved = false;
  if (await serviceLoaded(sys, LEGACY_LAUNCHD_LABEL)) {
    await bootout(sys, LEGACY_LAUNCHD_LABEL);
    stopped = true;
    legacyRemoved = true;
  }
  if (existsSync(paths.legacyPlist)) {
    rmSync(paths.legacyPlist, { force: true });
    legacyRemoved = true;
  }

  const plist = writeLaunchdPlist({
    home: paths.home,
    launchAgentsDir: paths.launchAgents,
    nodePath: sys.nodePath,
    scriptPath: runtime.daemonScript,
    pathEnv: SERVICE_PATH,
    tabcrewHome: paths.isDefaultHome ? undefined : paths.home,
  });

  if (await serviceLoaded(sys, LAUNCHD_LABEL)) {
    await bootout(sys, LAUNCHD_LABEL);
    stopped = true;
  }
  if (stopped) await waitForDown(sys, mcpPort);

  let bootstrapError: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await sys.run("launchctl", ["bootstrap", domain(sys), plist]);
    if (result.code === 0) {
      bootstrapError = undefined;
      break;
    }
    bootstrapError = (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.code}`;
    // Bootout finishes asynchronously; "Input/output error" usually means "try again shortly".
    await sys.sleep(1_000);
  }
  if (bootstrapError) return { plist, legacyRemoved, health: null, bootstrapError };
  return { plist, legacyRemoved, health: await waitForHealth(sys, mcpPort) };
}

export async function removeService(sys: System, paths: TabCrewPaths): Promise<boolean> {
  let changed = false;
  if (await serviceLoaded(sys, LAUNCHD_LABEL)) {
    await bootout(sys, LAUNCHD_LABEL);
    changed = true;
  }
  if (existsSync(paths.plist)) {
    rmSync(paths.plist, { force: true });
    changed = true;
  }
  return changed;
}
