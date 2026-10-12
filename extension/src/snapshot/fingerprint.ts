/** JSON with object keys sorted at every level (undefined properties dropped, as JSON.stringify does). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** sha256 hex over the canonical JSON of `{url, text, actions, scroll}` (jev-ultrafast `fingerprint`). */
export async function fingerprint(state: { url: unknown; text: unknown; actions: unknown; scroll: unknown }): Promise<string> {
  const content = canonicalJson({ url: state.url, text: state.text, actions: state.actions, scroll: state.scroll });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
