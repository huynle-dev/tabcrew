import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Create `<home>` with mode 0700 (tightening it if it already exists). */
export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
}

export function tokenPath(home: string): string {
  return join(home, "token");
}

/** Read `<home>/token`, creating it (32 random bytes, base64url, mode 0600) on first use. */
export function ensureToken(home: string): string {
  ensureHome(home);
  const path = tokenPath(home);
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Constant-time string comparison (hashes first so lengths never leak through timing). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
