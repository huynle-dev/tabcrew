import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonError } from "../errors.js";
import { actionSpace } from "../observe.js";
import { flightsSnapshot } from "../testing/fixtures.js";
import { simpleSnapshot } from "../testing/helpers.js";
import { Limiter } from "./browse.js";
import { buildDecisionRequest, postJson, validateChoice, type ModelSettings } from "./decisions.js";
import { NEXT_ACTION, TARGET, TEXT_VALUE } from "./questions.js";
import { fieldContext, fieldText, parseTextReply } from "./text.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const settings: ModelSettings = {
  jevModel: "typesafe/jev-1.13",
  textModel: "inception/mercury-2.5",
  openrouterApiKey: "test-key",
  textModelReasoning: "none",
  retryBaseMs: 1,
};

function code(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (err) {
    return err instanceof DaemonError ? err.code : "other";
  }
}

describe("buildDecisionRequest", () => {
  it("asks one operation question plus a target head per available element operation", () => {
    const snap = flightsSnapshot();
    const space = actionSpace(snap.actions);
    const { body, operations } = buildDecisionRequest(snap, space, "Find flights", [], "typesafe/jev-1.13");
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(body.questions)).toEqual(["operation", "type_text_target", "click_target", "select_target"]);
    expect(operations).toEqual(["TYPE_TEXT", "CLICK", "SELECT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
    const q = body.questions as Record<string, any>;
    expect(q.operation.type).toBe("choice");
    expect(q.operation.instructions).toEqual({ goal: "Find flights", rules: NEXT_ACTION });
    expect(q.operation.criteria.SCROLL_DOWN).toBe("Scroll down");
    expect(q.operation.criteria.DONE).toBe("Every requirement is visibly satisfied.");
    expect(q.click_target.instructions).toEqual({ goal: "Find flights", operation: "CLICK", rules: [NEXT_ACTION, TARGET] });
    expect(Object.keys(q.click_target.criteria)).toEqual(["1", "2", "4", "5", "6"]);
    expect(q.click_target.criteria["1"]).toEqual({ element: "[1] Open Where from?", current_value: "Zürich", role: "combobox" });
    expect(q.click_target.criteria["5"]).toEqual({ element: "[5] Refundable", current_value: "on", role: "checkbox", checked: "false" });
    expect(q.click_target.criteria["6"]).toMatchObject({ expanded: "false" });
    expect(Object.keys(q.select_target.criteria)).toEqual(["3:1", "3:2", "3:3"]);
    expect(q.select_target.criteria["3:2"]).toEqual({ element: "[3:2] Sort by → Duration", current_value: "Best", role: "combobox" });
    expect(Object.keys(q.type_text_target.criteria)).toEqual(["1"]);
    const state = body.state as any;
    expect(state.page).toEqual({ url: snap.url, title: snap.title, text: snap.text });
    expect(state.elements[0]).toMatchObject({ index: "1", label: "Where from?", operations: ["TYPE_TEXT", "CLICK"] });
    expect(state.recent_actions).toEqual([]);
  });

  it("offers only the operations the page supports and the last 10 actions", () => {
    const snap = simpleSnapshot(1);
    const history = Array.from({ length: 12 }, (_, i) => ({ action: `a${i}`, kind: "click", text: null, page_changed: i % 2 === 0 }));
    const { body, operations } = buildDecisionRequest(snap, actionSpace(snap.actions), "g", history, "m");
    expect(Object.keys(body.questions)).toEqual(["operation", "click_target"]);
    expect(operations).toEqual(["CLICK", "WAIT", "DONE", "BLOCKED"]);
    const recent = (body.state as any).recent_actions;
    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({ action: "a2", kind: "click", text: null, page_changed: true });
  });
});

describe("validateChoice", () => {
  const ids = ["CLICK", "WAIT", "DONE"];
  const good = { choice: "CLICK", probabilities: { CLICK: 0.7, WAIT: 0.2, DONE: 0.1 }, confidence: 0.9 };

  it("accepts a consistent answer", () => {
    expect(validateChoice(good, ids)).toBe(good);
    expect(code(() => validateChoice({ ...good, probabilities: { CLICK: 0.5, WAIT: 0.49, DONE: 0.0 } }, ids))).toBe("ok");
  });

  it.each([
    ["unknown choice", { ...good, choice: "EVAL" }],
    ["missing id", { ...good, probabilities: { CLICK: 0.8, WAIT: 0.2 } }],
    ["extra id", { ...good, probabilities: { ...good.probabilities, EVAL: 0 } }],
    ["probabilities not summing to 1", { ...good, probabilities: { CLICK: 0.4, WAIT: 0.1, DONE: 0.1 } }],
    ["choice not argmax", { ...good, probabilities: { CLICK: 0.2, WAIT: 0.7, DONE: 0.1 } }],
    ["NaN probability", { ...good, probabilities: { CLICK: Number.NaN, WAIT: 0.5, DONE: 0.5 } }],
    ["NaN confidence", { ...good, confidence: Number.NaN }],
    ["string probability", { ...good, probabilities: { CLICK: "0.7", WAIT: 0.2, DONE: 0.1 } }],
    ["boolean confidence", { ...good, confidence: true }],
    ["negative probability", { ...good, probabilities: { CLICK: 1.1, WAIT: -0.1, DONE: 0 } }],
    ["missing", undefined],
    ["array probabilities", { ...good, probabilities: [0.7, 0.2, 0.1] }],
  ])("rejects %s", (_name, answer) => {
    expect(code(() => validateChoice(answer, ids))).toBe("model_error");
  });
});

describe("text helper", () => {
  it.each([
    ['{"text": "Zurich"}', "Zurich"],
    ['```json\n{"text": "Zurich"}\n```', "Zurich"],
    ['```\n{"text": "London"}```', "London"],
    ['  {"text": " padded "}  ', " padded "],
  ])("accepts %j", (reply, value) => {
    expect(parseTextReply(reply)).toBe(value);
  });

  it.each([
    ["extra keys", '{"text": "Zurich", "why": "goal"}'],
    ["empty", '{"text": ""}'],
    ["blank", '{"text": "   "}'],
    ["null", '{"text": null}'],
    ["number", '{"text": 5}'],
    ["too long", JSON.stringify({ text: "x".repeat(2001) })],
    ["prose", "Sure! Zurich"],
    ["array", '["Zurich"]'],
    ["not a string", 42],
  ])("rejects %s", (_name, reply) => {
    expect(code(() => parseTextReply(reply))).toBe("model_error");
  });

  it("sends the field context with reasoning disabled by default and returns cost", async () => {
    const requests: { url: string; body: any; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return Response.json({ choices: [{ message: { content: '{"text": "Zurich"}' } }], usage: { cost: 0.0002 } });
    });
    const snap = flightsSnapshot();
    const history = [{ action: "Open Where from?", kind: "click", text: null, page_changed: true }];
    const context = fieldContext("Fly from Zurich", snap.actions[0], { ...snap, text: "y".repeat(7000) }, history);
    expect(context.field).toEqual({ label: "Where from?", role: "combobox", value: "Zürich" });
    expect(context.page.text).toHaveLength(6000);
    expect(context.recent_actions).toEqual([{ action: "Open Where from?", text: null }]);
    const out = await fieldText(context, settings);
    expect(out).toMatchObject({ text: "Zurich", model: "inception/mercury-2.5", cost: 0.0002 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0].auth).toBe("Bearer test-key");
    expect(requests[0].body).toMatchObject({
      model: "inception/mercury-2.5",
      max_tokens: 1024,
      response_format: { type: "json_object" },
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: TEXT_VALUE },
        { role: "user", content: JSON.stringify(context) },
      ],
    });
  });

  it("uses the text-model key, base URL and reasoning overrides", async () => {
    const requests: { url: string; body: any; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return Response.json({ choices: [{ message: { content: '{"text": "a"}' } }] });
    });
    const context = fieldContext("g", flightsSnapshot().actions[0], flightsSnapshot(), []);
    await fieldText(context, { ...settings, textModelApiKey: "tk", textModelBaseUrl: "https://llm.test/v1/", textModelReasoning: "low" });
    expect(requests[0].url).toBe("https://llm.test/v1/chat/completions");
    expect(requests[0].auth).toBe("Bearer tk");
    expect(requests[0].body.reasoning).toEqual({ effort: "low" });
  });
});

