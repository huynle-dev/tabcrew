/**
 * find tool — search for elements on a page using natural language descriptions.
 *
 * Queries the accessibility tree built by the content script and matches
 * elements against a natural language query by comparing role, name, and label
 * using case-insensitive substring and word-overlap scoring.
 *
 * Returns matching elements with their refs (ref_N), roles, names, and bounding
 * rects so the caller can target them with other tools (click, form_input).
 *
 * Args:
 *   tabId  (number, required): The tab to search in.
 *   query  (string, required): Natural language description of the element(s).
 *   maxResults (number, optional): Maximum results to return (default 5).
 */

import type {
  ToolHandler,
  ToolResult,
  ToolContext,
} from "../../types/messages.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An element match from the accessibility tree search */
interface ElementMatch {
  ref: string;
  role: string;
  name: string;
  score: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

/** A11y tree node shape returned by the content script */
interface A11yNode {
  role: string;
  name: string;
  ref: string;
  value?: string;
  state?: string[];
  children?: A11yNode[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 5;

/**
 * Common role aliases. Maps canonical a11y roles to query words that users
 * are likely to type when looking for that kind of element.
 */
const ROLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  button: ["button", "btn", "submit"],
  textbox: ["input", "textbox", "text", "field", "entry"],
  searchbox: ["search", "searchbox", "search bar"],
  combobox: ["select", "dropdown", "combobox", "combo"],
  checkbox: ["checkbox", "check", "toggle"],
  radio: ["radio", "option"],
  link: ["link", "anchor", "href"],
  heading: ["heading", "header", "title", "h1", "h2", "h3", "h4", "h5", "h6"],
  navigation: ["nav", "navigation", "menu"],
  img: ["image", "img", "picture", "photo", "icon"],
  dialog: ["dialog", "modal", "popup"],
  tab: ["tab"],
  slider: ["slider", "range"],
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute a relevance score between a query and an a11y node.
 * Higher score = better match. 0 = no match.
 *
 * Scoring breakdown:
 *   - Exact name match:            +10
 *   - Name contains entire query:  +5
 *   - Query contains entire name:  +4
 *   - Per query-word in name:      +2 each
 *   - Direct role-word match:      +3
 *   - Alias-based role match:      +3
 *   - Role alias bonus:            +2
 *   - Value match:                 +1
 */
export function computeScore(query: string, node: A11yNode): number {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);
  const nameLower = node.name.toLowerCase();
  const roleLower = node.role.toLowerCase();

  let score = 0;

  // --- Name matching ---
  if (nameLower === queryLower) {
    score += 10;
  } else if (nameLower.includes(queryLower)) {
    score += 5;
  } else if (queryLower.includes(nameLower) && nameLower.length > 0) {
    score += 4;
  }

  for (const word of queryWords) {
    if (nameLower.includes(word)) {
      score += 2;
    }
  }

  // --- Role matching ---
  if (queryWords.includes(roleLower)) {
    score += 3;
  }

  const roleAliases = ROLE_ALIASES[roleLower] ?? [];
  for (const word of queryWords) {
    if (roleAliases.includes(word)) {
      score += 3;
      break;
    }
  }

  // Bonus when a query word appears in the aliases list for the node's role
  for (const [role, aliases] of Object.entries(ROLE_ALIASES)) {
    if (roleLower === role) {
      for (const word of queryWords) {
        if (aliases.includes(word)) {
          score += 2;
          break;
        }
      }
    }
  }

  // --- Value matching ---
  if (node.value) {
    const valueLower = node.value.toLowerCase();
    if (valueLower.includes(queryLower) || queryLower.includes(valueLower)) {
      score += 1;
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/**
 * Flatten an a11y tree into a list of nodes, recursively.
 * Skips generic container nodes with no name.
 */
export function flattenTree(node: A11yNode): A11yNode[] {
  const result: A11yNode[] = [];

  if (node.role !== "generic" || node.name) {
    result.push(node);
  }

  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenTree(child));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export class FindTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    try {
      // --- Validate args ---
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      if (tabId === undefined) {
        return {
          success: false,
          content: [
            { type: "text", text: "Missing required argument: tabId (number)" },
          ],
        };
      }

      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: "Missing required argument: query (string)",
            },
          ],
        };
      }

      const maxResults =
        typeof args.maxResults === "number" && args.maxResults > 0
          ? args.maxResults
          : DEFAULT_MAX_RESULTS;

