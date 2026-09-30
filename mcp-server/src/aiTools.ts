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
  /** Autonomous multi-step browser agent — drives the browser until the goal is met */
  AI_NAVIGATE: "ai_navigate",
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
  {
    name: AI_TOOL_NAMES.AI_NAVIGATE,
    description:
      "Autonomous browser agent — give it a goal and it drives the browser through multiple steps " +
      "(read page, decide action, execute, repeat) until the goal is achieved or the step limit is reached. " +
      "Returns a log of every step taken plus the final page state. " +
      "This is the fastest way to accomplish multi-step browser tasks in a single tool call. " +
      "Example goals: 'search for TypeScript on Hacker News and open the first result', " +
      "'navigate to the pricing page and find the enterprise plan price'. " +
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
            'What to accomplish (e.g. "find the pricing page", "search for rust and open the first result")',
        },
        maxSteps: {
          type: "number",
          description:
            "Maximum steps before stopping (default: 10). Each step is one browser action.",
        },
        startUrl: {
          type: "string",
          description:
            "Optional URL to navigate to before starting. If not set, works with whatever page is currently loaded.",
        },
      },
      required: ["tabId", "goal"],
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
    case AI_TOOL_NAMES.AI_NAVIGATE:
      return handleAiNavigate(args, ctx);
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
// ai_navigate — autonomous multi-step browser agent
// ---------------------------------------------------------------------------

const NAVIGATE_SYSTEM_PROMPT = `You are an autonomous browser automation agent. You receive the current page state and a goal. Decide the single next action to take toward completing the goal.

Respond with ONLY a JSON object (no markdown fences, no extra text):
{
  "thought": "brief reasoning (1 sentence)",
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "done",
  "ref": "ref_N (for click/type)",
  "value": "text to type (for type)",
  "url": "URL (for navigate)",
  "direction": "up" | "down" (for scroll)"
}

Rules:
- Return "done" when the goal is achieved based on current page state.
- Only include fields relevant to the chosen action.
- Be efficient — take the most direct path to the goal.
- If the page hasn't changed after a scroll, try a different approach.
- If you're stuck, return "done" with a thought explaining why.`;

const DEFAULT_MAX_STEPS = 10;
const STEP_DELAY_MS = 500;

interface StepLog {
  step: number;
  thought: string;
  action: string;
  ref?: string;
  value?: string;
  url?: string;
  direction?: string;
  model: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}

