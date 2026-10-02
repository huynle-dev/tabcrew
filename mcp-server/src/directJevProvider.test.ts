import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectJevProvider,
  InvalidJevResponseError,
  JevProviderError,
  loadJevConfig,
  type DecisionRequest,
} from "./directJevProvider.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

function decisionRequest(): DecisionRequest {
  return {
    state: {
      goal: "Open the latest article",
      page: '[ref_14] link "Latest"',
      history: [],
      candidates: { a000: "Click Latest at ref_14" },
    },
    questions: {
      next_action: {
        type: "choice",
        instructions: "Select one supplied candidate.",
        criteria: { a000: "Click Latest at ref_14" },
      },
      goal_complete: {
        type: "noul",
        instructions: "Is the goal complete?",
      },
      candidates_sufficient: {
        type: "noul",
        instructions: "Is a safe candidate available?",
      },
      action_risk: {
        type: "score",
        instructions: "Rate the action risk.",
        criteria: ["harmless", "reversible", "high risk"],
      },
    },
  };
}

function validResponse() {
  return {
    id: "gen-dec-1",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: {
      next_action: {
        type: "choice",
        choice: "a000",
        probabilities: { a000: 0.93 },
        confidence: 0.91,
      },
      goal_complete: { type: "noul", noul: 0.04 },
      candidates_sufficient: { type: "noul", noul: 0.97 },
      action_risk: {
        type: "score",
        score: 0.2,
        probabilities: { "0": 0.9, "1": 0.1, "2": 0 },
        confidence: 0.88,
      },
    },
    usage: { input_tokens: 430, output_tokens: 12, cost: 0.00001 },
  };
}

function provider() {
  return new DirectJevProvider({
    apiKey: "secret",
    baseUrl: "https://openrouter.ai/api/v1/",
    model: "typesafe/jev-1.13",
    actionThreshold: 0.8,
    assertThreshold: 0.8,
    sufficiencyThreshold: 0.8,
    maxAutoRisk: 1,
  });
}

describe("loadJevConfig", () => {
  it("uses strict direct-Jev defaults when only the API key is set", () => {
    process.env.CHROMEUSE_JEV_API_KEY = "secret";

    expect(loadJevConfig()).toEqual({
      apiKey: "secret",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "typesafe/jev-1.13",
      actionThreshold: 0.8,
      assertThreshold: 0.8,
      sufficiencyThreshold: 0.8,
      maxAutoRisk: 1,
    });
  });

  it.each([
    ["CHROMEUSE_JEV_ACTION_THRESHOLD", ""],
    ["CHROMEUSE_JEV_ACTION_THRESHOLD", "NaN"],
    ["CHROMEUSE_JEV_ASSERT_THRESHOLD", "1.01"],
    ["CHROMEUSE_JEV_SUFFICIENCY_THRESHOLD", "-0.01"],
    ["CHROMEUSE_JEV_MAX_AUTO_RISK", "Infinity"],
    ["CHROMEUSE_JEV_MAX_AUTO_RISK", "2.01"],
  ])("rejects invalid %s=%j", (name, value) => {
    process.env.CHROMEUSE_JEV_API_KEY = "secret";
    process.env[name] = value;
    expect(() => loadJevConfig()).toThrow(name);
  });

  it.each([
    ["CHROMEUSE_JEV_API_KEY", "   "],
    ["CHROMEUSE_JEV_BASE_URL", ""],
    ["CHROMEUSE_JEV_MODEL", "   "],
  ])("rejects blank %s", (name, value) => {
    process.env.CHROMEUSE_JEV_API_KEY = "secret";
    process.env[name] = value;
    expect(() => loadJevConfig()).toThrow(name);
  });
});