      // --- Verify tab exists ---
      try {
        await chrome.tabs.get(tabId);
      } catch {
        return {
          success: false,
          content: [{ type: "text", text: `Tab ${tabId} not found` }],
        };
      }

      // --- Get a11y tree from content script ---
      const tree = await this.getA11yTree(tabId);
      if (!tree) {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: "Failed to get accessibility tree. The page may not be loaded yet.",
            },
          ],
        };
      }

      // --- Score and rank ---
      const nodes = flattenTree(tree);
      const matches: ElementMatch[] = [];

      for (const node of nodes) {
        const s = computeScore(query, node);
        if (s > 0) {
          matches.push({
            ref: node.ref,
            role: node.role,
            name: node.name,
            score: s,
          });
        }
      }

      matches.sort((a, b) => b.score - a.score);
      const topMatches = matches.slice(0, maxResults);

      if (topMatches.length === 0) {
        return {
          success: true,
          content: [
            { type: "text", text: `No elements found matching: "${query}"` },
          ],
        };
      }

      // --- Fetch bounding rects for top matches ---
      for (const match of topMatches) {
        try {
          const response = (await chrome.tabs.sendMessage(tabId, {
            action: "find_by_ref",
            ref: match.ref,
          })) as {
            success: boolean;
            bounds?: { x: number; y: number; width: number; height: number };
          };

          if (response?.success && response.bounds) {
            match.bounds = response.bounds;
          }
        } catch {
          // Bounds are optional — ignore failures
        }
      }

      // --- Format output ---
      const results = topMatches.map((m) => ({
        ref: m.ref,
        role: m.role,
        name: m.name,
        ...(m.bounds ? { bounds: m.bounds } : {}),
      }));

      return {
        success: true,
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `find failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Get the structured a11y tree from the content script.
   * Tries direct message first, falls back to scripting injection.
   */
  private async getA11yTree(tabId: number): Promise<A11yNode | null> {
    try {
      const response = (await chrome.tabs.sendMessage(tabId, {
        action: "get_accessibility_tree",
        format: "json",
      })) as {
        success: boolean;
        data?: string;
        tree?: A11yNode;
        error?: string;
      };

      if (response?.success && response.tree) {
        return response.tree;
      }

      // Content script may only return serialized text — fall back
      return this.buildTreeViaScripting(tabId);
    } catch {
      return this.buildTreeViaScripting(tabId);
    }
  }

  /**
   * Build the tree by injecting a script that walks the DOM and collects
   * ref-tagged elements with their a11y info.
   */
  private async buildTreeViaScripting(
    tabId: number,
  ): Promise<A11yNode | null> {
    try {
      // Ensure content script is loaded
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["dist/content-scripts/accessibilityTree.js"],
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        // Content script may already be loaded
      }

      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const REF_PROP = "__opencode_ref";

          interface TreeNode {
            role: string;
            name: string;
            ref: string;
            value?: string;
            state?: string[];
            children?: TreeNode[];
          }

          function collectRefNodes(el: Element): TreeNode[] {
            const nodes: TreeNode[] = [];
            const ref = (el as unknown as Record<string, string>)[REF_PROP];

            if (ref) {
              const role =
                el.getAttribute("role") ?? el.tagName.toLowerCase();
              const name =
                el.getAttribute("aria-label") ??
                el.getAttribute("title") ??
                el.getAttribute("alt") ??
                el.getAttribute("placeholder") ??
                (el as HTMLElement).innerText?.trim().slice(0, 80) ??
                "";

              const node: TreeNode = { role, name, ref };

              // Form element values
              if (el instanceof HTMLInputElement) {
                if (el.type === "checkbox" || el.type === "radio") {
                  node.value = el.checked ? "true" : "false";
                } else if (el.type !== "hidden") {
                  node.value = el.value || undefined;
                }
              } else if (el instanceof HTMLTextAreaElement) {
                node.value = el.value || undefined;
              } else if (el instanceof HTMLSelectElement) {
                node.value =
                  el.options[el.selectedIndex]?.text ||
                  el.value ||
                  undefined;
              }

              nodes.push(node);
            }

            for (let i = 0; i < el.children.length; i++) {
              nodes.push(...collectRefNodes(el.children[i]));
            }

            return nodes;
          }

          if (!document.body) return null;

          const nodes = collectRefNodes(document.body);

          return {
            role: "document",
            name: document.title || "",
            ref: "ref_root",
            children: nodes,
          } as TreeNode;
        },
      });

      return (result?.result as A11yNode) ?? null;
    } catch {
      return null;
    }
  }
}
