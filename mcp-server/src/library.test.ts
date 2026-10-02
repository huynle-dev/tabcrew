import { describe, expect, it } from "vitest";
import {
  DirectJevProvider,
  WebSocketBridge,
  WebSocketFirstTransport,
  buildActionCandidates,
  createMcpServer,
  getToolSchemas,
  loadJevConfig,
} from "./library.js";
import type {
  BrowserTransport,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  ToolRequestResult,
  WebSocketBridgeOptions,
} from "./library.js";

describe("library exports", () => {
  it("exports reusable server APIs without starting stdio", () => {
    expect(createMcpServer).toBeTypeOf("function");
    expect(WebSocketFirstTransport).toBeTypeOf("function");
    expect(WebSocketBridge).toBeTypeOf("function");
    expect(getToolSchemas().length).toBeGreaterThan(0);
  });

  it("exports browser transport types", () => {
    const transport: BrowserTransport = {
      connected: true,
      connect: async () => {},
      sendToolRequest: async (): Promise<ToolRequestResult> => ({
        content: [{ type: "text", text: "ok" }],
      }),
      disconnect: () => {},
    };

    expect(transport.connected).toBe(true);
  });

  it("exports WebSocket bridge configuration types", () => {
    const options: WebSocketBridgeOptions = { host: "127.0.0.1", port: 0 };

    expect(options.port).toBe(0);
  });

  it("exports direct Jev provider, candidate, and decision APIs", () => {
    expect(DirectJevProvider).toBeTypeOf("function");
    expect(loadJevConfig).toBeTypeOf("function");
    expect(buildActionCandidates).toBeTypeOf("function");

    const request: DecisionRequest = { state: {}, questions: {} };
    const result: DecisionResult = {
      answers: {},
      metadata: {
        provider: "direct-jev",
        requestedModel: "typesafe/jev-1.13",
        resolvedModel: "typesafe/jev-1.13",
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
    const provider: DecisionProvider = { async decide() { return result; } };
    expect(request.questions).toEqual({});
    expect(provider).toBeDefined();
  });
});