describe("DirectJevProvider", () => {
  it("posts the raw System One contract and maps validated metadata", async () => {
    const response = validResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await provider().decide(decisionRequest());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "typesafe/jev-1.13",
      ...decisionRequest(),
    });
    expect(result.answers.next_action).toMatchObject({
      type: "choice",
      choice: "a000",
      confidence: 0.91,
    });
    expect(result.metadata).toMatchObject({
      provider: "direct-jev",
      requestedModel: "typesafe/jev-1.13",
      resolvedModel: "typesafe/jev-1.13-20260917",
      requestId: "gen-dec-1",
      usage: { inputTokens: 430, outputTokens: 12, cost: 0.00001 },
    });
  });

  it("serializes only the configured model plus state and questions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validResponse()), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      ...decisionRequest(),
      model: "attacker-controlled-model",
      unrelated: "not part of the wire contract",
    } as DecisionRequest;

    await provider().decide(request);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      model: "typesafe/jev-1.13",
      state: request.state,
      questions: request.questions,
    });
  });

  it("classifies malformed successful JSON as an invalid provider response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not-json", { status: 200 })
    ));

    await expect(provider().decide(decisionRequest())).rejects.toMatchObject({
      code: "invalid_provider_response",
      name: "InvalidJevResponseError",
    });
  });

  it("preserves abort errors raised while consuming a successful response", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(abortError),
    } as unknown as Response));

    await expect(provider().decide(decisionRequest())).rejects.toBe(abortError);
  });

  it("rejects empty score criteria before calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = decisionRequest();
    request.questions.action_risk = {
      type: "score",
      instructions: "Rate the action risk.",
      criteria: [],
    };

    await expect(provider().decide(request)).rejects.toBeInstanceOf(
      InvalidJevResponseError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires every requested answer and matching primitive type", async () => {
    const response = validResponse();
    delete (response.answers as Record<string, unknown>).goal_complete;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 })
    ));

    await expect(provider().decide(decisionRequest())).rejects.toThrow(
      /missing answer.*goal_complete/i
    );
  });

  it("rejects a choice that was not supplied in the request criteria", async () => {
    const response = validResponse();
    response.answers.next_action.choice = "invented-action";
    response.answers.next_action.probabilities = { "invented-action": 0.99 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 })
    ));

    await expect(provider().decide(decisionRequest())).rejects.toBeInstanceOf(
      InvalidJevResponseError
    );
  });

  it("does not accept inherited choice criteria names", async () => {
    const response = validResponse();
    response.answers.next_action.choice = "constructor";
    response.answers.next_action.probabilities = { constructor: 0.99 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 })
    ));

    await expect(provider().decide(decisionRequest())).rejects.toBeInstanceOf(
      InvalidJevResponseError
    );
  });

  it.each([
    ["id", 42],
    ["provider", { name: "TypeSafe" }],
  ])("rejects malformed optional response field %s", async (field, value) => {
    const response = validResponse() as Record<string, unknown>;
    response[field] = value;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 })
    ));

    await expect(provider().decide(decisionRequest())).rejects.toBeInstanceOf(
      InvalidJevResponseError
    );
  });

  it("rejects a malformed score legend when the field is present", async () => {
    const response = validResponse();
    (response.answers.action_risk as Record<string, unknown>).legend = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 })
    ));

    await expect(provider().decide(decisionRequest())).rejects.toBeInstanceOf(
      InvalidJevResponseError
    );
  });

  it.each([
    ["noul", 1.1],
    ["confidence", Number.NaN],
    ["probability", -0.1],
    ["input tokens", 1.5],
    ["cost", -0.01],
  ])("rejects malformed %s values", async (kind, invalidValue) => {
    const response = validResponse();
    if (kind === "noul") response.answers.goal_complete.noul = invalidValue;
    if (kind === "confidence") response.answers.next_action.confidence = invalidValue;
    if (kind === "probability") response.answers.next_action.probabilities.a000 = invalidValue;
    if (kind === "input tokens") response.usage.input_tokens = invalidValue;
    if (kind === "cost") response.usage.cost = invalidValue;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 })
    ));

    await expect(provider().decide(decisionRequest())).rejects.toBeInstanceOf(
      InvalidJevResponseError
    );
  });

  it("maps structured OpenRouter HTTP errors without exposing credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 429, message: "Rate limit exceeded" } }),
        { status: 429 }
      )
    ));

    const error = await provider().decide(decisionRequest()).catch((value) => value);
    expect(error).toBeInstanceOf(JevProviderError);
    expect(error).toMatchObject({ status: 429, code: "provider_error" });
    expect(error.message).toBe("Direct Jev API 429: Rate limit exceeded");
    expect(error.message).not.toContain("secret");
  });

  it("passes the caller AbortSignal directly to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validResponse()), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await provider().decide(decisionRequest(), controller.signal);

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
