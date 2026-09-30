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
import { compactTree } from "./pageCompactor.js";

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

/**
 * Plan-based prompt. Asking for a SEQUENCE of actions instead of one action
 * per inference is the main latency win: a search ("type query, press Enter")
 * costs one inference instead of two.
 *
 * The model must stop a plan at the first action that navigates, because refs
 * are only valid for the page they were read from. Continuing to execute a
 * stale plan after navigation clicks whatever now happens to own that ref.
 */
const NAVIGATE_SYSTEM_PROMPT = `You are an autonomous browser agent. Given page state and a goal, return a PLAN of consecutive actions.

Respond with ONLY a JSON object (no markdown fences, no extra text):
{
  "thought": "brief reasoning (1 sentence)",
  "plan": [
    {"action":"click","ref":"ref_N"},
    {"action":"type","ref":"ref_N","value":"text"},
    {"action":"key","key":"Enter"},
    {"action":"scroll","direction":"down"},
    {"action":"navigate","url":"https://..."},
    {"action":"wait"}
  ],
  "expectNavigation": true|false,
  "done": false
}

CRITICAL RULES:
- Only batch actions that are ALL valid on the CURRENT page state shown.
- Stop the plan at the first action that navigates or loads new content, and
  set "expectNavigation": true. Element refs are INVALID after navigation.
- Typing into a field then pressing Enter IS safe to batch.
- Set "done": true with an empty plan when the goal is already achieved.
- Use {"action":"key","key":"Enter"} to submit a form.
- If an element you need is not listed, scroll to reveal it.
- If stuck, set "done": true and explain why in "thought".`;

const DEFAULT_MAX_STEPS = 10;
const HARD_MAX_STEPS = 25;
/** Settle delay after a plan that did not navigate. */
const SETTLE_MS = 400;
/** Longer settle after navigation so the next read sees the new page. */
const NAVIGATION_SETTLE_MS = 1200;
/** Cap on actionable elements sent to the model per step. */
const MAX_ELEMENTS = 150;

interface PlannedAction {
  action: string;
  ref?: string;
  value?: string;
  key?: string;
  url?: string;
  direction?: string;
}

interface ActionOutcome {
  action: string;
  ref?: string;
  value?: string;
  key?: string;
  url?: string;
  direction?: string;
  success: boolean;
  error?: string;
}

interface StepLog {
  step: number;
  thought: string;
  /** Every action executed in this step's plan. */
  actions: ActionOutcome[];
  expectNavigation: boolean;
  model: string;
  latencyMs: number;
  /** Element counts, to show how much noise compaction removed. */
  pageElements: number;
  pageRefsDropped: number;
  error?: string;
}

