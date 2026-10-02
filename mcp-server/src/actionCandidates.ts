import type { ActionCandidate, BrowserAction } from "./decisionTypes.js";
import type { CompactElement } from "./pageCompactor.js";

export interface CandidateSet {
  candidates: ActionCandidate[];
  criteria: Record<string, string>;
  explicitValues: Array<{ value: string; source: string }>;
  omitted: Array<{ reason: string; ref?: string }>;
}

export interface CandidateBuilderInput {
  elements: CompactElement[];
  goal: string;
  context?: string;
  history?: BrowserAction[];
}

const MAX_CANDIDATES = 255;
const TERMINAL_CANDIDATES = 5;
const MAX_EXECUTABLE_CANDIDATES = MAX_CANDIDATES - TERMINAL_CANDIDATES;
const MAX_EXPLICIT_VALUES = 64;
const MAX_VALUE_SOURCE_CHARS = 8000;
const VALID_REF = /^ref_[A-Za-z0-9_]+$/;
const TEXT_ROLES = new Set(["textbox", "searchbox", "input", "textarea"]);

export function buildActionCandidates(input: CandidateBuilderInput): CandidateSet {
  const omitted: CandidateSet["omitted"] = [];
  const explicitValues = extractExplicitValues(input);
  const proposed: Array<{ description: string; action: BrowserAction }> = [];
  const seenRefs = new Set<string>();
  const availableElements: CompactElement[] = [];
  let droppedCandidates = 0;
  const propose = (candidate: { description: string; action: BrowserAction }) => {
    if (proposed.length < MAX_EXECUTABLE_CANDIDATES) {
      proposed.push(candidate);
    } else {
      droppedCandidates++;
    }
  };

  for (const element of input.elements) {
    if (!VALID_REF.test(element.ref)) {
      omitted.push({ reason: "malformed_ref", ref: element.ref });
      continue;
    }
    if (seenRefs.has(element.ref)) {
      omitted.push({ reason: "duplicate_ref", ref: element.ref });
      continue;
    }
    seenRefs.add(element.ref);

    const state = element.state?.toLowerCase() ?? "";
    if (/\b(disabled|hidden|stale)\b/.test(state)) {
      omitted.push({ reason: "unavailable_element", ref: element.ref });
      continue;
    }

    availableElements.push(element);
  }

  for (const element of availableElements) {
    const role = baseRole(element.role);
    const label = boundedText(element.name || role);
    if (role === "link" || role === "button") {
      propose({
        description: `Click the ${role} named ${JSON.stringify(label)} at ${element.ref}`,
        action: { type: "click", ref: element.ref },
      });
    }
  }

  for (const explicit of explicitValues) {
    if (explicit.kind !== "url") continue;
    propose({
      description: `Navigate to the explicit URL ${explicit.value}`,
      action: { type: "navigate", url: explicit.value },
    });
  }

  const offerEnter =
    input.history?.at(-1)?.type === "type" ||
    input.elements.some((element) =>
      /\b(submit|search|go|continue|next|sign in|log in)\b/i.test(element.name)
    );
  if (offerEnter) {
    propose({
      description: "Press Enter to submit the current focused form control",
      action: { type: "key", key: "Enter" },
    });
  }

  const textElements = availableElements.filter((element) =>
    TEXT_ROLES.has(baseRole(element.role))
  );
  if (explicitValues.length === 0) {
    for (const element of textElements) {
      omitted.push({ reason: "explicit_value_required", ref: element.ref });
    }
  } else {
    for (const explicit of explicitValues) {
      for (const element of textElements) {
        const role = baseRole(element.role);
        const label = boundedText(element.name || role);
        propose({
          description:
            `Type the verbatim ${explicit.source} value ${JSON.stringify(explicit.value)} ` +
            `into the ${role} named ${JSON.stringify(label)} at ${element.ref}`,
          action: { type: "type", ref: element.ref, value: explicit.value },
        });
      }
    }
  }

  const globals: Array<{ description: string; action: BrowserAction }> = [
    { description: "Scroll up to reveal earlier page content", action: { type: "scroll", direction: "up" } },
    { description: "Scroll down to reveal later page content", action: { type: "scroll", direction: "down" } },
    { description: "Wait briefly for the current page to settle", action: { type: "wait" } },
    { description: "The goal is complete on the current page", action: { type: "done" } },
    { description: "Stop because no safe supplied action is available", action: { type: "stop" } },
  ];

  const unique = deduplicateActions(proposed);
  if (droppedCandidates > 0) {
    omitted.push({ reason: `candidate_limit:${droppedCandidates}` });
  }
  const selected = [...unique, ...globals];
  const candidates = selected.map((candidate, index): ActionCandidate => ({
    id: `a${index.toString().padStart(3, "0")}`,
    ...candidate,
  }));

  return {
    candidates,
    criteria: Object.fromEntries(
      candidates.map(({ id, description }) => [id, description])
    ),
    explicitValues: explicitValues.map(({ value, source }) => ({ value, source })),
    omitted,
  };
}

