import { describe, it, expect, vi } from "vitest";
import { handleAiTool, AI_TOOL_NAMES } from "./aiTools.js";
import { AiProvider } from "./aiProvider.js";
import type { BrowserTransport, ToolRequestResult } from "./transport.js";

/**
 * These tests execute the ai_navigate loop itself — plan parsing, action
 * dispatch, navigation settling, termination and error degradation. The
 * earlier test pass only asserted that the tool was registered, which left
 * the entire handler unexecuted.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const HN_TREE = `[ref_736] generic
  [ref_734] table
    [ref_18] cell "header"
      [ref_14] link "login"
      [ref_26] link "EDG C++ front-end goes public"
      [ref_187] link "You said no MCP"
    [ref_729] form "Search:"
      [ref_728] textbox`;

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

function fakeBrowser(overrides: Record<string, ToolRequestResult> = {}) {
  const calls: Call[] = [];

  const transport: BrowserTransport & { calls: Call[] } = {
    calls,
    get connected() {
      return true;
    },
    async connect() {},
    disconnect() {},
    async sendToolRequest(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });

      if (overrides[tool]) return overrides[tool];

      if (tool === "read_page") {
        return { success: true, content: [{ type: "text", text: HN_TREE }] };
      }
      if (tool === "get_page_text") {
        return {
          success: true,
          content: [{ type: "text", text: "Final page content" }],
        };
      }
      return { success: true, content: [{ type: "text", text: "ok" }] };
    },
  } as BrowserTransport & { calls: Call[] };

  return transport;
}

/** AiProvider whose completions are scripted, one response per call. */
function fakeAi(responses: string[]) {
  let i = 0;
  const provider = new AiProvider({
    apiKey: "test",
    baseUrl: "https://example.com/v1",
    model: "typesafe/jev-router",
    defaultMaxTokens: 500,
  });
  provider.complete = vi.fn(async () => ({
    text: responses[Math.min(i++, responses.length - 1)],
    model: "openai/gpt-6-luna",
    latencyMs: 10,
  }));
  return provider;
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function navigate(
  responses: string[],
  args: Record<string, unknown> = {},
  browser = fakeBrowser()
) {
  const ai = fakeAi(responses);
  const result = await handleAiTool(
    AI_TOOL_NAMES.AI_NAVIGATE,
    { tabId: 1, goal: "test goal", ...args },
    { ai, browser, clientId: "test-client" }
  );
  return { out: parseResult(result), browser, ai };
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("ai_navigate validation", () => {
  it("rejects a missing tabId", async () => {
    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { goal: "x" },
      { ai: fakeAi(["{}"]), browser: fakeBrowser(), clientId: "c" }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/tabId/);
  });

  it("rejects a missing goal", async () => {
    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 1 },
      { ai: fakeAi(["{}"]), browser: fakeBrowser(), clientId: "c" }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/goal/);
  });
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("ai_navigate execution", () => {
  it("terminates immediately when the model reports done", async () => {
    const { out, ai } = await navigate([
      JSON.stringify({ thought: "Already there", plan: [], done: true }),
    ]);

    expect(out.success).toBe(true);
    expect(out.finalThought).toBe("Already there");
    expect(out.stepsUsed).toBe(1);
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  it("executes a batched type+key plan in ONE inference", async () => {
    // This is the core latency claim: a search costs one inference, not two.
    const { out, browser, ai } = await navigate([
      JSON.stringify({
        thought: "Search for it",
        plan: [
          { action: "type", ref: "ref_728", value: "browser automation" },
          { action: "key", key: "Enter" },
        ],
        expectNavigation: true,
      }),
      JSON.stringify({ thought: "Results shown", plan: [], done: true }),
    ]);

    expect(ai.complete).toHaveBeenCalledTimes(2);
    expect(out.actionsExecuted).toBe(2);

    const typeCall = browser.calls.find((c) => c.tool === "form_input");
    expect(typeCall?.args).toMatchObject({
      tabId: 1,
      ref: "ref_728",
      value: "browser automation",
    });

    const keyCall = browser.calls.find(
      (c) => c.tool === "computer" && c.args.action === "key"
    );
    expect(keyCall?.args).toMatchObject({ action: "key", key: "Enter" });
  });

  it("dispatches click through the computer tool with the ref", async () => {
    const { browser } = await navigate([
      JSON.stringify({
        thought: "Open article",
        plan: [{ action: "click", ref: "ref_187" }],
        expectNavigation: true,
      }),
      JSON.stringify({ thought: "Done", plan: [], done: true }),
    ]);

    const click = browser.calls.find(
      (c) => c.tool === "computer" && c.args.action === "click"
    );
    expect(click?.args).toMatchObject({ action: "click", ref: "ref_187" });
  });

  it("sends the COMPACTED tree, not the raw one", async () => {
    const ai = fakeAi([
      JSON.stringify({ thought: "d", plan: [], done: true }),
    ]);
    await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 1, goal: "g" },
      { ai, browser: fakeBrowser(), clientId: "c" }
    );

    const prompt = (ai.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .messages[1].content as string;

    // Layout noise must be gone, actionable refs must survive.
    expect(prompt).not.toMatch(/rowgroup|\bcell\b/);
    expect(prompt).toContain("ref_728");
    expect(prompt).toContain("ref_14");
    expect(prompt).toMatch(/layout nodes filtered out/);
  });

  it("navigates to startUrl before planning", async () => {
    const { browser } = await navigate(
      [JSON.stringify({ thought: "d", plan: [], done: true })],
      { startUrl: "https://news.ycombinator.com" }
    );

    expect(browser.calls[0]).toMatchObject({
      tool: "navigate",
      args: { url: "https://news.ycombinator.com", action: "goto" },
    });
  });

  it("feeds prior steps back as history", async () => {
    const ai = fakeAi([
      JSON.stringify({
        thought: "First click",
        plan: [{ action: "click", ref: "ref_14" }],
      }),
      JSON.stringify({ thought: "Now done", plan: [], done: true }),
    ]);
    await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 1, goal: "g" },
      { ai, browser: fakeBrowser(), clientId: "c" }
    );

    const second = (ai.complete as ReturnType<typeof vi.fn>).mock.calls[1][0]
      .messages[1].content as string;
    expect(second).toMatch(/Steps already taken/);
    expect(second).toMatch(/click ref_14/);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("ai_navigate failure handling", () => {
  it("survives Jev returning null content and retries", async () => {
    // Observed intermittently against the live router.
    const { out, ai } = await navigate([
      null as unknown as string,
      JSON.stringify({ thought: "Recovered", plan: [], done: true }),
    ]);

    expect(ai.complete).toHaveBeenCalledTimes(2);
    expect(out.success).toBe(true);
    expect(out.steps[0].error).toMatch(/Unparseable/);
  });

  it("records an error for non-JSON output without aborting", async () => {
    const { out } = await navigate([
      "I cannot help with that.",
      JSON.stringify({ thought: "ok", plan: [], done: true }),
    ]);
    expect(out.steps[0].error).toMatch(/Unparseable/);
    expect(out.success).toBe(true);
  });

  it("stops the remaining plan when an action fails", async () => {
    const browser = fakeBrowser();
    const original = browser.sendToolRequest.bind(browser);
    browser.sendToolRequest = async (
      tool: string,
      args: Record<string, unknown>,
      ...rest: unknown[]
    ) => {
      if (tool === "form_input") throw new Error("element detached");
      return (original as typeof browser.sendToolRequest)(
        tool,
        args,
        ...(rest as [])
      );
    };

    const { out } = await navigate(
      [
        JSON.stringify({
          thought: "Fill then submit",
          plan: [
            { action: "type", ref: "ref_728", value: "x" },
            { action: "key", key: "Enter" },
          ],
        }),
        JSON.stringify({ thought: "stop", plan: [], done: true }),
      ],
      {},
      browser
    );

    const first = out.steps[0];
    expect(first.actions).toHaveLength(1); // key was NOT attempted
    expect(first.actions[0].success).toBe(false);
    expect(first.actions[0].error).toMatch(/element detached/);
  });

  it("rejects a click with no ref instead of clicking blindly", async () => {
    const { out } = await navigate([
      JSON.stringify({ thought: "bad", plan: [{ action: "click" }] }),
      JSON.stringify({ thought: "stop", plan: [], done: true }),
    ]);
    expect(out.steps[0].actions[0].success).toBe(false);
    expect(out.steps[0].actions[0].error).toMatch(/requires a ref/);
  });

  it("rejects an unsupported action", async () => {
    const { out } = await navigate([
      JSON.stringify({ thought: "?", plan: [{ action: "teleport" }] }),
      JSON.stringify({ thought: "stop", plan: [], done: true }),
    ]);
    expect(out.steps[0].actions[0].error).toMatch(/Unsupported action/);
  });

  it("aborts cleanly when read_page fails", async () => {
    const browser = fakeBrowser();
    browser.sendToolRequest = async (tool: string) => {
      if (tool === "read_page") throw new Error("tab closed");
      return { success: true, content: [{ type: "text", text: "" }] };
    };

    const { out } = await navigate(
      [JSON.stringify({ thought: "x", plan: [], done: true })],
      {},
      browser
    );

    expect(out.success).toBe(false);
    expect(out.steps[0].error).toMatch(/Failed to read page: tab closed/);
  });

  it("surfaces AI transport failure as a step error", async () => {
    const ai = fakeAi(["{}"]);
    ai.complete = vi.fn(async () => {
      throw new Error("429 rate limited");
    });

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 1, goal: "g" },
      { ai, browser: fakeBrowser(), clientId: "c" }
    );
    const out = parseResult(result);
    expect(out.success).toBe(false);
    expect(out.steps[0].error).toMatch(/429 rate limited/);
  });
});

// ---------------------------------------------------------------------------
// Step limits
// ---------------------------------------------------------------------------

describe("ai_navigate step limits", () => {
  it("honours maxSteps and explains why it stopped", async () => {
    // A model that never finishes.
    const { out, ai } = await navigate(
      [
        JSON.stringify({
          thought: "scrolling forever",
          plan: [{ action: "scroll", direction: "down" }],
        }),
      ],
      { maxSteps: 3 }
    );

    expect(ai.complete).toHaveBeenCalledTimes(3);
    expect(out.stepsUsed).toBe(3);
    expect(out.success).toBe(false);
    expect(out.note).toMatch(/3-step limit/);
  });

  it("caps maxSteps at the hard ceiling", async () => {
    const { out } = await navigate(
      [JSON.stringify({ thought: "d", plan: [], done: true })],
      { maxSteps: 9999 }
    );
    expect(out.maxSteps).toBe(25);
  });

  it("reports inference and action counts for cost tracking", async () => {
    const { out } = await navigate([
      JSON.stringify({
        thought: "two actions",
        plan: [
          { action: "type", ref: "ref_728", value: "q" },
          { action: "key", key: "Enter" },
        ],
      }),
      JSON.stringify({ thought: "done", plan: [], done: true }),
    ]);

    expect(out.inferences).toBe(2);
    expect(out.actionsExecuted).toBe(2);
  });
});
