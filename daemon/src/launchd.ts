import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LAUNCHD_LABEL = "com.chromeuse.daemon";

export interface LaunchdOptions {
  readonly home: string;
  readonly launchAgentsDir: string;
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly pathEnv: string;
  /** Set only when the user runs with a non-default CHROMEUSE_HOME. */
  readonly chromeuseHome?: string;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlist(opts: LaunchdOptions): string {
  const env: [string, string][] = [["PATH", opts.pathEnv]];
  if (opts.chromeuseHome) env.push(["CHROMEUSE_HOME", opts.chromeuseHome]);
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
  const path = join(opts.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
  writeFileSync(path, launchdPlist(opts), { mode: 0o644 });
  return path;
}
