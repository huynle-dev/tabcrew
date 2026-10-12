import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHD_LABEL } from "@tabcrew/shared/product";

export { LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL } from "@tabcrew/shared/product";

/** Minimal PATH for the service: node and nothing else is needed. */
export const SERVICE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export interface LaunchdOptions {
  readonly home: string;
  readonly launchAgentsDir: string;
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly pathEnv: string;
  /** Set only when the home is not the default ~/.tabcrew. */
  readonly tabcrewHome?: string;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function plistPath(launchAgentsDir: string, label: string = LAUNCHD_LABEL): string {
  return join(launchAgentsDir, `${label}.plist`);
}

export function launchdPlist(opts: LaunchdOptions): string {
  const env: [string, string][] = [["PATH", opts.pathEnv]];
  if (opts.tabcrewHome) env.push(["TABCREW_HOME", opts.tabcrewHome]);
  const logs = join(opts.home, "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.nodePath)}</string>
    <string>${xml(opts.scriptPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(logs, "daemon.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

/** Write the LaunchAgent plist (never runs launchctl). Returns its path. */
export function writeLaunchdPlist(opts: LaunchdOptions): string {
  mkdirSync(join(opts.home, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(opts.launchAgentsDir, { recursive: true });
  const path = plistPath(opts.launchAgentsDir);
  writeFileSync(path, launchdPlist(opts), { mode: 0o644 });
  return path;
}

/**
 * Prefer a stable link (e.g. /opt/homebrew/bin/node) over process.execPath, which on Homebrew is a
 * versioned Cellar path that disappears on the next upgrade.
 */
export function stableNodePath(
  execPath: string = process.execPath,
  realpath: (p: string) => string = realpathSync,
  candidates: readonly string[] = ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
): string {
  const real = (p: string) => {
    try {
      return realpath(p);
    } catch {
      return null;
    }
  };
  const target = real(execPath);
  for (const candidate of candidates) {
    if (target && real(candidate) === target) return candidate;
  }
  return execPath;
}
