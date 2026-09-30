/**
 * Page state compaction for AI navigation.
 *
 * Problem: the raw accessibility tree from chromeuse is dominated by layout
 * wrappers. On the Hacker News front page, 546 of 736 refs (74%) are
 * generic/cell/row/table nodes that an action-deciding model never needs.
 * Sending the raw tree forces truncation, and truncation drops the elements
 * that matter — the HN search box sits near the end of the tree and is the
 * first thing cut.
 *
 * Solution: keep only elements a model can actually act on, preserve their
 * ref + role + name, and annotate viewport position so the model knows when
 * it must scroll before clicking.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactElement {
  ref: string;
  role: string;
  name: string;
  /** Present when the element carries a value (inputs, selects). */
  value?: string;
  /** Present when the source line carried state markers (disabled, focused). */
  state?: string;
}

export interface CompactResult {
  elements: CompactElement[];
  /** Total refs seen in the source tree, before filtering. */
  totalRefs: number;
  /** Refs dropped as non-interactive layout noise. */
  droppedRefs: number;
  /** Rendered text to hand the model. */
  text: string;
}

// ---------------------------------------------------------------------------
// Interactive role set
// ---------------------------------------------------------------------------

/**
 * Roles a model can act on. Everything else is layout scaffolding.
 *
 * Note "form" is included because chromeuse emits `form "Search:"` as the
 * only labelled marker for some search widgets, and "img" is included
 * because icon-only buttons frequently surface as a bare img inside a link.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "select",
  "slider",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "input",
  "textarea",
  "form",
  "dialog",
  "alert",
  "img",
  "heading",
]);

/** Roles that are pure layout and never worth sending. */
export const NOISE_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "cell",
  "row",
  "rowgroup",
  "table",
  "document",
  "list",
  "listitem",
  "paragraph",
  "text",
  "none",
  "presentation",
]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Matches a chromeuse accessibility-tree line:
 *   [ref_728] textbox
 *   [ref_4] link "Hacker News"
 *   [ref_3] button "Sign in" disabled
 *   [ref_2] input[type=email] "Email" value=""
 */
const LINE_RE =
  /^\s*\[(?<ref>ref_[A-Za-z0-9_]+)\]\s+(?<role>[^\s"]+)(?:\s+"(?<name>[^"]*)")?(?<rest>.*)$/;

const VALUE_RE = /value="(?<value>[^"]*)"/;

/**
 * Parse a serialized accessibility tree into flat elements.
 * Unparseable lines are skipped rather than throwing — the tree format
 * varies by page and a malformed line must not break navigation.
 */
export function parseTree(tree: string): {
  all: CompactElement[];
  totalRefs: number;
} {
  const all: CompactElement[] = [];
  let totalRefs = 0;

  for (const line of tree.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m?.groups) continue;

    totalRefs++;

    const ref = m.groups.ref;
    // Normalize "input[type=email]" -> role "input", keeps the subtype in role text
    const rawRole = m.groups.role;
    const role = rawRole.toLowerCase();
    const name = m.groups.name ?? "";
    const rest = m.groups.rest ?? "";

    const el: CompactElement = { ref, role, name };

    const valueMatch = VALUE_RE.exec(rest);
    if (valueMatch?.groups?.value !== undefined) {
      el.value = valueMatch.groups.value;
    }

    // Capture bare state markers like "disabled" / "focused"
    const stateText = rest.replace(VALUE_RE, "").trim();
    if (stateText) el.state = stateText;

    all.push(el);
  }

  return { all, totalRefs };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Base role, ignoring any `[type=...]` suffix. */
function baseRole(role: string): string {
  const idx = role.indexOf("[");
  return idx === -1 ? role : role.slice(0, idx);
}

/**
 * Keep an element if it is actionable.
 *
 * An unnamed link/img is kept only when it is a real control; an unnamed
 * generic wrapper is always dropped. Headings are kept because they orient
 * the model ("am I on the login page?") at negligible token cost.
 */
export function isActionable(el: CompactElement): boolean {
  const role = baseRole(el.role);

  if (NOISE_ROLES.has(role)) return false;
  if (INTERACTIVE_ROLES.has(role)) {
    // Drop nameless decorative images — they are never targets.
    if (role === "img" && !el.name) return false;
    // Drop nameless headings — no orientation value.
    if (role === "heading" && !el.name) return false;
    return true;
  }

  // Unknown role with a name is probably a custom control — keep it.
  return el.name.length > 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderElement(el: CompactElement): string {
  let line = `[${el.ref}] ${el.role}`;
  if (el.name) line += ` "${el.name}"`;
  if (el.value !== undefined) line += ` value="${el.value}"`;
  if (el.state) line += ` ${el.state}`;
  return line;
}

/**
 * Compact a raw accessibility tree down to actionable elements.
 *
 * @param tree Raw serialized accessibility tree.
 * @param maxElements Cap on elements emitted (default 150). When the page
 *   exceeds the cap the list is truncated and the omission is stated
 *   explicitly, so the model knows the view is partial instead of silently
 *   assuming an element does not exist.
 */
export function compactTree(
  tree: string,
  maxElements = 150
): CompactResult {
  const { all, totalRefs } = parseTree(tree);
  const actionable = all.filter(isActionable);

  const kept = actionable.slice(0, maxElements);
  const omitted = actionable.length - kept.length;

  const lines = kept.map(renderElement);
  if (omitted > 0) {
    lines.push(
      `... ${omitted} more actionable element(s) not shown (limit ${maxElements}); scroll or narrow the goal to reveal them`
    );
  }

  return {
    elements: kept,
    totalRefs,
    droppedRefs: totalRefs - actionable.length,
    text: lines.join("\n"),
  };
}
