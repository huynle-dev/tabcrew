import { describe, it, expect } from "vitest";
import {
  parseTree,
  compactTree,
  isActionable,
  INTERACTIVE_ROLES,
  NOISE_ROLES,
} from "./pageCompactor.js";

/**
 * Real excerpt captured from a live read_page call against
 * https://news.ycombinator.com — including the deeply nested layout
 * wrappers and the trailing search box that naive truncation drops.
 */
const LIVE_HN_TREE = `[ref_736] generic
  [ref_734] table
    [ref_733] rowgroup
      [ref_19] row
        [ref_18] cell "Hacker Newsnew | past | comments | ask | show | jobs | submit	login"
          [ref_17] table
            [ref_16] row
              [ref_3] cell
                [ref_2] link
                  [ref_1] img
              [ref_13] cell "Hacker Newsnew | past | comments"
                [ref_12] generic "| | | | | |"
                  [ref_4] link "Hacker News"
                  [ref_5] link "new"
                  [ref_6] link "past"
                  [ref_11] link "submit"
              [ref_15] cell "login"
                [ref_14] link "login"
      [ref_714] row
        [ref_713] cell "1.	EDG C++ front-end goes public"
          [ref_712] table
            [ref_711] rowgroup
              [ref_32] row
                [ref_22] cell "1."
                  [ref_21] generic "1."
                [ref_25] cell
                  [ref_24] link
                    [ref_23] generic "upvote"
                [ref_31] cell "EDG C++ front-end goes public (edgcpp.org)"
                  [ref_30] generic
                    [ref_26] link "EDG C++ front-end goes public"
                    [ref_29] generic "( )"
                      [ref_28] link "edgcpp.org"
                        [ref_27] generic "edgcpp.org"
              [ref_42] row
                [ref_33] cell
                [ref_41] cell "35 points by iandinwoodie 40 minutes ago"
                  [ref_40] generic "by | |"
                    [ref_34] generic "35 points"
                    [ref_35] link "iandinwoodie"
                    [ref_38] link "hide"
                    [ref_39] link "10 comments"
      [ref_732] row
        [ref_731] cell "Guidelines | FAQ | Lists | API"
          [ref_715] img
          [ref_730] generic
            [ref_727] generic "| | | | | | |"
              [ref_719] link "Guidelines"
              [ref_720] link "FAQ"
            [ref_729] form "Search:"
              [ref_728] textbox`;

describe("parseTree", () => {
  it("extracts every ref from the live HN tree", () => {
    const { all, totalRefs } = parseTree(LIVE_HN_TREE);
    expect(totalRefs).toBeGreaterThan(40);
    expect(all.length).toBe(totalRefs);
  });

  it("parses ref, role and name correctly", () => {
    const { all } = parseTree(`[ref_4] link "Hacker News"`);
    expect(all).toEqual([{ ref: "ref_4", role: "link", name: "Hacker News" }]);
  });

  it("parses a role with no name", () => {
    const { all } = parseTree(`[ref_728] textbox`);
    expect(all).toEqual([{ ref: "ref_728", role: "textbox", name: "" }]);
  });

  it("extracts value attributes", () => {
    const { all } = parseTree(`[ref_2] input[type=email] "Email" value="a@b.c"`);
    expect(all[0].value).toBe("a@b.c");
    expect(all[0].name).toBe("Email");
  });

  it("captures bare state markers like disabled", () => {
    const { all } = parseTree(`[ref_3] button "Sign in" disabled`);
    expect(all[0].state).toBe("disabled");
  });

  it("skips unparseable lines without throwing", () => {
    const { all, totalRefs } = parseTree("garbage\n\n[ref_1] link \"ok\"\n???");
    expect(totalRefs).toBe(1);
    expect(all[0].ref).toBe("ref_1");
  });
});

describe("isActionable", () => {
  it("keeps links, buttons and textboxes", () => {
    expect(isActionable({ ref: "r", role: "link", name: "Home" })).toBe(true);
    expect(isActionable({ ref: "r", role: "button", name: "Go" })).toBe(true);
    expect(isActionable({ ref: "r", role: "textbox", name: "" })).toBe(true);
  });

  it("drops layout wrappers", () => {
    for (const role of ["generic", "cell", "row", "rowgroup", "table"]) {
      expect(isActionable({ ref: "r", role, name: "anything" })).toBe(false);
    }
  });

  it("drops nameless decorative images", () => {
    expect(isActionable({ ref: "r", role: "img", name: "" })).toBe(false);
    expect(isActionable({ ref: "r", role: "img", name: "Logo" })).toBe(true);
  });

  it("handles input[type=...] subtypes", () => {
    expect(
      isActionable({ ref: "r", role: "input[type=email]", name: "Email" })
    ).toBe(true);
  });

  it("keeps unknown roles that carry a name", () => {
    expect(isActionable({ ref: "r", role: "custom-widget", name: "Pick" })).toBe(
      true
    );
    expect(isActionable({ ref: "r", role: "custom-widget", name: "" })).toBe(
      false
    );
  });

  it("has no overlap between interactive and noise role sets", () => {
    for (const role of INTERACTIVE_ROLES) {
      expect(NOISE_ROLES.has(role)).toBe(false);
    }
  });
});

describe("compactTree", () => {
  it("drops the majority of the live HN tree as noise", () => {
    const result = compactTree(LIVE_HN_TREE);
    // The live page is dominated by layout wrappers.
    expect(result.droppedRefs).toBeGreaterThan(result.elements.length);
  });

  it("PRESERVES the trailing search box that truncation would drop", () => {
    // This is the regression that broke the first live test: ref_728 sits at
    // the very end of the tree and was the first thing lost to truncation.
    const result = compactTree(LIVE_HN_TREE);
    const refs = result.elements.map((e) => e.ref);
    expect(refs).toContain("ref_728");
    expect(result.text).toContain("ref_728");
  });

  it("keeps the login link needed for auth goals", () => {
    const result = compactTree(LIVE_HN_TREE);
    expect(result.text).toContain('[ref_14] link "login"');
  });

  it("produces materially smaller output than the raw tree", () => {
    const result = compactTree(LIVE_HN_TREE);
    expect(result.text.length).toBeLessThan(LIVE_HN_TREE.length);
  });

  it("states omission explicitly instead of silently truncating", () => {
    const result = compactTree(LIVE_HN_TREE, 3);
    expect(result.elements.length).toBe(3);
    expect(result.text).toMatch(/more actionable element\(s\) not shown/);
  });

  it("does not claim omission when everything fits", () => {
    const result = compactTree(LIVE_HN_TREE, 500);
    expect(result.text).not.toMatch(/not shown/);
  });

  it("handles an empty tree without throwing", () => {
    const result = compactTree("");
    expect(result.elements).toEqual([]);
    expect(result.totalRefs).toBe(0);
    expect(result.text).toBe("");
  });
});