describe("text helper fallback", () => {
  const context = () => fieldContext("g", flightsSnapshot().actions[0], flightsSnapshot(), []);
  const withFallback: ModelSettings = { ...settings, textModelFallback: "google/gemini-2.5-flash-lite", textModelTimeoutMs: 50 };
  const reply = (text: string) => Response.json({ choices: [{ message: { content: JSON.stringify({ text }) } }] });

  function stub(byModel: Record<string, () => Promise<Response>>) {
    const models: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      models.push(model);
      // Honour the abort signal like real fetch does.
      return await Promise.race([
        byModel[model](),
        new Promise<never>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
      ]);
    });
    return models;
  }
  const never = () => new Promise<Response>(() => {});

  it("does not call the fallback when the primary answers", async () => {
    const models = stub({ "inception/mercury-2.5": async () => reply("Zurich") });
    expect(await fieldText(context(), withFallback)).toMatchObject({ text: "Zurich", model: "inception/mercury-2.5" });
    expect(models).toEqual(["inception/mercury-2.5"]);
  });

  it("falls back once when the primary times out", async () => {
    const models = stub({ "inception/mercury-2.5": never, "google/gemini-2.5-flash-lite": async () => reply("Zurich") });
    expect(await fieldText(context(), withFallback)).toMatchObject({ text: "Zurich", model: "google/gemini-2.5-flash-lite" });
    expect(models).toEqual(["inception/mercury-2.5", "google/gemini-2.5-flash-lite"]);
  });

  it("falls back when the primary returns the wrong shape", async () => {
    const models = stub({
      "inception/mercury-2.5": async () => Response.json({ choices: [{ message: { content: '{"field":"x","query":"y"}' } }] }),
      "google/gemini-2.5-flash-lite": async () => reply("London"),
    });
    expect((await fieldText(context(), withFallback)).text).toBe("London");
    expect(models).toHaveLength(2);
  });

  it("reports a timeout as a timeout when both models fail, and never tries a third", async () => {
    const models = stub({ "inception/mercury-2.5": never, "google/gemini-2.5-flash-lite": never });
    await expect(fieldText(context(), withFallback)).rejects.toMatchObject({ code: "model_error", message: expect.stringContaining("timed out") });
    expect(models).toHaveLength(2);
  });

  it("has no fallback when it is disabled", async () => {
    const models = stub({ "inception/mercury-2.5": never });
    await expect(fieldText(context(), { ...withFallback, textModelFallback: null })).rejects.toMatchObject({ code: "model_error" });
    expect(models).toEqual(["inception/mercury-2.5"]);
  });
});

