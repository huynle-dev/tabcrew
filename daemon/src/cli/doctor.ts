import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { CHROME_WEB_STORE_URL, LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL } from "@tabcrew/shared/product";
import { claudeHasServer } from "./claude.js";
import { checkNativeHostManifest, targetHostDirs } from "./nativeHost.js";
import { KEY_NAME, readEnvFileValue, validateOpenRouterKey } from "./openrouter.js";
import { inspectOpencode, opencodeConfigPath, readText } from "./opencode.js";
import { tabcrewPaths } from "./paths.js";
import { fetchHealth, serviceLoaded } from "./service.js";
import { mcpPortFor } from "./setup.js";
import type { System } from "./system.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** One-line fix, shown for warn/fail. */
  readonly fix?: string;
}

export interface DoctorOptions {
  /** Also validate the OpenRouter key with a (free) network call. */
  readonly online: boolean;
}

const SETUP = "run: npx tabcrew setup";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function plistScript(plist: string): string | null {
  const text = readFileSync(plist, "utf8");
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const strings = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  return strings[1] ?? null;
}

export async function runChecks(sys: System, opts: DoctorOptions): Promise<Check[]> {
  const paths = tabcrewPaths(sys);
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const mac = sys.platform === "darwin";

  const major = Number(sys.nodeVersion.split(".")[0]);
  add(
    major >= 20
      ? { name: "node", status: "ok", detail: `v${sys.nodeVersion}` }
      : { name: "node", status: "fail", detail: `v${sys.nodeVersion}`, fix: "install Node.js 20 or newer" },
  );

  if (!existsSync(paths.home)) {
    add({ name: "home", status: "fail", detail: `${paths.home} missing`, fix: SETUP });
  } else if ((mode(paths.home) & 0o077) !== 0) {
    add({ name: "home", status: "fail", detail: `${paths.home} is accessible by other users`, fix: `chmod 700 ${paths.home}` });
  } else {
    add({ name: "home", status: "ok", detail: paths.home });
  }

  if (!existsSync(paths.token) || readFileSync(paths.token, "utf8").trim().length < 32) {
    add({ name: "token", status: "fail", detail: "missing", fix: SETUP });
  } else if ((mode(paths.token) & 0o077) !== 0) {
    add({ name: "token", status: "fail", detail: "readable by other users", fix: `chmod 600 ${paths.token}` });
  } else {
    add({ name: "token", status: "ok", detail: paths.token });
  }

  if (!existsSync(paths.envFile)) {
    add({ name: "openrouter key", status: "warn", detail: `${paths.envFile} missing (browse disabled)`, fix: SETUP });
  } else if ((mode(paths.envFile) & 0o077) !== 0) {
    add({ name: "openrouter key", status: "fail", detail: `${paths.envFile} is readable by other users (the daemon ignores it)`, fix: `chmod 600 ${paths.envFile}` });
  } else {
    const key = readEnvFileValue(paths.envFile, KEY_NAME);
    if (!key) {
      add({ name: "openrouter key", status: "warn", detail: `${KEY_NAME} not set (browse disabled)`, fix: SETUP });
    } else if (opts.online) {
      const check = await validateOpenRouterKey(sys, key);
      add(
        check === "valid"
          ? { name: "openrouter key", status: "ok", detail: "valid" }
          : check === "invalid"
            ? { name: "openrouter key", status: "fail", detail: "rejected by OpenRouter", fix: `replace ${KEY_NAME} in ${paths.envFile}, then ${SETUP}` }
            : { name: "openrouter key", status: "warn", detail: "set, but OpenRouter could not be reached" },
      );
    } else {
      add({ name: "openrouter key", status: "ok", detail: "set (use --online to validate)" });
    }
  }

  if (mac) {
    if (!existsSync(paths.plist)) {
      add({ name: "launchd plist", status: "fail", detail: `${paths.plist} missing`, fix: SETUP });
    } else {
      const script = plistScript(paths.plist);
      add(
        script && existsSync(script)
          ? { name: "launchd plist", status: "ok", detail: script }
          : { name: "launchd plist", status: "fail", detail: `runs a missing script (${script ?? "?"})`, fix: SETUP },
      );
    }
    add(
      (await serviceLoaded(sys, LAUNCHD_LABEL))
        ? { name: "service", status: "ok", detail: `${LAUNCHD_LABEL} loaded` }
        : { name: "service", status: "fail", detail: `${LAUNCHD_LABEL} not loaded`, fix: SETUP },
    );
    if (await serviceLoaded(sys, LEGACY_LAUNCHD_LABEL)) {
      add({ name: "legacy service", status: "warn", detail: `${LEGACY_LAUNCHD_LABEL} (ChromeUse) is still loaded`, fix: SETUP });
    }
  } else {
    add({ name: "service", status: "skip", detail: `background service not supported on ${sys.platform} yet` });
  }

  const port = mcpPortFor(paths.home);
  const health = await fetchHealth(sys, port);
  add(
    health
      ? { name: "daemon", status: "ok", detail: `http://127.0.0.1:${port} (version ${health.version ?? "?"})` }
      : { name: "daemon", status: "fail", detail: `no answer on http://127.0.0.1:${port}/health`, fix: mac ? SETUP : "start the daemon" },
  );
  if (health) {
    add(
      health.extension_connected
        ? { name: "extension", status: "ok", detail: "connected" }
        : {
            name: "extension",
            status: "fail",
            detail: "not connected",
            fix: `install the extension (${CHROME_WEB_STORE_URL}), make sure the browser is open, and check its popup`,
          },
    );
  }

  const hostDirs = targetHostDirs(sys);
  if (hostDirs.length === 0) {
    add({ name: "pairing host", status: "skip", detail: `not supported on ${sys.platform} yet` });
  } else {
    for (const dir of hostDirs) {
      const problems = checkNativeHostManifest(dir.manifest, paths.pairWrapper);
      add(
        problems.length === 0
          ? { name: `pairing host (${dir.browser})`, status: "ok", detail: dir.manifest }
          : { name: `pairing host (${dir.browser})`, status: "fail", detail: problems.join("; "), fix: SETUP },
      );
    }
    let wrapperOk = false;
    try {
      accessSync(paths.pairWrapper, constants.X_OK);
      wrapperOk = true;
    } catch {
      wrapperOk = false;
    }
    add(
      wrapperOk
        ? { name: "pairing wrapper", status: "ok", detail: paths.pairWrapper }
        : { name: "pairing wrapper", status: "fail", detail: `${paths.pairWrapper} missing or not executable`, fix: SETUP },
    );
  }

  const opencode = opencodeConfigPath(sys);
  if (opencode) {
    try {
      const state = inspectOpencode(readText(opencode));
      add(
        state.entry
          ? { name: "opencode", status: "ok", detail: `tabcrew in ${opencode}` }
          : state.legacy
            ? { name: "opencode", status: "warn", detail: `only the old chromeuse entry in ${opencode}`, fix: SETUP }
            : { name: "opencode", status: "warn", detail: `no tabcrew entry in ${opencode}`, fix: SETUP },
      );
    } catch (err) {
      add({ name: "opencode", status: "warn", detail: (err as Error).message });
    }
  }
  const claude = sys.which("claude");
  if (claude) {
    add(
      (await claudeHasServer(sys, claude))
        ? { name: "claude code", status: "ok", detail: "tabcrew registered" }
        : { name: "claude code", status: "warn", detail: "tabcrew not registered", fix: SETUP },
    );
  }
  return checks;
}

const LABEL: Record<CheckStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export async function doctor(sys: System, opts: DoctorOptions): Promise<number> {
  const checks = await runChecks(sys, opts);
  for (const c of checks) {
    sys.out(`${LABEL[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && (c.status === "fail" || c.status === "warn")) sys.out(`     fix: ${c.fix}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  sys.out(failed === 0 ? "\nAll required checks passed." : `\n${failed} check(s) failed.`);
  return failed === 0 ? 0 : 1;
}