async function handleAiNavigate(
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tabId = args.tabId as number | undefined;
  const goal = args.goal as string | undefined;
  const maxSteps = Math.min(
    typeof args.maxSteps === "number" ? args.maxSteps : DEFAULT_MAX_STEPS,
    25 // hard cap
  );
  const startUrl = args.startUrl as string | undefined;

  if (tabId === undefined || !goal) {
    return {
      content: [{ type: "text", text: "Missing required arguments: tabId, goal" }],
      isError: true,
    };
  }

  const steps: StepLog[] = [];
  let done = false;
  let finalThought = "";

  // Navigate to start URL if provided
  if (startUrl) {
    try {
      await ctx.browser.sendToolRequest(
        "navigate",
        { tabId, url: startUrl, action: "goto" },
        undefined,
        { clientId: ctx.clientId }
      );
      await sleep(1000); // let page load
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `Failed to navigate to ${startUrl}: ${(err as Error).message}`,
            steps: [],
          }),
        }],
        isError: true,
      };
    }
  }

  for (let i = 0; i < maxSteps && !done; i++) {
    // 1. Read current page state
    let pageState: string;
    try {
      const result = await ctx.browser.sendToolRequest(
        "read_page",
        { tabId, format: "accessibility" },
        undefined,
        { clientId: ctx.clientId }
      );
      pageState = extractText(result);
    } catch {
      try {
        const result = await ctx.browser.sendToolRequest(
          "get_page_text",
          { tabId },
          undefined,
          { clientId: ctx.clientId }
        );
        pageState = extractText(result);
      } catch (err) {
        steps.push({
          step: i + 1, thought: "Failed to read page", action: "error",
          model: "", latencyMs: 0, success: false,
          error: (err as Error).message,
        });
        break;
      }
    }

    // Build context from previous steps
    const historyContext = steps.length > 0
      ? "\n\nPrevious steps taken:\n" + steps.map(s =>
          `  ${s.step}. ${s.action}${s.ref ? ` ${s.ref}` : ""}${s.value ? ` "${s.value}"` : ""} — ${s.thought}`
        ).join("\n")
      : "";

    // 2. Ask AI for next action
    let aiResult;
    try {
      aiResult = await ctx.ai.complete({
        messages: [
          { role: "system", content: NAVIGATE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Goal: ${goal}${historyContext}\n\nCurrent page state:\n${truncate(pageState, 8000)}`,
          },
        ],
        temperature: 0,
        maxTokens: 300,
      });
    } catch (err) {
      steps.push({
        step: i + 1, thought: "AI inference failed", action: "error",
        model: "", latencyMs: 0, success: false,
        error: (err as Error).message,
      });
      break;
    }

    // 3. Parse AI response
    let parsed: Record<string, unknown>;
    try {
      const cleaned = (aiResult.text ?? "")
        .replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      steps.push({
        step: i + 1, thought: "AI returned invalid JSON", action: "error",
        model: aiResult.model, latencyMs: aiResult.latencyMs, success: false,
        error: `Invalid response: ${aiResult.text?.slice(0, 100)}`,
      });
      // Retry once on bad JSON (Jev occasionally returns null)
      continue;
    }

    const action = parsed.action as string;
    const thought = (parsed.thought as string) ?? "";
    const ref = parsed.ref as string | undefined;
    const value = parsed.value as string | undefined;
    const url = parsed.url as string | undefined;
    const direction = parsed.direction as string | undefined;

    const stepLog: StepLog = {
      step: i + 1, thought, action,
      ...(ref ? { ref } : {}),
      ...(value ? { value } : {}),
      ...(url ? { url } : {}),
      ...(direction ? { direction } : {}),
      model: aiResult.model, latencyMs: aiResult.latencyMs,
      success: true,
    };

    // 4. Check if done
    if (action === "done") {
      done = true;
      finalThought = thought;
      steps.push(stepLog);
      break;
    }

    // 5. Execute the action
    try {
      switch (action) {
        case "click":
          if (ref) {
            await ctx.browser.sendToolRequest(
              "computer", { tabId, action: "click", ref },
              undefined, { clientId: ctx.clientId }
            );
          }
          break;

        case "type":
          if (ref && value) {
            // Click to focus first, then type
            await ctx.browser.sendToolRequest(
              "computer", { tabId, action: "click", ref },
              undefined, { clientId: ctx.clientId }
            );
            await sleep(100);
            await ctx.browser.sendToolRequest(
              "computer", { tabId, action: "type", text: value },
              undefined, { clientId: ctx.clientId }
            );
          } else if (ref && value === undefined) {
            // form_input for setting values directly
            await ctx.browser.sendToolRequest(
              "form_input", { tabId, ref, value: value ?? "" },
              undefined, { clientId: ctx.clientId }
            );
          }
          break;

        case "scroll":
          await ctx.browser.sendToolRequest(
            "computer",
            { tabId, action: "scroll", x: 400, y: 400, direction: direction ?? "down" },
            undefined, { clientId: ctx.clientId }
          );
          break;

        case "navigate":
          if (url) {
            await ctx.browser.sendToolRequest(
              "navigate", { tabId, url, action: "goto" },
              undefined, { clientId: ctx.clientId }
            );
          }
          break;

        case "wait":
          await sleep(1500);
          break;

        default:
          stepLog.success = false;
          stepLog.error = `Unknown action: ${action}`;
      }
    } catch (err) {
      stepLog.success = false;
      stepLog.error = (err as Error).message;
    }

    steps.push(stepLog);

    // Brief pause between steps for page to settle
    await sleep(STEP_DELAY_MS);
  }

  // Read final page state
  let finalPageText = "";
  try {
    const result = await ctx.browser.sendToolRequest(
      "get_page_text", { tabId, maxLength: 1000 },
      undefined, { clientId: ctx.clientId }
    );
    finalPageText = extractText(result);
  } catch { /* best effort */ }

  const output = {
    success: done,
    goal,
    stepsCompleted: steps.length,
    maxSteps,
    ...(finalThought ? { finalThought } : {}),
    steps,
    finalPagePreview: truncate(finalPageText, 500),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
