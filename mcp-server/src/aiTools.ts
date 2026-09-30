/**
 * AI-powered MCP tools for ChromeUse.
 *
 * These tools run in the MCP server process and compose existing browser
 * tools with AI inference (via OpenRouter / Jev Router) to provide
 * higher-level automation capabilities:
 *
 *   ai_action   — Given page state, suggest the next browser action as JSON.
 *   ai_assert   — Assert a condition about the page using natural language.
 *
 * These tools are only registered when CHROMEUSE_AI_API_KEY is set.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AiProvider } from "./aiProvider.js";
import type { BrowserTransport, ToolRequestResult } from "./transport.js";

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const AI_TOOL_NAMES = {
  /** Given page state, return a structured next-action recommendation */
  AI_ACTION: "ai_action",
  /** Assert a natural-language condition about the current page */
  AI_ASSERT: "ai_assert",
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const AI_TOOL_SCHEMAS: Tool[] = [
  {
    name: AI_TOOL_NAMES.AI_ACTION,
    description:
      "Given a page's current state, use AI to recommend the next browser action. " +
      "Reads the page accessibility tree or text automatically, sends it to an AI model, " +
      "and returns a structured JSON action: { thought, action, ref, value, url, direction }. " +
      "The AI sees the full page context and returns the most logical next step toward the goal. " +
      "Requires CHROMEUSE_AI_API_KEY to be set.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        goal: {
          type: "string",
          description:
            'What you want to accomplish (e.g. "log in with user@test.com", "find the pricing page")',
        },
        context: {
          type: "string",
          description:
            "Optional additional context about what has been done so far",
        },
        pageContent: {
          type: "string",
          description:
            "Optional pre-fetched page content (accessibility tree or text). " +
            "If not provided, the tool will fetch the accessibility tree automatically.",
        },
      },
      required: ["tabId", "goal"],
    },
  },
  {
    name: AI_TOOL_NAMES.AI_ASSERT,
    description:
      "Assert a natural-language condition about the current page using AI. " +
      "Reads the page text and asks the AI to evaluate whether a condition holds. " +
      'Returns { pass: boolean, reason: string }. Example condition: "the user is logged in", ' +
      '"the search results contain at least 3 items". Requires CHROMEUSE_AI_API_KEY.',
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Target tab ID",
        },
        condition: {
          type: "string",
          description:
            'Natural language condition to check (e.g. "the login form is visible")',
        },
        pageContent: {
          type: "string",
          description:
            "Optional pre-fetched page content. If not provided, fetches page text automatically.",
        },
      },
      required: ["tabId", "condition"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface AiToolContext {
  ai: AiProvider;
  browser: BrowserTransport;
  clientId: string;
}

/**
 * Handle an AI tool call.
 * Returns the MCP-style result { content, isError? }.
 */
export async function handleAiTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  switch (toolName) {
    case AI_TOOL_NAMES.AI_ACTION:
      return handleAiAction(args, ctx);
    case AI_TOOL_NAMES.AI_ASSERT:
      return handleAiAssert(args, ctx);
    default:
      return {
        content: [{ type: "text", text: `Unknown AI tool: ${toolName}` }],
        isError: true,
      };
  }
}

// ---------------------------------------------------------------------------
// ai_action
// ---------------------------------------------------------------------------

const ACTION_SYSTEM_PROMPT = `You are a browser automation assistant. You receive the current page state (accessibility tree or page text) and a goal. Decide the single next action to take.

Respond with ONLY a JSON object (no markdown fences, no extra text):
{
  "thought": "brief reasoning (1 sentence)",
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "done",
  "ref": "ref_N (for click/type - the element reference from the accessibility tree)",
  "value": "text to type (for type action only)",
  "url": "URL (for navigate action only)",
  "direction": "up" | "down" (for scroll action only)
}

Rules:
- "done" means the goal appears to be achieved based on the page state.
- Only include fields relevant to the chosen action.
- For "click", always provide "ref".
- For "type", provide both "ref" and "value".
- For "navigate", provide "url".
- For "scroll", optionally provide "direction" (default: "down").
- For "wait", no extra fields needed.`;