interface InternalExplicitValue {
  value: string;
  source: string;
  kind: "text" | "url" | "email" | "number" | "page";
}

function extractExplicitValues(input: CandidateBuilderInput): InternalExplicitValue[] {
  const values: InternalExplicitValue[] = [];
  collectTextValues(input.goal.slice(0, MAX_VALUE_SOURCE_CHARS), "goal", values);
  if (input.context) {
    const boundedContext = input.context.slice(0, MAX_VALUE_SOURCE_CHARS);
    collectStructuredContext(boundedContext, values);
    collectTextValues(boundedContext, "context", values);
  }
  for (const element of input.elements) {
    if (element.name && !TEXT_ROLES.has(baseRole(element.role))) {
      addValue(values, element.name, "page text", "page");
    }
    if (element.value) addValue(values, element.value, "page value", "page");
  }
  return values;
}

function collectTextValues(
  text: string,
  source: string,
  values: InternalExplicitValue[]
): void {
  for (const match of text.matchAll(/(["'`])([^\n\r]{1,200}?)\1/g)) {
    addValue(values, match[2], `${source} quote`, "text");
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
    addValue(values, trimTrailingPunctuation(match[0]), `${source} URL`, "url");
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    addValue(values, match[0], `${source} email`, "email");
  }
  for (const match of text.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)) {
    addValue(values, match[0], `${source} number`, "number");
  }
}

function collectStructuredContext(
  context: string,
  values: InternalExplicitValue[]
): void {
  try {
    const parsed = JSON.parse(context) as unknown;
    collectJsonStrings(parsed, values);
  } catch {
    // Plain context is handled by conservative token extraction above.
  }
}

function collectJsonStrings(value: unknown, values: InternalExplicitValue[]): void {
  if (typeof value === "string") {
    const kind = /^https?:\/\//i.test(value) ? "url" : "text";
    addValue(values, value, "structured context", kind);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, values);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectJsonStrings(item, values);
  }
}

function addValue(
  values: InternalExplicitValue[],
  raw: string,
  source: string,
  kind: InternalExplicitValue["kind"]
): void {
  if (values.length >= MAX_EXPLICIT_VALUES) return;
  const value = raw.trim();
  if (!value || value.length > 200) return;
  const existing = values.find((entry) => entry.value === value);
  if (existing) {
    if (kind === "url") {
      existing.kind = "url";
      existing.source = source;
    }
    return;
  }
  values.push({ value, source, kind });
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/, "");
}

function boundedText(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

function deduplicateActions(
  candidates: Array<{ description: string; action: BrowserAction }>
): Array<{ description: string; action: BrowserAction }> {
  const seen = new Set<string>();
  return candidates.filter(({ action }) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function baseRole(role: string): string {
  const index = role.indexOf("[");
  return (index === -1 ? role : role.slice(0, index)).toLowerCase();
}
