import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { System } from "./system.js";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const KEY_NAME = "OPENROUTER_API_KEY";

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  return v;
}

/** A variable from a KEY=VALUE env file (undefined if absent or blank). */
export function readEnvFileValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (m && m[1] === key) {
      const value = unquote(m[2]);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/** Set (or replace) `key` in the env file, keeping other lines; the file ends up mode 0600. */
export function upsertEnvFileValue(path: string, key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line`);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  let replaced = false;
  const next = lines.map((raw) => {
    const m = LINE.exec(raw.trim());
    if (m && m[1] === key) {
      replaced = true;
      return `${key}=${value}`;
    }
    return raw;
  });
  if (!replaced) next.push(`${key}=${value}`);
  writeFileSync(path, `${next.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export type KeyCheck = "valid" | "invalid" | "unreachable";

/** Free check of an OpenRouter key (GET /api/v1/key). Never logs the key. */
export async function validateOpenRouterKey(sys: Pick<System, "fetch">, key: string): Promise<KeyCheck> {
  try {
    const res = await sys.fetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "valid";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
