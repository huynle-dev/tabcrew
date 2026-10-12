import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TABCREW_EXTENSION_IDS } from "@tabcrew/shared/product";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest.js";

const source = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
const devKey = readFileSync(new URL("../../dev-key.pub", import.meta.url), "utf8").trim();

function extensionId(base64Spki: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Spki, "base64")).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

describe("extension manifest", () => {
  it("is TabCrew, asks for nativeMessaging and does not imply Google endorsement", () => {
    expect(source.name).toBe("TabCrew");
    expect(source.permissions).toContain("nativeMessaging");
    expect(String(source.description)).not.toMatch(/chrome|google/i);
    expect(source.key).toBeUndefined();
  });

  it("dev builds carry the public key whose ID is the dev ID the pairing host allows", () => {
    const dev = buildManifest(source, { kind: "dev", key: devKey });
    expect(dev.key).toBe(devKey);
    expect(dev.permissions).toContain("nativeMessaging");
    expect(extensionId(String(dev.key))).toBe(TABCREW_EXTENSION_IDS.dev);
  });

  it("store builds have no key", () => {
    const store = buildManifest({ ...source, key: "stray" }, { kind: "store" });
    expect("key" in store).toBe(false);
    expect(store.permissions).toContain("nativeMessaging");
    expect(store.version).toBe(source.version);
  });
});
