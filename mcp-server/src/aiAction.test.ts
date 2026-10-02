import { describe, expect, it, vi } from "vitest";
import { AI_TOOL_NAMES, handleAiTool } from "./aiTools.js";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./decisionTypes.js";
import type { BrowserTransport } from "./transport.js";

const metadata: DecisionResult["metadata"] = {
  provider: "direct-jev",
  requestedModel: "typesafe/jev-1.13",
  resolvedModel: "typesafe/jev-1.13-20260917",
  latencyMs: 8,
  usage: { inputTokens: 40, outputTokens: 5, cost: 0.00002 },
};

function fakeBrowser(): BrowserTransport {
  return {
    connected: true,
    async connect() {},
    disconnect() {},
    async sendToolRequest() {
      return { content: [{ type: "text", text: "unused" }] };
    },
  };
}

function successfulDecision(request: DecisionRequest): DecisionResult {
  const criteria = request.questions.next_action;
  if (criteria.type !== "choice") throw new Error("expected choice");
  const selected = Object.entries(criteria.criteria).find(([, description]) =>
    description.includes("ref_1")
  )?.[0];
  if (!selected) throw new Error("click candidate missing");
  const alternate = Object.keys(criteria.criteria).find((id) => id !== selected)!;
  return {
    answers: {
      next_action: {
        type: "choice",
        choice: selected,
        confidence: 0.92,
        probabilities: { [selected]: 0.9, [alternate]: 0.1 },
      },
      goal_complete: { type: "noul", noul: 0.05 },
      candidates_sufficient: { type: "noul", noul: 0.94 },
      action_risk: { type: "score", score: 0.2, confidence: 0.9 },
    },
    metadata,
  };
}

function context(provider: DecisionProvider, browser = fakeBrowser()) {
  return {
    provider,
    browser,
    clientId: "test",
    thresholds: { action: 0.8, assertion: 0.8, sufficiency: 0.8, maxRisk: 1 },
  } as never;
}

