import { join } from "node:path";
import { LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL, NATIVE_HOST_NAME } from "@tabcrew/shared/product";
import { defaultHome, legacyHome, resolveHome } from "../home.js";
import { plistPath } from "../launchd.js";
import type { System } from "./system.js";

export interface TabCrewPaths {
  readonly home: string;
  /** True when home is ~/.tabcrew (not overridden by TABCREW_HOME). */
  readonly isDefaultHome: boolean;
  readonly legacyHome: string;
  readonly app: string;
  readonly token: string;
  readonly envFile: string;
  readonly logs: string;
  readonly installedDaemon: string;
  readonly installedPairHost: string;
  /** Executable wrapper Chrome launches (absolute node + pair-host.mjs). */
  readonly pairWrapper: string;
  readonly launchAgents: string;
  readonly plist: string;
  readonly legacyPlist: string;
}

export function tabcrewPaths(sys: Pick<System, "env" | "homedir">): TabCrewPaths {
  const home = resolveHome(sys.env, sys.homedir);
  const app = join(home, "app");
  const launchAgents = join(sys.homedir, "Library", "LaunchAgents");
  return {
    home,
    isDefaultHome: home === defaultHome(sys.homedir),
    legacyHome: legacyHome(sys.homedir),
    app,
    token: join(home, "token"),
    envFile: join(home, "env"),
    logs: join(home, "logs"),
    installedDaemon: join(app, "daemon.mjs"),
    installedPairHost: join(app, "pair-host.mjs"),
    pairWrapper: join(app, "pair-host"),
    launchAgents,
    plist: plistPath(launchAgents, LAUNCHD_LABEL),
    legacyPlist: plistPath(launchAgents, LEGACY_LAUNCHD_LABEL),
  };
}

export interface BrowserHostDir {
  readonly browser: string;
  /** The browser's user-data directory; the host dir is only written if this exists (or `always`). */
  readonly parent: string;
  readonly dir: string;
  readonly manifest: string;
  readonly always: boolean;
}

/** Per-user NativeMessagingHosts directories of Chromium-based browsers. */
export function nativeHostDirs(sys: Pick<System, "platform" | "homedir">): BrowserHostDir[] {
  let browsers: [string, string[], boolean][];
  if (sys.platform === "darwin") {
    const support = join(sys.homedir, "Library", "Application Support");
    browsers = [
      ["Google Chrome", [support, "Google", "Chrome"], true],
      ["Chromium", [support, "Chromium"], false],
      ["Brave", [support, "BraveSoftware", "Brave-Browser"], false],
      ["Microsoft Edge", [support, "Microsoft Edge"], false],
    ];
  } else if (sys.platform === "linux") {
    const config = join(sys.homedir, ".config");
    browsers = [
      ["Google Chrome", [config, "google-chrome"], true],
      ["Chromium", [config, "chromium"], false],
      ["Brave", [config, "BraveSoftware", "Brave-Browser"], false],
      ["Microsoft Edge", [config, "microsoft-edge"], false],
    ];
  } else {
    return [];
  }
  return browsers.map(([browser, parts, always]) => {
    const parent = join(...parts);
    const dir = join(parent, "NativeMessagingHosts");
    return { browser, parent, dir, manifest: join(dir, `${NATIVE_HOST_NAME}.json`), always };
  });
}
