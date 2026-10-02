import type {
  ChoiceAnswer,
  DecisionAnswer,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  NoulAnswer,
  ScoreAnswer,
} from "./decisionTypes.js";

export type { DecisionRequest, DecisionResult } from "./decisionTypes.js";

export interface JevConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  actionThreshold: number;
  assertThreshold: number;
  sufficiencyThreshold: number;
  maxAutoRisk: number;
}

export function loadJevConfig(): JevConfig | null {
  const configuredApiKey = process.env.CHROMEUSE_JEV_API_KEY;
  if (configuredApiKey === undefined) return null;
  const apiKey = requireNonBlank("CHROMEUSE_JEV_API_KEY", configuredApiKey);

  return {
    apiKey,
    baseUrl: requireNonBlank(
      "CHROMEUSE_JEV_BASE_URL",
      process.env.CHROMEUSE_JEV_BASE_URL ?? "https://openrouter.ai/api/v1"
    ),
    model: requireNonBlank(
      "CHROMEUSE_JEV_MODEL",
      process.env.CHROMEUSE_JEV_MODEL ?? "typesafe/jev-1.13"
    ),
    actionThreshold: parseUnitInterval(
      "CHROMEUSE_JEV_ACTION_THRESHOLD",
      process.env.CHROMEUSE_JEV_ACTION_THRESHOLD ?? "0.80"
    ),
    assertThreshold: parseUnitInterval(
      "CHROMEUSE_JEV_ASSERT_THRESHOLD",
      process.env.CHROMEUSE_JEV_ASSERT_THRESHOLD ?? "0.80"
    ),
    sufficiencyThreshold: parseUnitInterval(
      "CHROMEUSE_JEV_SUFFICIENCY_THRESHOLD",
      process.env.CHROMEUSE_JEV_SUFFICIENCY_THRESHOLD ?? "0.80"
    ),
    maxAutoRisk: parseRisk(
      "CHROMEUSE_JEV_MAX_AUTO_RISK",
      process.env.CHROMEUSE_JEV_MAX_AUTO_RISK ?? "1.0"
    ),
  };
}

function requireNonBlank(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must be a non-empty string`);
  return trimmed;
}

export class DirectJevProvider implements DecisionProvider {
  constructor(readonly config: JevConfig) {}

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    signal?.throwIfAborted();
    validateDecisionRequest(request);
    const startedAt = performance.now();
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, "")}/systemone`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          state: request.state,
          questions: request.questions,
        }),
        signal,
      }
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      throw await JevProviderError.fromResponse(response);
    }

    let wire: unknown;
    try {
      wire = await response.json() as unknown;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      throw new InvalidJevResponseError("response body must be valid JSON");
    }
    return parseDecisionResponse(wire, request, this.config.model, latencyMs);
  }
}

export class InvalidJevResponseError extends Error {
  readonly code = "invalid_provider_response";

  constructor(message: string) {
    super(`Invalid direct Jev response: ${message}`);
    this.name = "InvalidJevResponseError";
  }
}

export class JevProviderError extends Error {
  readonly code = "provider_error";

  constructor(readonly status: number, message: string) {
    super(`Direct Jev API ${status}: ${message}`);
    this.name = "JevProviderError";
  }

  static async fromResponse(response: Response): Promise<JevProviderError> {
    let message = response.statusText || "Request failed";
    try {
      const body = await response.json() as unknown;
      if (
        isRecord(body) &&
        isRecord(body.error) &&
        typeof body.error.message === "string"
      ) {
        message = body.error.message;
      }
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text;
    }
    return new JevProviderError(response.status, message);
  }
}

function parseDecisionResponse(
  value: unknown,
  request: DecisionRequest,
  requestedModel: string,
  latencyMs: number
): DecisionResult {
  const root = requireRecord(value, "response");
  if (typeof root.model !== "string" || root.model.length === 0) {
    invalid("model must be a non-empty string");
  }
  const rawAnswers = requireRecord(root.answers, "answers");
  const answers: Record<string, DecisionAnswer> = Object.create(null) as Record<
    string,
    DecisionAnswer
  >;
  for (const [name, question] of Object.entries(request.questions)) {
    if (!hasOwn(rawAnswers, name)) invalid(`missing answer for ${name}`);
    const answer = parseAnswer(rawAnswers[name], `answers.${name}`);
    validateAnswerForQuestion(answer, question, `answers.${name}`);
    answers[name] = answer;
  }
  for (const name of Object.keys(rawAnswers)) {
    if (!hasOwn(request.questions, name)) invalid(`unexpected answer ${name}`);
  }

  const requestId = optionalNonEmptyString(root, "id", "id");
  const upstreamProvider = optionalNonEmptyString(root, "provider", "provider");

  const usage = requireRecord(root.usage, "usage");
  const inputTokens = requireNonNegativeInteger(usage.input_tokens, "usage.input_tokens");
  const outputTokens = requireNonNegativeInteger(usage.output_tokens, "usage.output_tokens");
  const cost = usage.cost === undefined
    ? undefined
    : requireNonNegativeFinite(usage.cost, "usage.cost");

  return {
    answers,
    metadata: {
      provider: "direct-jev",
      requestedModel,
      resolvedModel: root.model as string,
      ...(requestId === undefined ? {} : { requestId }),
      ...(upstreamProvider === undefined ? {} : { upstreamProvider }),
      latencyMs,
      usage: {
        inputTokens,
        outputTokens,
        ...(cost === undefined ? {} : { cost }),
      },
    },
  };
}

