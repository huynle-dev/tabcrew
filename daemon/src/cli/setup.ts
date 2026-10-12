import { join } from "node:path";
import { CHROME_WEB_STORE_URL } from "@tabcrew/shared/product";
import { V2_MCP_PORT } from "@tabcrew/shared/v2";
import { loadConfig } from "../config.js";
import { migrateDefaultHome } from "../home.js";
import { ensureHome, ensureToken } from "../token.js";
import { ensureClaudeServer } from "./claude.js";
import { writeNativeHostManifests } from "./nativeHost.js";
import { KEY_NAME, readEnvFileValue, upsertEnvFileValue, validateOpenRouterKey } from "./openrouter.js";
import { inspectOpencode, opencodeConfigPath, readText, tokenFileRef, upsertOpencode, writeText } from "./opencode.js";
import { tabcrewPaths, type TabCrewPaths } from "./paths.js";
import { installRuntime, SetupError, sourceRuntime, writePairWrapper, type RuntimeLocation } from "./runtime.js";
import { installService } from "./service.js";
import type { System } from "./system.js";

export interface SetupOptions {
  /** Non-interactive: accept every harness, take OPENROUTER_API_KEY from the environment. */
  readonly yes: boolean;
  /** Skip OpenCode / Claude Code registration. */
  readonly harness: boolean;
  /** Development: run from a built checkout instead of copying the bundled runtime. */
  readonly fromSource?: string;
}

const OK = "✓";
const WARN = "!";
const FAIL = "✗";

export function mcpPortFor(home: string): number {
  try {
    return loadConfig({ TABCREW_HOME: home }).mcpPort;
  } catch {
    return V2_MCP_PORT;
  }
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** Step 1: migrate ~/.chromeuse, then make sure the home (0700) and token exist. */
export function prepareHome(sys: System, paths: TabCrewPaths): string {
  const migrated = paths.isDefaultHome ? migrateDefaultHome(paths.home, sys.homedir) : { status: "none" as const };
  if (migrated.status === "migrated") {
    sys.out(`${OK} Moved ${paths.legacyHome} into ${paths.home} (${migrated.moved.join(", ") || "empty"}); ${paths.legacyHome} now links to it`);
    if (migrated.backup) sys.out(`${WARN} Entries that could not be moved were kept in ${migrated.backup}`);
  } else if (migrated.status === "skipped") {
    sys.out(`${WARN} Left ${paths.legacyHome} alone: ${migrated.reason}`);
  }
  ensureHome(paths.home);
  ensureToken(paths.home);
  sys.out(`${OK} Home ${paths.home} (token ready)`);
  return paths.home;
}

/** Step 2: make sure OPENROUTER_API_KEY is in <home>/env, validating it with a free call. */
export async function configureKey(sys: System, paths: TabCrewPaths, opts: SetupOptions): Promise<"present" | "saved" | "skipped"> {
  if (readEnvFileValue(paths.envFile, KEY_NAME)) {
    sys.out(`${OK} ${KEY_NAME} already set in ${paths.envFile}`);
    return "present";
  }
  const skipNote = `${WARN} No OpenRouter key: browse will report model_error until you add ${KEY_NAME} to ${paths.envFile} (or rerun setup)`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = opts.yes
      ? (sys.env[KEY_NAME]?.trim() ?? "")
      : (await sys.prompt.secret("OpenRouter API key for browse (input hidden, Enter to skip): ")).trim();
    if (!key) {
      sys.out(skipNote);
      return "skipped";
    }
    const check = await validateOpenRouterKey(sys, key);
    if (check === "invalid") {
      sys.out(`${FAIL} OpenRouter rejected that key`);
      if (opts.yes) {
        sys.out(skipNote);
        return "skipped";
      }
      continue;
    }
    upsertEnvFileValue(paths.envFile, KEY_NAME, key);
    sys.out(
      check === "valid"
        ? `${OK} Saved ${KEY_NAME} to ${paths.envFile} (mode 600)`
        : `${WARN} Could not reach OpenRouter to check the key; saved it to ${paths.envFile} anyway`,
    );
    return "saved";
  }
  sys.out(skipNote);
  return "skipped";
}

