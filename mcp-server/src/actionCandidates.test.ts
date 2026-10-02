import { describe, expect, it } from "vitest";
import { buildActionCandidates } from "./actionCandidates.js";
import type { CompactElement } from "./pageCompactor.js";

const elements: CompactElement[] = [
  { ref: "ref_1", role: "link", name: "Latest" },
  { ref: "ref_2", role: "button", name: "Search" },
  { ref: "ref_3", role: "searchbox", name: "Query" },
  { ref: "ref_4", role: "textbox", name: "Email" },
];

describe("buildActionCandidates", () => {
  it("builds deterministic opaque candidates from explicit verbatim values", () => {
    const input = {
      elements,
      goal: 'Search for "browser automation" and email user@example.com',
      context: "Use https://example.com/results and ticket 1234",
      history: [],
    };

    const first = buildActionCandidates(input);
    const second = buildActionCandidates(input);

    expect(second).toEqual(first);
    expect(first.candidates.map((candidate) => candidate.id)).toEqual(
      first.candidates.map((_, index) => `a${index.toString().padStart(3, "0")}`)
    );
    expect(first.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: { type: "click", ref: "ref_1" } }),
        expect.objectContaining({ action: { type: "click", ref: "ref_2" } }),
        expect.objectContaining({
          action: { type: "type", ref: "ref_3", value: "browser automation" },
        }),
        expect.objectContaining({
          action: { type: "type", ref: "ref_4", value: "user@example.com" },
        }),
        expect.objectContaining({
          action: { type: "navigate", url: "https://example.com/results" },
        }),
        expect.objectContaining({ action: { type: "scroll", direction: "up" } }),
        expect.objectContaining({ action: { type: "scroll", direction: "down" } }),
        expect.objectContaining({ action: { type: "wait" } }),
        expect.objectContaining({ action: { type: "done" } }),
        expect.objectContaining({ action: { type: "stop" } }),
      ])
    );
    expect(first.criteria).toEqual(
      Object.fromEntries(first.candidates.map(({ id, description }) => [id, description]))
    );
  });

  it("keeps a quoted URL eligible for navigate without changing it", () => {
    const result = buildActionCandidates({
      elements: [],
      goal: 'Open "https://example.com/path?q=exact"',
      history: [],
    });

    expect(result.candidates).toContainEqual(
      expect.objectContaining({
        action: { type: "navigate", url: "https://example.com/path?q=exact" },
      })
    );
  });

  it("does not infer an unquoted search phrase for a textbox", () => {
    const result = buildActionCandidates({
      elements: [{ ref: "ref_9", role: "textbox", name: "" }],
      goal: "Search for browser automation",
      history: [],
    });

    expect(result.candidates.some(({ action }) => action.type === "type")).toBe(false);
    expect(result.omitted).toContainEqual({
      reason: "explicit_value_required",
      ref: "ref_9",
    });
  });

  it("drops unavailable, malformed, and duplicate refs", () => {
    const result = buildActionCandidates({
      elements: [
        { ref: "bad", role: "button", name: "Bad" },
        { ref: "ref_1", role: "button", name: "Disabled", state: "disabled" },
        { ref: "ref_2", role: "link", name: "First" },
        { ref: "ref_2", role: "link", name: "Duplicate" },
      ],
      goal: "Open a link",
      history: [],
    });

    expect(result.candidates.filter(({ action }) => action.type === "click")).toEqual([
      expect.objectContaining({ action: { type: "click", ref: "ref_2" } }),
    ]);
    expect(result.omitted.map(({ reason }) => reason)).toEqual(
      expect.arrayContaining(["malformed_ref", "unavailable_element", "duplicate_ref"])
    );
  });

  it("never exceeds 255 choices and always retains bounded stop candidates", () => {
    const manyElements = Array.from({ length: 300 }, (_, index): CompactElement => ({
      ref: `ref_${index}`,
      role: "button",
      name: `Button ${index}`,
    }));

    const result = buildActionCandidates({
      elements: manyElements,
      goal: "Choose a button",
      history: [],
    });

    expect(result.candidates).toHaveLength(255);
    expect(result.candidates.at(-1)?.action).toEqual({ type: "stop" });
    expect(result.omitted.some(({ reason }) => reason.startsWith("candidate_limit:"))).toBe(true);
  });

  it("does not let textbox value combinations evict later clickable controls", () => {
    const crowdedPage: CompactElement[] = [
      { ref: "ref_1", role: "textbox", name: "First" },
      { ref: "ref_2", role: "textbox", name: "Second" },
      ...Array.from({ length: 147 }, (_, index): CompactElement => ({
        ref: `ref_${index + 3}`,
        role: "heading",
        name: `Heading ${index}`,
      })),
      { ref: "ref_150", role: "button", name: "Submit" },
    ];

    const result = buildActionCandidates({
      elements: crowdedPage,
      goal: "Submit the form",
      history: [],
    });

    expect(result.candidates).toContainEqual(
      expect.objectContaining({ action: { type: "click", ref: "ref_150" } })
    );
    expect(result.candidates.length).toBeLessThanOrEqual(255);
  });

  it("distributes type candidates across all visible fields before adding alternatives", () => {
    const fields = Array.from({ length: 150 }, (_, index): CompactElement => ({
      ref: `ref_${index + 1}`,
      role: "textbox",
      name: `Field ${index + 1}`,
    }));
    const context = JSON.stringify(
      Array.from({ length: 64 }, (_, index) => `value-${index + 1}`)
    );

    const result = buildActionCandidates({
      elements: fields,
      goal: "Fill the form",
      context,
      history: [],
    });

    expect(result.candidates).toContainEqual(
      expect.objectContaining({
        action: { type: "type", ref: "ref_150", value: "value-1" },
      })
    );
  });

  it("bounds candidate descriptions derived from accessible labels", () => {
    const result = buildActionCandidates({
      elements: [{ ref: "ref_1", role: "button", name: "x".repeat(100_000) }],
      goal: "Click the button",
      history: [],
    });

    expect(Math.max(...Object.values(result.criteria).map((value) => value.length)))
      .toBeLessThanOrEqual(500);
  });

  it("offers Enter only after explicit typing or submission semantics", () => {
    const afterTyping = buildActionCandidates({
      elements: [],
      goal: "Continue",
      history: [{ type: "type", ref: "ref_1", value: "exact" }],
    });
    const noTyping = buildActionCandidates({ elements: [], goal: "Continue", history: [] });

    expect(afterTyping.candidates).toContainEqual(
      expect.objectContaining({ action: { type: "key", key: "Enter" } })
    );
    expect(noTyping.candidates.some(({ action }) => action.type === "key")).toBe(false);
  });
});