function validateAnswerForQuestion(
  answer: DecisionAnswer,
  question: DecisionRequest["questions"][string],
  path: string
): void {
  if (answer.type !== question.type) {
    invalid(`${path}.type does not match requested ${question.type} primitive`);
  }

  if (answer.type === "choice" && question.type === "choice") {
    if (!hasOwn(question.criteria, answer.choice)) {
      invalid(`${path}.choice was not present in request criteria`);
    }
    for (const key of Object.keys(answer.probabilities ?? {})) {
      if (!hasOwn(question.criteria, key)) {
        invalid(`${path}.probabilities contains unknown choice ${key}`);
      }
    }
  }

  if (answer.type === "score" && question.type === "score") {
    const maximum = question.criteria.length - 1;
    if (answer.score < 0 || answer.score > maximum) {
      invalid(`${path}.score must be between 0 and ${maximum}`);
    }
    for (const key of Object.keys(answer.probabilities ?? {})) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index > maximum) {
        invalid(`${path}.probabilities contains unknown score level ${key}`);
      }
    }
  }
}

function parseAnswer(value: unknown, path: string): DecisionAnswer {
  const answer = requireRecord(value, path);
  switch (answer.type) {
    case "choice":
      return parseChoiceAnswer(answer, path);
    case "noul":
      return parseNoulAnswer(answer, path);
    case "score":
      return parseScoreAnswer(answer, path);
    default:
      return invalid(`${path}.type must be choice, noul, or score`);
  }
}

function parseChoiceAnswer(answer: Record<string, unknown>, path: string): ChoiceAnswer {
  if (typeof answer.choice !== "string" || answer.choice.length === 0) {
    invalid(`${path}.choice must be a non-empty string`);
  }
  return {
    type: "choice",
    choice: answer.choice as string,
    ...parseProbabilisticFields(answer, path),
  };
}

function parseNoulAnswer(answer: Record<string, unknown>, path: string): NoulAnswer {
  return {
    type: "noul",
    noul: requireProbability(answer.noul, `${path}.noul`),
  };
}

function parseScoreAnswer(answer: Record<string, unknown>, path: string): ScoreAnswer {
  const score = requireFinite(answer.score, `${path}.score`);
  const legend = answer.legend === undefined
    ? undefined
    : requireRecord(answer.legend, `${path}.legend`);
  return {
    type: "score",
    score,
    ...parseProbabilisticFields(answer, path),
    ...(legend === undefined ? {} : { legend }),
  };
}

function validateDecisionRequest(request: DecisionRequest): void {
  if (!isRecord(request)) invalid("request must be an object");
  requireRecord(request.state, "state");
  const questions = requireRecord(request.questions, "questions");
  if (Object.keys(questions).length === 0) invalid("questions must not be empty");

  for (const [name, rawQuestion] of Object.entries(questions)) {
    const question = requireRecord(rawQuestion, `questions.${name}`);
    if (typeof question.instructions !== "string" || question.instructions.trim() === "") {
      invalid(`questions.${name}.instructions must be a non-empty string`);
    }
    if (question.type === "choice") {
      const criteria = requireRecord(question.criteria, `questions.${name}.criteria`);
      if (Object.keys(criteria).length === 0) {
        invalid(`questions.${name}.criteria must not be empty`);
      }
      for (const [key, description] of Object.entries(criteria)) {
        if (typeof description !== "string" || description.trim() === "") {
          invalid(`questions.${name}.criteria.${key} must be a non-empty string`);
        }
      }
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
        invalid(`questions.${name}.criteria must be a non-empty array`);
      }
      question.criteria.forEach((criterion, index) => {
        if (typeof criterion !== "string" || criterion.trim() === "") {
          invalid(`questions.${name}.criteria.${index} must be a non-empty string`);
        }
      });
    } else if (question.type !== "noul") {
      invalid(`questions.${name}.type must be choice, noul, or score`);
    }
  }
}

function optionalNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${path} must be a non-empty string when present`);
  }
  return value as string;
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function parseProbabilisticFields(
  answer: Record<string, unknown>,
  path: string
): { probabilities?: Record<string, number>; confidence?: number } {
  const result: { probabilities?: Record<string, number>; confidence?: number } = {};
  if (answer.confidence !== undefined) {
    result.confidence = requireProbability(answer.confidence, `${path}.confidence`);
  }
  if (answer.probabilities !== undefined) {
    const probabilities = requireRecord(answer.probabilities, `${path}.probabilities`);
    result.probabilities = Object.fromEntries(
      Object.entries(probabilities).map(([key, probability]) => [
        key,
        requireProbability(probability, `${path}.probabilities.${key}`),
      ])
    );
  }
  return result;
}

function parseUnitInterval(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1 || raw.trim() === "") {
    throw new Error(`${name} must be a finite number between 0 and 1`);
  }
  return value;
}

function parseRisk(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2 || raw.trim() === "") {
    throw new Error(`${name} must be a finite number between 0 and 2`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireProbability(value: unknown, path: string): number {
  const number = requireFinite(value, path);
  if (number < 0 || number > 1) invalid(`${path} must be between 0 and 1`);
  return number;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${path} must be a finite number`);
  }
  return value as number;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
  const number = requireFinite(value, path);
  if (number < 0) invalid(`${path} must be non-negative`);
  return number;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  const number = requireNonNegativeFinite(value, path);
  if (!Number.isInteger(number)) invalid(`${path} must be an integer`);
  return number;
}

function invalid(message: string): never {
  throw new InvalidJevResponseError(message);
}