/** Steps 3-5 (shared with `update`): runtime, LaunchAgent, pairing host. Returns false on failure. */
export async function installAll(sys: System, paths: TabCrewPaths, fromSource: string | undefined): Promise<boolean> {
  let runtime: RuntimeLocation;
  try {
    runtime = fromSource ? sourceRuntime(fromSource) : installRuntime(paths, sys.runtimeDir);
  } catch (err) {
    if (err instanceof SetupError) {
      sys.out(`${FAIL} ${err.message}`);
      return false;
    }
    throw err;
  }
  sys.out(runtime.kind === "installed" ? `${OK} Installed the runtime in ${paths.app}` : `${OK} Using the development build in ${fromSource}`);

  if (sys.platform !== "darwin") {
    sys.out(`${WARN} Installing the background service is not supported on ${sys.platform} yet (macOS only).`);
    sys.out(`  Run the daemon yourself: ${sys.nodePath} ${runtime.daemonScript}`);
    return false;
  }

  const port = mcpPortFor(paths.home);
  const service = await installService(sys, paths, runtime, port);
  if (service.legacyRemoved) sys.out(`${OK} Removed the old ChromeUse launchd job`);

  writePairWrapper(paths, sys.nodePath, runtime.pairHostScript);
  const written = writeNativeHostManifests(sys, paths.pairWrapper);
  sys.out(`${OK} Pairing host registered for ${written.map((w) => w.browser).join(", ")}`);

  if (service.bootstrapError) {
    sys.out(`${FAIL} launchctl bootstrap failed: ${service.bootstrapError}`);
    sys.out(`  Check ${join(paths.logs, "daemon.err.log")}, then rerun: npx tabcrew setup`);
    return false;
  }
  if (!service.health) {
    sys.out(`${FAIL} The daemon did not answer on http://127.0.0.1:${port}/health within 15 s`);
    sys.out(`  Check ${join(paths.logs, "daemon.err.log")}`);
    return false;
  }
  sys.out(`${OK} Daemon running under launchd (version ${service.health.version ?? "?"})`);
  return true;
}

/** Step 6: OpenCode and Claude Code. */
export async function configureHarnesses(sys: System, paths: TabCrewPaths, opts: SetupOptions): Promise<void> {
  const url = mcpUrl(mcpPortFor(paths.home));
  const ask = (question: string, def: boolean) => (opts.yes ? Promise.resolve(true) : sys.prompt.confirm(question, def));

  const opencode = opencodeConfigPath(sys);
  if (opencode) {
    try {
      const text = readText(opencode);
      const state = inspectOpencode(text);
      if (await ask(`Add TabCrew to OpenCode (${opencode})?`, true)) {
        let legacy: "replace" | "rewrite" = "replace";
        if (!state.entry && state.legacy && !opts.yes) {
          legacy = (await sys.prompt.confirm(`Replace the existing "chromeuse" entry with "tabcrew"? (No keeps it and updates its token path)`, true))
            ? "replace"
            : "rewrite";
        }
        const result = upsertOpencode(text, { url, tokenRef: tokenFileRef(paths.home, sys.homedir) }, legacy);
        if (result.text !== text) writeText(opencode, result.text);
        const messages: Record<typeof result.change, string> = {
          added: "added tabcrew",
          updated: "updated tabcrew",
          replaced_legacy: "replaced chromeuse with tabcrew",
          rewrote_legacy: "pointed chromeuse at the new token path",
          unchanged: "tabcrew already configured",
        };
        sys.out(`${OK} OpenCode: ${messages[result.change]} (restart OpenCode to load it)`);
      }
    } catch (err) {
      sys.out(`${WARN} OpenCode: ${(err as Error).message}; skipped`);
    }
  }

  const claude = sys.which("claude");
  if (claude && (await ask("Add TabCrew to Claude Code (user scope)?", true))) {
    const token = ensureToken(paths.home);
    const result = await ensureClaudeServer(sys, claude, url, token);
    if (result.status === "present") sys.out(`${OK} Claude Code: tabcrew already configured`);
    else if (result.status === "added") sys.out(`${OK} Claude Code: added tabcrew`);
    else sys.out(`${WARN} Claude Code: could not add tabcrew (${result.message})`);
  }
}

export function nextSteps(sys: System): void {
  sys.out("");
  sys.out("Next steps:");
  sys.out(`  1. Install the TabCrew extension: ${CHROME_WEB_STORE_URL}`);
  sys.out("     (development: chrome://extensions → Developer mode → Load unpacked → <repo>/extension/dist)");
  sys.out("  2. Pairing is automatic: the extension fetches the token from this machine. Its popup should show \"connected\".");
  sys.out("  3. Check everything with: npx tabcrew doctor");
}

export async function setup(sys: System, opts: SetupOptions): Promise<number> {
  const paths = tabcrewPaths(sys);
  prepareHome(sys, paths);
  await configureKey(sys, paths, opts);
  const installed = await installAll(sys, paths, opts.fromSource);
  if (opts.harness) await configureHarnesses(sys, paths, opts);
  if (!installed) return 1;
  nextSteps(sys);
  return 0;
}
