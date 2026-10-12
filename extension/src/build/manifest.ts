/** Produces the shipped manifest from manifest.json: dev builds get the public `key`, store builds must not. */
export type ManifestTarget = { kind: "dev"; key: string } | { kind: "store" };

export function buildManifest(source: Record<string, unknown>, target: ManifestTarget): Record<string, unknown> {
  const { key: _ignored, ...rest } = source;
  return target.kind === "dev" ? { ...rest, key: target.key } : rest;
}
