import { describe, expect, it, vi } from "vitest";
import { AI_TOOL_NAMES, handleAiTool } from "./aiTools.js";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
} from "./decisionTypes.js";
import type { BrowserTransport, ToolRequestResult } from "./transport.js";

const PAGE = `[ref_1] searchbox "Query"
[ref_2] button "Search"`;

interface BrowserCall {
  tool: string;
  args: Record<string, unknown>;
}

function browser(): BrowserTransport & { calls: BrowserCall[] } {
  const calls: BrowserCall[] = [];
  return {
    calls,
    connected: true,
    async connect() {},
    disconnect() {},
    async sendToolRequest(tool, args): Promise<ToolRequestResult> {
      calls.push({ tool, args });
      if (tool === "read_page") {
        return { content: [{ type: "text", text: PAGE }] };
      }
      if (tool === "get_page_text") {
        return { content: [{ type: "text", text: "Search results" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function decision(
  request: DecisionRequest,
  match: RegExp,
  options: { complete?: number; sufficient?: number; risk?: number; confidence?: number } = {}
): DecisionResult {
  const question = request.questions.next_action;
  if (question.type !== "choice") throw new Error("next_action must be choice");
  const selected = Object.entries(question.criteria).find(([, description]) =>
    match.test(description)
  )?.[0];
  if (!selected) throw new Error(`No candidate matched ${match}`);
  return {
    answers: {
      next_action: {
        type: "choice",
        choice: selected,
        confidence: options.confidence ?? 0.95,
        probabilities: { [selected]: 0.94 },
      },
      goal_complete: { type: "noul", noul: options.complete ?? 0.05 },
      candidates_sufficient: { type: "noul", noul: options.sufficient ?? 0.96 },
      action_risk: { type: "score", score: options.risk ?? 0.2 },
    },
    metadata: {
      provider: "direct-jev",
      requestedModel: "typesafe/jev-1.13",
      resolvedModel: "typesafe/jev-1.13-20260917",
      latencyMs: 10,
      usage: { inputTokens: 30, outputTokens: 4, cost: 0.00001 },
    },
  };
}

function scriptedProvider(
  script: Array<(request: DecisionRequest) => DecisionResult>
): DecisionProvider & { decide: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    decide: vi.fn(async (request: DecisionRequest) => {
      const next = script[Math.min(index++, script.length - 1)];
      return next(request);
    }),
  };
}

function context(
  provider: DecisionProvider,
  transport: BrowserTransport,
  signal?: AbortSignal
) {
  return {
    provider,
    browser: transport,
    clientId: "test",
    thresholds: { action: 0.8, assertion: 0.8, sufficiency: 0.8, maxRisk: 1 },
    signal,
  } as never;
}

function output(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("ai_navigate direct Jev loop", () => {
  it("executes exactly one ChromeUse-owned atomic action per decision", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /Type .*browser automation.*ref_1/),
      (request) => decision(request, /Press Enter/),
      (request) => decision(request, /goal is complete/i, { complete: 0.93 }),
    ]);
    const transport = browser();

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: 'Search for "browser automation"', maxSteps: 5 },
      context(provider, transport)
    );
    const parsed = output(result);

    expect(parsed).toMatchObject({
      success: true,
      stopReason: "completed",
      stepsUsed: 3,
      inferences: 3,
      actionsExecuted: 2,
    });
    expect(provider.decide).toHaveBeenCalledTimes(3);
    expect(parsed.steps.map((step: { action?: unknown }) => step.action).filter(Boolean)).toHaveLength(2);
    expect(transport.calls.filter(({ tool }) => tool === "form_input")).toEqual([
      {
        tool: "form_input",
        args: { tabId: 7, ref: "ref_1", value: "browser automation" },
      },
    ]);
    expect(
      transport.calls.filter(
        ({ tool, args }) => tool === "computer" && args.action === "key"
      )
    ).toEqual([
      { tool: "computer", args: { tabId: 7, action: "key", key: "Enter" } },
    ]);
  });

  it("treats an extension isError response as a failed browser action", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /ref_2/),
    ]);
    const transport = browser();
    const originalSend = transport.sendToolRequest.bind(transport);
    transport.sendToolRequest = async (tool, args, timeout, metadata) => {
      if (tool === "computer") {
        transport.calls.push({ tool, args });
        return {
          isError: true,
          content: [{ type: "text", text: "Element ref_2 not found" }],
        };
      }
      return originalSend(tool, args, timeout, metadata);
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "browser_action_failed",
      actionsExecuted: 1,
      steps: [expect.objectContaining({
        success: false,
        error: "Element ref_2 not found",
      })],
    });
  });

  it("returns cancelled and executes nothing when cancellation fires after inference", async () => {
    const controller = new AbortController();
    const transport = browser();
    const provider: DecisionProvider = {
      async decide(request, signal) {
        expect(signal).toBe(controller.signal);
        const result = decision(request, /ref_2/);
        controller.abort(new Error("caller cancelled"));
        return result;
      },
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport, controller.signal)
    );

    expect(output(result)).toMatchObject({ success: false, stopReason: "cancelled" });
    expect(
      transport.calls.some(({ tool }) => ["computer", "form_input", "navigate"].includes(tool))
    ).toBe(false);
  });

  it("treats any aborted signal reason as cancellation", async () => {
    const controller = new AbortController();
    const transport = browser();
    const provider: DecisionProvider = {
      async decide(request) {
        const result = decision(request, /ref_2/);
        controller.abort(new Error("caller timed out"));
        return result;
      },
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport, controller.signal)
    );

    expect(output(result)).toMatchObject({ success: false, stopReason: "cancelled" });
    expect(
      transport.calls.some(({ tool }) => ["computer", "form_input", "navigate"].includes(tool))
    ).toBe(false);
  });

  it.each([
    ["low_confidence", { confidence: 0.79 }],
    ["candidates_insufficient", { sufficient: 0.79 }],
    ["risk_exceeded", { risk: 1.01 }],
  ])("stops with %s before browser mutation", async (expectedReason, options) => {
    const provider = scriptedProvider([
      (request) => decision(request, /ref_2/, options),
    ]);
    const transport = browser();

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({ success: false, stopReason: expectedReason });
    expect(
      transport.calls.some(({ tool }) => ["computer", "form_input", "navigate"].includes(tool))
    ).toBe(false);
  });

  it("reports conflicting done and sufficiency signals before the generic gate", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /goal is complete/i, {
        complete: 0.95,
        sufficient: 0.2,
      }),
    ]);
    const transport = browser();

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Open results", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "decision_conflict",
    });
  });

  it("rereads current accessibility state and rejects a stale ref before dispatch", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /ref_2/),
    ]);
    const transport = browser();
    let reads = 0;
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "read_page") {
        reads++;
        return {
          content: [{
            type: "text",
            text: reads === 1 ? PAGE : '[ref_1] searchbox "Query"',
          }],
        };
      }
      if (tool === "get_page_text") {
        return { content: [{ type: "text", text: "Search page" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "browser_action_failed",
      actionsExecuted: 0,
    });
    expect(reads).toBe(2);
    expect(
      transport.calls.some(({ tool }) => tool === "computer")
    ).toBe(false);
  });

  it("rejects a reused ref whose element identity changed during inference", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /ref_2/),
    ]);
    const transport = browser();
    let reads = 0;
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "read_page") {
        reads++;
        return {
          content: [{
            type: "text",
            text: reads === 1 ? PAGE : '[ref_2] button "Delete account"',
          }],
        };
      }
      if (tool === "get_page_text") {
        return { content: [{ type: "text", text: "Changed page" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "browser_action_failed",
      actionsExecuted: 0,
    });
    expect(
      transport.calls.some(({ tool }) => tool === "computer")
    ).toBe(false);
  });

  it("rejects duplicate-label controls that cannot be safely reidentified", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /ref_1/),
    ]);
    const transport = browser();
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "read_page") {
        return {
          content: [{
            type: "text",
            text: '[ref_1] button "Remove"\n[ref_2] button "Remove"',
          }],
        };
      }
      if (tool === "get_page_text") {
        return { content: [{ type: "text", text: "Cart" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Remove an item", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "browser_action_failed",
      actionsExecuted: 0,
    });
    expect(transport.calls.some(({ tool }) => tool === "computer")).toBe(false);
  });

  it("rejects duplicate-label controls beyond the inference element limit", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /ref_1/),
    ]);
    const transport = browser();
    const page = Array.from({ length: 151 }, (_, index) =>
      `[ref_${index + 1}] button "${index === 0 || index === 150 ? "Remove" : `Button ${index + 1}`}"`
    ).join("\n");
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "read_page") {
        return { content: [{ type: "text", text: page }] };
      }
      if (tool === "get_page_text") {
        return { content: [{ type: "text", text: "Cart" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Remove an item", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "browser_action_failed",
      actionsExecuted: 0,
    });
    expect(transport.calls.some(({ tool }) => tool === "computer")).toBe(false);
  });

  it("rejects duplicate refs with different identities anywhere in the full tree", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /ref_1/),
    ]);
    const transport = browser();
    const page = [
      '[ref_1] button "Safe"',
      ...Array.from({ length: 149 }, (_, index) =>
        `[ref_${index + 2}] button "Button ${index + 2}"`
      ),
      '[ref_1] button "Delete account"',
    ].join("\n");
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "read_page") {
        return { content: [{ type: "text", text: page }] };
      }
      if (tool === "get_page_text") {
        return { content: [{ type: "text", text: "Account" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Safe", maxSteps: 1 },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "browser_action_failed",
      actionsExecuted: 0,
    });
    expect(transport.calls.some(({ tool }) => tool === "computer")).toBe(false);
  });

  it("records an action whose outcome becomes unknown during cancellation", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([
      (request) => decision(request, /ref_2/),
    ]);
    const transport = browser();
    const originalSend = transport.sendToolRequest.bind(transport);
    transport.sendToolRequest = async (tool, args, timeout, metadata) => {
      if (tool === "computer") {
        transport.calls.push({ tool, args });
        controller.abort(new Error("deadline exceeded"));
        throw new Error("outcome unavailable");
      }
      return originalSend(tool, args, timeout, metadata);
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport, controller.signal)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "cancelled",
      actionsExecuted: 1,
      steps: [expect.objectContaining({
        action: { type: "click", ref: "ref_2" },
        success: false,
        stopReason: "cancelled",
        error: "Action outcome unknown after cancellation",
      })],
    });
  });

  it("checks cancellation again after asynchronous candidate revalidation", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([
      (request) => decision(request, /ref_2/),
    ]);
    const transport = browser();
    let reads = 0;
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "read_page") {
        reads++;
        if (reads === 2) controller.abort(new Error("cancelled during revalidation"));
        return { content: [{ type: "text", text: PAGE }] };
      }
      if (tool === "get_page_text") {
        return { content: [{ type: "text", text: "Search page" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      { tabId: 7, goal: "Click Search", maxSteps: 1 },
      context(provider, transport, controller.signal)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "cancelled",
      actionsExecuted: 0,
    });
    expect(
      transport.calls.some(({ tool }) => tool === "computer")
    ).toBe(false);
  });

  it("navigates to startUrl before the first page decision", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /goal is complete/i, { complete: 0.95 }),
    ]);
    const transport = browser();

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      {
        tabId: 7,
        goal: "Open results",
        startUrl: "https://example.com/results",
        maxSteps: 1,
      },
      context(provider, transport)
    );

    expect(output(result).stopReason).toBe("completed");
    expect(transport.calls[0]).toEqual({
      tool: "navigate",
      args: { tabId: 7, action: "goto", url: "https://example.com/results" },
    });
  });

  it("accounts for a completed startUrl navigation before later cancellation", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([
      (request) => decision(request, /goal is complete/i, { complete: 0.95 }),
    ]);
    const transport = browser();
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "navigate") {
        controller.abort(new Error("deadline exceeded"));
      }
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      {
        tabId: 7,
        goal: "Open results",
        startUrl: "https://example.com/results",
        maxSteps: 1,
      },
      context(provider, transport, controller.signal)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "cancelled",
      actionsExecuted: 1,
      startUrlAction: {
        action: { type: "navigate", url: "https://example.com/results" },
        success: true,
      },
    });
  });

  it("returns a structured failure when startUrl navigation throws", async () => {
    const provider = scriptedProvider([
      (request) => decision(request, /goal is complete/i, { complete: 0.95 }),
    ]);
    const transport = browser();
    transport.sendToolRequest = async (tool, args): Promise<ToolRequestResult> => {
      transport.calls.push({ tool, args });
      if (tool === "navigate") throw new Error("extension disconnected");
      return { content: [{ type: "text", text: "ok" }] };
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_NAVIGATE,
      {
        tabId: 7,
        goal: "Open results",
        startUrl: "https://example.com/results",
        maxSteps: 1,
      },
      context(provider, transport)
    );

    expect(output(result)).toMatchObject({
      success: false,
      stopReason: "browser_action_failed",
      actionsExecuted: 0,
      startUrlAction: {
        action: { type: "navigate", url: "https://example.com/results" },
        success: false,
        error: "extension disconnected",
      },
    });
    expect(provider.decide).not.toHaveBeenCalled();
  });
});