describe("postJson", () => {
  it("retries 429/503/529 at most twice, then fails with model_error", async () => {
    const statuses: number[] = [];
    vi.stubGlobal("fetch", async () => {
      const status = [429, 503, 529][statuses.length] ?? 200;
      statuses.push(status);
      return new Response("{}", { status });
    });
    await expect(postJson("https://x.test", "k", {}, settings)).rejects.toMatchObject({ code: "model_error", message: expect.stringContaining("HTTP 529") });
    expect(statuses).toEqual([429, 503, 529]);
  });

  it("returns the body after a retried 429", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => (n++ === 0 ? new Response("busy", { status: 429 }) : Response.json({ ok: 1 })));
    await expect(postJson("https://x.test", "k", {}, settings)).resolves.toEqual({ ok: 1 });
    expect(n).toBe(2);
  });

  it("does not retry other errors, connection failures or invalid JSON", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      return new Response("nope", { status: 500 });
    });
    await expect(postJson("https://x.test", "k", {}, settings)).rejects.toMatchObject({ code: "model_error" });
    expect(n).toBe(1);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(postJson("https://x.test", "k", {}, settings)).rejects.toMatchObject({ code: "model_error" });
    vi.stubGlobal("fetch", async () => new Response('{"answers": NaN}', { status: 200 }));
    await expect(postJson("https://x.test", "k", {}, settings)).rejects.toMatchObject({ code: "model_error" });
  });
});

describe("Limiter", () => {
  it("caps concurrency and hands slots out in FIFO order", async () => {
    const limiter = new Limiter(2);
    const order: string[] = [];
    const r1 = await limiter.acquire();
    const r2 = await limiter.acquire();
    const waiters = ["a", "b", "c"].map((name) => limiter.acquire().then((release) => (order.push(name), release)));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    expect(limiter.waiting).toBe(3);
    r1();
    r1(); // releasing twice is a no-op
    const ra = await waiters[0];
    expect(order).toEqual(["a"]);
    r2();
    ra();
    await Promise.all(waiters);
    expect(order).toEqual(["a", "b", "c"]);
    for (const w of waiters) (await w)();
    expect(limiter.running).toBe(0);
  });
});
