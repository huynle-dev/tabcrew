import { describe, expect, it, vi } from "vitest";
import { AI_TOOL_NAMES, handleAiTool } from "./aiTools.js";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./decisionTypes.js";
import type { BrowserTransport } from "./transport.js";

const metadata: DecisionResult["metadata"] = {
  provider: "direct-jev",
  requestedModel: "typesafe/jev-1.13",
  resolvedModel: "typesafe/jev-1.13-20260917",
  requestId: "req-1",
  latencyMs: 12,
  usage: { inputTokens: 20, outputTokens: 2, cost: 0.00001 },
};

function fakeBrowser(): BrowserTransport {
  return {
    connected: true,
    async connect() {},
    disconnect() {},
    async sendToolRequest() {
      return { content: [{ type: "text", text: "Dashboard" }] };
    },
  };
}

function providerWith(result: DecisionResult) {
  const decide = vi.fn(async (_request: DecisionRequest) => result);
  return { decide } satisfies DecisionProvider;
}

describe("ai_assert direct Jev handler", () => {
  it("gates a Noul answer at the configured threshold with deterministic reasoning", async () => {
    const provider = providerWith({
      answers: { assertion: { type: "noul", noul: 0.91 } },
      metadata,
    });

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ASSERT,
      { tabId: 7, condition: "the dashboard is visible", pageContent: "Dashboard" },
      {
        provider,
        browser: fakeBrowser(),
        clientId: "test",
        thresholds: {
          action: 0.8,
          assertion: 0.8,
          sufficiency: 0.8,
          maxRisk: 1,
        },
      } as never
    );

    const output = JSON.parse(result.content[0].text);
    expect(output).toMatchObject({
      pass: true,
      probability: 0.91,
      threshold: 0.8,
      reason: "probability 0.91 met threshold 0.80",
      _meta: metadata,
    });
    expect(provider.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { condition: "the dashboard is visible", page: "Dashboard" },
        questions: {
          assertion: expect.objectContaining({ type: "noul" }),
        },
      }),
      undefined
    );
  });

  it("returns a reproducible failed assertion below threshold", async () => {
    const provider = providerWith({
      answers: { assertion: { type: "noul", noul: 0.79 } },
      metadata,
    });
    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ASSERT,
      { tabId: 7, condition: "signed in", pageContent: "Sign in" },
      {
        provider,
        browser: fakeBrowser(),
        clientId: "test",
        thresholds: { action: 0.8, assertion: 0.8, sufficiency: 0.8, maxRisk: 1 },
      } as never
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      pass: false,
      probability: 0.79,
      reason: "probability 0.79 did not meet threshold 0.80",
    });
  });

  it("reports an aborted assertion as cancelled regardless of abort reason text", async () => {
    const controller = new AbortController();
    const provider: DecisionProvider = {
      async decide() {
        controller.abort(new Error("deadline exceeded"));
        throw new Error("deadline exceeded");
      },
    };

    const result = await handleAiTool(
      AI_TOOL_NAMES.AI_ASSERT,
      { tabId: 7, condition: "signed in", pageContent: "Dashboard" },
      {
        provider,
        browser: fakeBrowser(),
        clientId: "test",
        thresholds: { action: 0.8, assertion: 0.8, sufficiency: 0.8, maxRisk: 1 },
        signal: controller.signal,
      } as never
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      pass: false,
      error: "cancelled",
    });
  });
});
