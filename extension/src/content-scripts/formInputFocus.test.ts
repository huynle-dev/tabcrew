import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./accessibilityTree.ts", import.meta.url)),
  "utf8",
);
const FALLBACK_SOURCE = readFileSync(
  fileURLToPath(
    new URL("../service-worker/tools/formInput.ts", import.meta.url),
  ),
  "utf8",
);

describe("form input focus", () => {
  it("focuses the target before setting its value", () => {
    const setter = SOURCE.slice(
      SOURCE.indexOf("function setFormElementValue"),
      SOURCE.indexOf("// --- Message Listener ---"),
    );

    expect(setter).toMatch(/el\.focus\(\)/);
    expect(setter.indexOf("el.focus()")).toBeLessThan(
      setter.indexOf("if (el instanceof HTMLInputElement)"),
    );
  });

  it("focuses the target in the scripting fallback", () => {
    const fallback = FALLBACK_SOURCE.slice(
      FALLBACK_SOURCE.indexOf("const el = findByRef"),
      FALLBACK_SOURCE.indexOf("const tagName = el.tagName"),
    );

    expect(fallback).toMatch(/el\.focus\(\)/);
  });
});