async function handleAiNavigate(
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tabId = args.tabId as number | undefined;
  const goal = args.goal as string | undefined;
  const maxSteps = Math.min(
    typeof args.maxSteps === "number" && args.maxSteps > 0
      ? args.maxSteps
      : DEFAULT_MAX_STEPS,
    HARD_MAX_STEPS
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
  let totalInferences = 0;
  let totalActions = 0;

  if (startUrl) {
    try {
      await ctx.browser.sendToolRequest(
        "navigate",
        { tabId, url: startUrl, action: "goto" },
        undefined,
        { clientId: ctx.clientId }
      );
      await sleep(NAVIGATION_SETTLE_MS);
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `Failed to navigate to ${startUrl}: ${(err as Error).message}`,
            steps: [],
          }, null, 2),
        }],
        isError: true,
      };
    }
  }

  for (let i = 0; i < maxSteps && !done; i++) {
    // --- 1. Read and compact page state ---------------------------------
    let compact;
    try {
      const result = await ctx.browser.sendToolRequest(
        "read_page",
        { tabId, format: "accessibility" },
        undefined,
        { clientId: ctx.clientId }
      );
      compact = compactTree(extractText(result), MAX_ELEMENTS);
    } catch (readErr) {
      steps.push({
        step: i + 1, thought: "", actions: [], expectNavigation: false,
        model: "", latencyMs: 0, pageElements: 0, pageRefsDropped: 0,
        error: `Failed to read page: ${(readErr as Error).message}`,
      });
      break;
    }

    // --- 2. Build history context ---------------------------------------
    const historyContext = steps.length
      ? "\n\nSteps already taken:\n" +
        steps
          .map((s) => {
            const acts = s.actions
              .map((a) => {
                const bits = [a.action];
                if (a.ref) bits.push(a.ref);
                if (a.value) bits.push(`"${a.value}"`);
                if (a.key) bits.push(`key=${a.key}`);
                if (a.url) bits.push(a.url);
                if (!a.success) bits.push("(FAILED)");
                return bits.join(" ");
              })
              .join("; ");
            return `  ${s.step}. ${acts || "(none)"} — ${s.thought}`;
          })
          .join("\n")
      : "";

    // --- 3. Ask for a plan ----------------------------------------------
    let aiResult;
    try {
      aiResult = await ctx.ai.complete({
        messages: [
          { role: "system", content: NAVIGATE_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Goal: ${goal}${historyContext}\n\n` +
              `Current page actionable elements ` +
              `(${compact.elements.length} shown, ${compact.droppedRefs} layout nodes filtered out):\n` +
              compact.text,
          },
        ],
        temperature: 0,
        maxTokens: 500,
      });
      totalInferences++;
    } catch (aiErr) {
      steps.push({
        step: i + 1, thought: "", actions: [], expectNavigation: false,
        model: "", latencyMs: 0,
        pageElements: compact.elements.length,
        pageRefsDropped: compact.droppedRefs,
        error: `AI inference failed: ${(aiErr as Error).message}`,
      });
      break;
    }

    // --- 4. Parse the plan ----------------------------------------------
    // Jev intermittently returns null content; treat it as a retryable step
    // rather than aborting the whole run.
    let parsed: Record<string, unknown> | null = null;
    try {
      const cleaned = (aiResult.text ?? "")
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      if (cleaned) parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    if (!parsed) {
      steps.push({
        step: i + 1,
        thought: "Model returned unusable output; retrying",
        actions: [], expectNavigation: false,
        model: aiResult.model, latencyMs: aiResult.latencyMs,
        pageElements: compact.elements.length,
        pageRefsDropped: compact.droppedRefs,
        error: `Unparseable response: ${(aiResult.text ?? "(null)").slice(0, 120)}`,
      });
      continue;
    }

    const thought = typeof parsed.thought === "string" ? parsed.thought : "";
    const expectNavigation = parsed.expectNavigation === true;
    const plan: PlannedAction[] = Array.isArray(parsed.plan)
      ? (parsed.plan as PlannedAction[])
      : [];

    // --- 5. Goal already met? -------------------------------------------
    if (parsed.done === true || plan.length === 0) {
      done = parsed.done === true;
      finalThought = thought;
      steps.push({
        step: i + 1, thought, actions: [], expectNavigation,
        model: aiResult.model, latencyMs: aiResult.latencyMs,
        pageElements: compact.elements.length,
        pageRefsDropped: compact.droppedRefs,
        ...(done ? {} : { error: "Model returned an empty plan without done=true" }),
      });
      break;
    }

    // --- 6. Execute the plan --------------------------------------------
    const outcomes: ActionOutcome[] = [];
    let navigated = false;

    for (const step of plan) {
      const outcome = await executeAction(step, tabId, ctx);
      outcomes.push(outcome);
      totalActions++;

      // Abandon the rest of the plan on failure — later actions assume the
      // earlier ones landed.
      if (!outcome.success) break;

      if (step.action === "navigate" || step.action === "click") {
        navigated = true;
      }
    }

    steps.push({
      step: i + 1, thought, actions: outcomes, expectNavigation,
      model: aiResult.model, latencyMs: aiResult.latencyMs,
      pageElements: compact.elements.length,
      pageRefsDropped: compact.droppedRefs,
    });

    await sleep(
      expectNavigation || navigated ? NAVIGATION_SETTLE_MS : SETTLE_MS
    );
  }

  // --- Final page snapshot ----------------------------------------------
  let finalPageText = "";
  try {
    const result = await ctx.browser.sendToolRequest(
      "get_page_text",
      { tabId, maxLength: 1200 },
      undefined,
      { clientId: ctx.clientId }
    );
    finalPageText = extractText(result);
  } catch {
    // Best effort — a failed final read must not mask the run's outcome.
  }

  const output = {
    success: done,
    goal,
    stepsUsed: steps.length,
    maxSteps,
    inferences: totalInferences,
    actionsExecuted: totalActions,
    ...(finalThought ? { finalThought } : {}),
    ...(done
      ? {}
      : {
          note:
            steps.length >= maxSteps
              ? `Stopped at the ${maxSteps}-step limit without reaching the goal. Raise maxSteps or narrow the goal.`
              : "Stopped before reaching the goal; see step errors.",
        }),
    steps,
    finalPagePreview: truncate(finalPageText, 600),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
  };
}

/**
 * Execute one planned action against the browser.
 * Returns an outcome instead of throwing so a failed action degrades the
 * step rather than the whole run.
 */
async function executeAction(
  step: PlannedAction,
  tabId: number,
  ctx: AiToolContext
): Promise<ActionOutcome> {
  const base: ActionOutcome = {
    action: step.action,
    ...(step.ref ? { ref: step.ref } : {}),
    ...(step.value !== undefined ? { value: step.value } : {}),
    ...(step.key ? { key: step.key } : {}),
    ...(step.url ? { url: step.url } : {}),
    ...(step.direction ? { direction: step.direction } : {}),
    success: true,
  };

  const send = (tool: string, toolArgs: Record<string, unknown>) =>
    ctx.browser.sendToolRequest(tool, toolArgs, undefined, {
      clientId: ctx.clientId,
    });

  try {
    switch (step.action) {
      case "click": {
        if (!step.ref) {
          return { ...base, success: false, error: "click requires a ref" };
        }
        await send("computer", { tabId, action: "click", ref: step.ref });
        return base;
      }

      case "type": {
        if (!step.ref) {
          return { ...base, success: false, error: "type requires a ref" };
        }
        if (step.value === undefined) {
          return { ...base, success: false, error: "type requires a value" };
        }
        // form_input sets the value directly and, unlike click-then-type,
        // does not depend on the element being scrolled into view.
        await send("form_input", { tabId, ref: step.ref, value: step.value });
        return base;
      }

      case "key": {
        const key = step.key ?? "Enter";
        await send("computer", { tabId, action: "key", key });
        return { ...base, key };
      }

      case "scroll": {
        await send("computer", {
          tabId,
          action: "scroll",
          direction: step.direction ?? "down",
        });
        return base;
      }

      case "navigate": {
        if (!step.url) {
          return { ...base, success: false, error: "navigate requires a url" };
        }
        await send("navigate", { tabId, url: step.url, action: "goto" });
        return base;
      }

      case "wait": {
        await sleep(1200);
        return base;
      }

      default:
        return {
          ...base,
          success: false,
          error: `Unsupported action: ${step.action}`,
        };
    }
  } catch (err) {
    return { ...base, success: false, error: (err as Error).message };
  }
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
