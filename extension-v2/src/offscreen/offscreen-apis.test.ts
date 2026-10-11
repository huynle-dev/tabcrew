import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Offscreen documents only get chrome.runtime messaging; anything else throws at load time.
describe("offscreen document", () => {
  it("uses only chrome.runtime messaging APIs", () => {
    const src = readFileSync(new URL("./offscreen.ts", import.meta.url), "utf8") + readFileSync(new URL("./host.ts", import.meta.url), "utf8");
    const calls = [...src.matchAll(/chrome\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`);
    const allowed = new Set(["runtime.connect", "runtime.onMessage", "runtime.sendMessage", "runtime.id", "runtime.lastError"]);
    expect(calls.filter((c) => !allowed.has(c))).toEqual([]);
  });
});
