import { describe, expect, it } from "vitest";
import { v2GroupTitle, v2ParseGroupTitle, v2ReleasedGroupTitle } from "./v2.js";

describe("v2 group titles", () => {
  it("round-trips a session group title", () => {
    const ref = { short_id: "aaaa1111", label: "alice" };
    expect(v2ParseGroupTitle(v2GroupTitle(ref))).toEqual(ref);
  });

  it("a released title is ✓ <label> and never parses as a session group", () => {
    expect(v2ReleasedGroupTitle("alice")).toBe("✓ alice");
    expect(v2ParseGroupTitle(v2ReleasedGroupTitle("alice"))).toBeNull();
    // Even a label that looks like a full session title cannot be re-adopted.
    const tricky = v2ReleasedGroupTitle("bob · bbbb2222");
    expect(tricky.startsWith("✓ ")).toBe(true);
    expect(v2ParseGroupTitle(tricky)).toBeNull();
  });
});