describe("ai_action direct Jev handler", () => {
  it("returns one ChromeUse-owned candidate without executing it", async () => {
    const provider: DecisionProvider & { decide: ReturnType<typeof vi.fn> } = {
      decide: vi.fn(async (request: DecisionRequest) => successfulDecision(request)),
    };
    const browser = fakeBrowser();
    const send = vi.spyOn(browser, "sendToolRequest");

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      {
        tabId: 7,
        goal: "Open Latest",
        pageContent: '[ref_1] link "Latest"',
      },
      {
        provider,
        browser,
        clientId: "test",
        thresholds: { action: 0.8, assertion: 0.8, sufficiency: 0.8, maxRisk: 1 },
      } as never
    );

    const output = JSON.parse(result.content[0].text);
    expect(output).toMatchObject({
      action: "click",
      ref: "ref_1",
      selectedProbability: 0.9,
      confidence: 0.92,
      goalComplete: 0.05,
      candidatesSufficient: 0.94,
      risk: 0.2,
      _meta: metadata,
    });
    expect(output.alternatives).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("stops when another candidate has a higher probability than the selected choice", async () => {
    const provider: DecisionProvider = {
      async decide(request) {
        const result = successfulDecision(request);
        const answer = result.answers.next_action;
        if (answer.type !== "choice" || !answer.probabilities) throw new Error("choice expected");
        const alternate = Object.keys(answer.probabilities).find((id) => id !== answer.choice)!;
        answer.probabilities[answer.choice] = 0.4;
        answer.probabilities[alternate] = 0.6;
        return result;
      },
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      { tabId: 7, goal: "Open Latest", pageContent: '[ref_1] link "Latest"' },
      context(provider)
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "stop",
      reason: "decision_conflict",
    });
  });

  it("stops when the selected choice ties another candidate", async () => {
    const provider: DecisionProvider = {
      async decide(request) {
        const result = successfulDecision(request);
        const answer = result.answers.next_action;
        if (answer.type !== "choice" || !answer.probabilities) throw new Error("choice expected");
        const alternate = Object.keys(answer.probabilities).find((id) => id !== answer.choice)!;
        answer.probabilities[answer.choice] = 0.5;
        answer.probabilities[alternate] = 0.5;
        answer.confidence = 0.99;
        return result;
      },
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      { tabId: 7, goal: "Open Latest", pageContent: '[ref_1] link "Latest"' },
      context(provider)
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "stop",
      reason: "decision_conflict",
    });
  });

  it("preserves explicit-value-required when Jev coherently selects stop", async () => {
    const provider: DecisionProvider = {
      async decide(request) {
        const question = request.questions.next_action;
        if (question.type !== "choice") throw new Error("choice expected");
        const selected = Object.entries(question.criteria).find(([, description]) =>
          description.includes("Stop because no safe supplied action")
        )?.[0];
        if (!selected) throw new Error("stop candidate missing");
        return {
          answers: {
            next_action: {
              type: "choice",
              choice: selected,
              confidence: 0.99,
              probabilities: { [selected]: 0.99 },
            },
            goal_complete: { type: "noul", noul: 0.01 },
            candidates_sufficient: { type: "noul", noul: 0.01 },
            action_risk: { type: "score", score: 0 },
          },
          metadata,
        };
      },
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      {
        tabId: 7,
        goal: "Search for browser automation",
        pageContent: '[ref_1] searchbox "Query"',
      },
      context(provider)
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "stop",
      reason: "explicit_value_required",
    });
  });

  it("reports a conflict when Jev selects stop but says candidates are sufficient", async () => {
    const provider: DecisionProvider = {
      async decide(request) {
        const question = request.questions.next_action;
        if (question.type !== "choice") throw new Error("choice expected");
        const selected = Object.entries(question.criteria).find(([, description]) =>
          description.includes("Stop because no safe supplied action")
        )?.[0];
        if (!selected) throw new Error("stop candidate missing");
        return {
          answers: {
            next_action: {
              type: "choice",
              choice: selected,
              confidence: 0.99,
              probabilities: { [selected]: 0.99 },
            },
            goal_complete: { type: "noul", noul: 0.01 },
            candidates_sufficient: { type: "noul", noul: 0.99 },
            action_risk: { type: "score", score: 0 },
          },
          metadata,
        };
      },
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      { tabId: 7, goal: "Open Latest", pageContent: '[ref_1] link "Latest"' },
      context(provider)
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "stop",
      reason: "decision_conflict",
    });
  });

  it("stops unsupported visual-only goals before calling Jev", async () => {
    const provider: DecisionProvider & { decide: ReturnType<typeof vi.fn> } = {
      decide: vi.fn(),
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      {
        tabId: 7,
        goal: "Click the red icon shown in the screenshot",
        pageContent: '[ref_1] button "Delete account"',
      },
      context(provider)
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "stop",
      reason: "unsupported_visual_task",
    });
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it("stops spatial goals when candidate state has no geometry", async () => {
    const provider: DecisionProvider & { decide: ReturnType<typeof vi.fn> } = {
      decide: vi.fn(),
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      {
        tabId: 7,
        goal: "Click the leftmost button",
        pageContent: '[ref_1] button "One"\n[ref_2] button "Two"',
      },
      context(provider)
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "stop",
      reason: "unsupported_visual_task",
    });
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it("stops ordinary spatial phrasing when candidate state has no geometry", async () => {
    const provider: DecisionProvider & { decide: ReturnType<typeof vi.fn> } = {
      decide: vi.fn(),
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      {
        tabId: 7,
        goal: "Click the button on the left",
        pageContent: '[ref_1] button "One"\n[ref_2] button "Two"',
      },
      context(provider)
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "stop",
      reason: "unsupported_visual_task",
    });
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it("bounds goal text sent to Jev", async () => {
    const provider: DecisionProvider & { decide: ReturnType<typeof vi.fn> } = {
      decide: vi.fn(async (request: DecisionRequest) => successfulDecision(request)),
    };

    await handleAiTool(
      AI_TOOL_NAMES.AI_ACTION,
      {
        tabId: 7,
        goal: `Open Latest ${"x".repeat(100_000)}`,
        pageContent: '[ref_1] link "Latest"',
      },
      context(provider)
    );

    const request = provider.decide.mock.calls[0][0];
    expect(String(request.state.goal).length).toBeLessThanOrEqual(2_100);
  });
});
