import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AiProvider, loadAiConfig } from "./aiProvider.js";
import { AI_TOOL_SCHEMAS, AI_TOOL_NAMES } from "./aiTools.js";

describe("loadAiConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when CHROMEUSE_AI_API_KEY is not set", () => {
    delete process.env.CHROMEUSE_AI_API_KEY;
    expect(loadAiConfig()).toBeNull();
  });

  it("returns config with defaults when only API key is set", () => {
    process.env.CHROMEUSE_AI_API_KEY = "test-key";
    const config = loadAiConfig();
    expect(config).toEqual({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "typesafe/jev-router",
      defaultMaxTokens: 500,
    });
  });

  it("respects custom env overrides", () => {
    process.env.CHROMEUSE_AI_API_KEY = "custom-key";
    process.env.CHROMEUSE_AI_BASE_URL = "https://api.example.com/v1";
    process.env.CHROMEUSE_AI_MODEL = "openai/gpt-4o";
    process.env.CHROMEUSE_AI_MAX_TOKENS = "1000";

    const config = loadAiConfig();
    expect(config).toEqual({
      apiKey: "custom-key",
      baseUrl: "https://api.example.com/v1",
      model: "openai/gpt-4o",
      defaultMaxTokens: 1000,
    });
  });
});

describe("AiProvider", () => {
  it("reports available when configured", () => {
    const provider = new AiProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "typesafe/jev-router",
      defaultMaxTokens: 500,
    });
    expect(provider.available).toBe(true);
  });

  it("makes correct API call shape", async () => {
    const mockResponse = {
      model: "openai/gpt-6-luna",
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new AiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "test-model",
      defaultMaxTokens: 100,
    });

    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/v1/chat/completions");

    const body = JSON.parse(opts.body);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(100);

    expect(result.text).toBe("hello");
    expect(result.model).toBe("openai/gpt-6-luna");
    expect(result.usage?.promptTokens).toBe(10);

    vi.unstubAllGlobals();
  });

  it("throws on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new AiProvider({
      apiKey: "bad-key",
      baseUrl: "https://example.com/v1",
      model: "test",
      defaultMaxTokens: 100,
    });

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow("AI API 401: Unauthorized");

    vi.unstubAllGlobals();
  });
});

describe("no-key safety", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loadAiConfig returns null without key — AI tools never register", () => {
    delete process.env.CHROMEUSE_AI_API_KEY;
    expect(loadAiConfig()).toBeNull();
  });

  it("AI tool schemas include ai_navigate", () => {
    const names = AI_TOOL_SCHEMAS.map((s) => s.name);
    expect(names).toContain(AI_TOOL_NAMES.AI_ACTION);
    expect(names).toContain(AI_TOOL_NAMES.AI_ASSERT);
    expect(names).toContain(AI_TOOL_NAMES.AI_NAVIGATE);
  });

  it("AI tool names are correct strings", () => {
    expect(AI_TOOL_NAMES.AI_ACTION).toBe("ai_action");
    expect(AI_TOOL_NAMES.AI_ASSERT).toBe("ai_assert");
    expect(AI_TOOL_NAMES.AI_NAVIGATE).toBe("ai_navigate");
  });
});
