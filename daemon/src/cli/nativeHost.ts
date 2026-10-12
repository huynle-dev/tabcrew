import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { NATIVE_HOST_NAME, tabcrewExtensionOrigins } from "@tabcrew/shared/product";
import { nativeHostDirs, type BrowserHostDir } from "./paths.js";
import type { System } from "./system.js";

export interface NativeHostManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly string[];
}

export function nativeHostManifest(wrapperPath: string, origins: readonly string[] = tabcrewExtensionOrigins()): NativeHostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: "TabCrew pairing: gives the TabCrew extension the local daemon token",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [...origins],
  };
}

/** Browsers whose host manifest setup writes: Chrome always, the others only if installed. */
export function targetHostDirs(sys: Pick<System, "platform" | "homedir">): BrowserHostDir[] {
  return nativeHostDirs(sys).filter((d) => d.always || existsSync(d.parent));
}

export function writeNativeHostManifests(sys: Pick<System, "platform" | "homedir">, wrapperPath: string): BrowserHostDir[] {
  const written: BrowserHostDir[] = [];
  const body = `${JSON.stringify(nativeHostManifest(wrapperPath), null, 2)}\n`;
  for (const target of targetHostDirs(sys)) {
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.manifest, body, { mode: 0o644 });
    written.push(target);
  }
  return written;
}

/** Remove our manifest from every browser directory. Returns the removed paths. */
export function removeNativeHostManifests(sys: Pick<System, "platform" | "homedir">): string[] {
  const removed: string[] = [];
  for (const target of nativeHostDirs(sys)) {
    if (existsSync(target.manifest)) {
      rmSync(target.manifest, { force: true });
      removed.push(target.manifest);
    }
  }
  return removed;
}

/** Problems with an installed manifest (empty = fine). */
export function checkNativeHostManifest(manifestPath: string, wrapperPath: string): string[] {
  if (!existsSync(manifestPath)) return ["missing"];
  let parsed: Partial<NativeHostManifest>;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<NativeHostManifest>;
  } catch {
    return ["not valid JSON"];
  }
  const problems: string[] = [];
  const expected = nativeHostManifest(wrapperPath);
  if (parsed.name !== expected.name) problems.push("wrong name");
  if (parsed.type !== "stdio") problems.push("type is not stdio");
  if (parsed.path !== wrapperPath) problems.push(`path is ${String(parsed.path)}, expected ${wrapperPath}`);
  const origins = Array.isArray(parsed.allowed_origins) ? [...parsed.allowed_origins].sort() : [];
  if (JSON.stringify(origins) !== JSON.stringify([...expected.allowed_origins].sort())) problems.push("allowed_origins out of date");
  return problems;
}