async function handleAiAction(
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tabId = args.tabId as number | undefined;
  const goal = args.goal as string | undefined;

  if (tabId === undefined || !goal) {
    return {
      content: [{ type: "text", text: "Missing required arguments: tabId, goal" }],
      isError: true,
    };
  }

  // Get page state — use provided content or fetch accessibility tree
  let pageState = args.pageContent as string | undefined;
  if (!pageState) {
    try {
      const result = await ctx.browser.sendToolRequest(
        "read_page",
        { tabId, format: "accessibility" },
        undefined,
        { clientId: ctx.clientId }
      );
      pageState = extractText(result);
    } catch (err) {
      // Fall back to page text
      try {
        const result = await ctx.browser.sendToolRequest(
          "get_page_text",
          { tabId },
          undefined,
          { clientId: ctx.clientId }
        );
        pageState = extractText(result);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Failed to read page state: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  }

  const contextNote = args.context
    ? `\n\nAdditional context: ${args.context}`
    : "";

  try {
    const result = await ctx.ai.complete({
      messages: [
        { role: "system", content: ACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Goal: ${goal}${contextNote}\n\nCurrent page state:\n${truncate(pageState ?? "(empty)", 8000)}`,
        },
      ],
      temperature: 0,
      maxTokens: 300,
    });

    const responseText = result.text ?? "null";

    // Try to parse and validate the JSON
    let parsed: Record<string, unknown>;
    try {
      const cleaned = responseText
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "AI returned invalid JSON",
              raw: responseText,
              model: result.model,
              latencyMs: result.latencyMs,
            }),
          },
        ],
        isError: true,
      };
    }

    // Augment with metadata
    const output = {
      ...parsed,
      _meta: {
        model: result.model,
        latencyMs: result.latencyMs,
        tokens: result.usage,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `AI inference failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// ai_assert
// ---------------------------------------------------------------------------

const ASSERT_SYSTEM_PROMPT = `You are a browser testing assistant. Given the current page content and a condition to check, determine if the condition is true or false.

Respond with ONLY a JSON object (no markdown fences, no extra text):
{
  "pass": true | false,
  "reason": "brief explanation of why the condition does or does not hold"
}`;

async function handleAiAssert(
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tabId = args.tabId as number | undefined;
  const condition = args.condition as string | undefined;

  if (tabId === undefined || !condition) {
    return {
      content: [
        { type: "text", text: "Missing required arguments: tabId, condition" },
      ],
      isError: true,
    };
  }

  let pageState = args.pageContent as string | undefined;
  if (!pageState) {
    try {
      const result = await ctx.browser.sendToolRequest(
        "get_page_text",
        { tabId },
        undefined,
        { clientId: ctx.clientId }
      );
      pageState = extractText(result);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to read page: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }

  try {
    const result = await ctx.ai.complete({
      messages: [
        { role: "system", content: ASSERT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Condition to check: ${condition}\n\nPage content:\n${truncate(pageState ?? "(empty)", 8000)}`,
        },
      ],
      temperature: 0,
      maxTokens: 200,
    });

    const responseText = result.text ?? "null";

    let parsed: Record<string, unknown>;
    try {
      const cleaned = responseText
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "AI returned invalid JSON",
              raw: responseText,
              model: result.model,
            }),
          },
        ],
        isError: true,
      };
    }

    const output = {
      ...parsed,
      _meta: {
        model: result.model,
        latencyMs: result.latencyMs,
        tokens: result.usage,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `AI inference failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(result: ToolRequestResult): string {
  for (const block of result.content) {
    if ((block as { type: string }).type === "text") {
      return (block as { type: "text"; text: string }).text;
    }
  }
  return "";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...(truncated at ${maxChars} chars)`;
}
