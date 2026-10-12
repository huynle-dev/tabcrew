import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

/** Old ChromeUse names still read (deprecated) when the TabCrew one is unset. */
export const LEGACY_ENV_PREFIX = "CHROMEUSE_";
export const ENV_PREFIX = "TABCREW_";

/**
 * Read `TABCREW_<name>`, falling back to the deprecated `CHROMEUSE_<name>`. Blank values count as unset.
 * Returns the value and the variable it came from (for error messages).
 */
export function productEnv(env: Env, name: string): { value: string; from: string } | undefined {
  for (const key of [`${ENV_PREFIX}${name}`, `${LEGACY_ENV_PREFIX}${name}`]) {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== "") return { value: raw.trim(), from: key };
  }
  return undefined;
}

export function defaultHome(home: string = homedir()): string {
  return join(home, ".tabcrew");
}

export function legacyHome(home: string = homedir()): string {
  return join(home, ".chromeuse");
}

/** `$TABCREW_HOME`, else the deprecated `$CHROMEUSE_HOME`, else `~/.tabcrew`. */
export function resolveHome(env: Env = process.env, userHome: string = homedir()): string {
  const fromEnv = productEnv(env, "HOME");
  return fromEnv ? resolve(fromEnv.value) : defaultHome(userHome);
}

export type MigrationResult =
  | { readonly status: "none" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "migrated"; readonly moved: readonly string[]; readonly backup?: string };

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a ChromeUse home (`legacy`, e.g. ~/.chromeuse) into the TabCrew home (`home`) and leave a
 * symlink `legacy -> home` so anything still pointing at the old path keeps working.
 *
 * Runs only when `home` does not exist yet and `legacy` is a real directory. Entries are first moved
 * into `<home>.migrating` (renames, so modes are preserved) and that directory is then renamed to
 * `home`, so an interrupted run resumes on the next call. Nothing in `home` is ever overwritten; an
 * entry that cannot be moved stays behind in a `<legacy>.bak-<time>` directory instead of being deleted.
 */
export function migrateLegacyHome(home: string, legacy: string, now: () => Date = () => new Date()): MigrationResult {
  if (resolve(home) === resolve(legacy)) return { status: "none" };
  if (!lexists(legacy)) return { status: "none" };
  const legacyStat = lstatSync(legacy);
  if (legacyStat.isSymbolicLink()) return { status: "none" };
  if (!legacyStat.isDirectory()) return { status: "skipped", reason: `${legacy} is not a directory` };
  if (lexists(home)) return { status: "skipped", reason: `${home} already exists` };

  const staging = `${home}.migrating`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(staging, 0o700);
  const moved: string[] = [];
  for (const name of readdirSync(legacy)) {
    const target = join(staging, name);
    if (lexists(target)) continue;
    renameSync(join(legacy, name), target);
    moved.push(name);
  }
  renameSync(staging, home);

  let backup: string | undefined;
  const left = readdirSync(legacy).filter((name) => name !== ".DS_Store");
  if (left.length === 0) {
    // Only Finder metadata is left.
    for (const name of readdirSync(legacy)) unlinkSync(join(legacy, name));
    rmdirSync(legacy);
  } else {
    backup = `${legacy}.bak-${now().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(legacy, backup);
  }
  symlinkSync(home, legacy);
  return backup ? { status: "migrated", moved, backup } : { status: "migrated", moved };
}

/** Migrate only when `home` is the default TabCrew home (custom homes are left alone). */
export function migrateDefaultHome(home: string, userHome: string = homedir()): MigrationResult {
  if (resolve(home) !== defaultHome(userHome)) return { status: "none" };
  return migrateLegacyHome(home, legacyHome(userHome));
}
