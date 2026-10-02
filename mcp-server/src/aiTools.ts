import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildActionCandidates, type CandidateSet } from "./actionCandidates.js";
import {
  InvalidJevResponseError,
  JevProviderError,
} from "./directJevProvider.js";
import type {
  ActionCandidate,
  BrowserAction,
  ChoiceAnswer,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionStopReason,
  NoulAnswer,
  ScoreAnswer,
} from "./decisionTypes.js";
import {
  compactTree,
  isActionable,
  parseTree,
  type CompactElement,
} from "./pageCompactor.js";
import type { BrowserTransport, ToolRequestResult } from "./transport.js";

export const AI_TOOL_NAMES = {
  AI_ACTION: "ai_action",
  AI_ASSERT: "ai_assert",
  AI_NAVIGATE: "ai_navigate",
} as const;

export const AI_TOOL_SCHEMAS: Tool[] = [
  {
    name: AI_TOOL_NAMES.AI_ACTION,
    description:
      "Given a page's current state, use direct Jev to select one deterministic ChromeUse-owned atomic candidate. " +
      "Returns the selected action or a structured stop reason; provider output cannot invent refs or values. " +
      "Requires CHROMEUSE_JEV_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID" },
        goal: { type: "string", description: "What you want to accomplish" },
        context: { type: "string", description: "Optional explicit structured context" },
        pageContent: {
          type: "string",
          description: "Optional pre-fetched accessibility tree or page text",
        },
      },
      required: ["tabId", "goal"],
    },
  },
  {
    name: AI_TOOL_NAMES.AI_ASSERT,
    description:
      "Evaluate a natural-language page condition with one direct-Jev Noul decision. " +
      "Returns a deterministic threshold result without generated prose. Requires CHROMEUSE_JEV_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID" },
        condition: { type: "string", description: "Condition to evaluate" },
        pageContent: { type: "string", description: "Optional pre-fetched visible page text" },
      },
      required: ["tabId", "condition"],
    },
  },
  {
    name: AI_TOOL_NAMES.AI_NAVIGATE,
    description:
      "Drive the browser toward a goal with direct Jev selecting one ChromeUse-owned atomic action per step. " +
      "Stops on uncertainty, missing explicit values, visual-only tasks, risk, cancellation, or provider errors. " +
      "Requires CHROMEUSE_JEV_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab ID" },
        goal: { type: "string", description: "What to accomplish" },
        maxSteps: {
          type: "number",
          description: "Maximum decision steps before stopping (default 10, maximum 25)",
        },
        startUrl: {
          type: "string",
          description: "Optional explicit URL to navigate to before the first decision",
        },
      },
      required: ["tabId", "goal"],
    },
  },
];

export interface DecisionThresholds {
  action: number;
  assertion: number;
  sufficiency: number;
  maxRisk: number;
}

interface AiToolContext {
  provider: DecisionProvider;
  browser: BrowserTransport;
  clientId: string;
  thresholds: DecisionThresholds;
  signal?: AbortSignal;
}

type McpTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const DEFAULT_MAX_STEPS = 10;
const HARD_MAX_STEPS = 25;
const SETTLE_MS = 400;
const NAVIGATION_SETTLE_MS = 1200;
const MAX_ELEMENTS = 150;

export async function handleAiTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<McpTextResult> {
  switch (toolName) {
    case AI_TOOL_NAMES.AI_ACTION:
      return handleAiAction(args, ctx);
    case AI_TOOL_NAMES.AI_ASSERT:
      return handleAiAssert(args, ctx);
    case AI_TOOL_NAMES.AI_NAVIGATE:
      return handleAiNavigate(args, ctx);
    default:
      return textResult(`Unknown AI tool: ${toolName}`, true);
  }
}

async function handleAiAction(
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<McpTextResult> {
  const tabId = numberArg(args.tabId);
  const goal = stringArg(args.goal);
  if (tabId === undefined || !goal) {
    return textResult("Missing required arguments: tabId, goal", true);
  }

  try {
    ctx.signal?.throwIfAborted();
    const page = await readActionPage(tabId, args.pageContent, ctx);
    const compact = compactTree(page, MAX_ELEMENTS);
    const decision = await decideNextAction({
      goal,
      context: stringArg(args.context),
      page: compact.text || page,
      elements: compact.elements,
      history: [],
      ctx,
    });
    return jsonResult(decision.output);
  } catch (error) {
    return jsonResult(
      stopOutput(stopReasonForError(error, ctx.signal), error),
      !isCancellation(error, ctx.signal)
    );
  }
}

async function handleAiAssert(
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<McpTextResult> {
  const tabId = numberArg(args.tabId);
  const condition = stringArg(args.condition);
  if (tabId === undefined || !condition) {
    return textResult("Missing required arguments: tabId, condition", true);
  }

  try {
    ctx.signal?.throwIfAborted();
    const page = typeof args.pageContent === "string"
      ? args.pageContent
      : extractText(await send(ctx, "get_page_text", { tabId }));
    const result = await ctx.provider.decide(
      {
        state: { condition: truncate(condition, 2000), page: truncate(page, 8000) },
        questions: {
          assertion: {
            type: "noul",
            instructions: "Does the supplied condition hold on the current page?",
          },
        },
      },
      ctx.signal
    );
    ctx.signal?.throwIfAborted();
    const answer = requireNoul(result, "assertion");
    const pass = answer.noul >= ctx.thresholds.assertion;
    return jsonResult({
      pass,
      probability: answer.noul,
      threshold: ctx.thresholds.assertion,
      reason:
        `probability ${answer.noul.toFixed(2)} ${pass ? "met" : "did not meet"} ` +
        `threshold ${ctx.thresholds.assertion.toFixed(2)}`,
      _meta: result.metadata,
    });
  } catch (error) {
    return jsonResult({
      pass: false,
      error: stopReasonForError(error, ctx.signal),
      message: safeErrorMessage(error),
    }, true);
  }
}

interface NextActionInput {
  goal: string;
  context?: string;
  page: string;
  elements: CompactElement[];
  history: BrowserAction[];
  ctx: AiToolContext;
}

interface NextActionDecision {
  candidate?: ActionCandidate;
  candidateSet: CandidateSet;
  result: DecisionResult;
  output: Record<string, unknown>;
  selectedProbability?: number;
  confidence?: number;
  goalComplete?: number;
  candidatesSufficient?: number;
  risk?: number;
}

async function decideNextAction(input: NextActionInput): Promise<NextActionDecision> {
  const candidateSet = buildActionCandidates({
    elements: input.elements,
    goal: input.goal,
    context: input.context,
    history: input.history,
  });
  if (isUnsupportedVisualGoal(input.goal)) {
    const result = emptyDecisionResult();
    return {
      candidateSet,
      result,
      output: { action: "stop", reason: "unsupported_visual_task", _meta: result.metadata },
    };
  }

  const request: DecisionRequest = {
    state: {
      goal: truncate(input.goal, 2000),
      page: truncate(input.page, 8000),
      history: input.history,
      candidates: candidateSet.criteria,
    },
    questions: {
      next_action: {
        type: "choice",
        instructions: "Select the single best next action using only the supplied opaque candidate IDs.",
        criteria: candidateSet.criteria,
      },
      goal_complete: {
        type: "noul",
        instructions: "Is the user's goal already satisfied by the current page?",
      },
      candidates_sufficient: {
        type: "noul",
        instructions: "Does the candidate set contain a safe action that makes progress or correctly completes the goal?",
      },
      action_risk: {
        type: "score",
        instructions: "Rate the operational risk of the most appropriate next action.",
        criteria: [
          "Read-only or harmless navigation",
          "Reversible interaction or text entry",
          "External, destructive, financial, or account-changing action",
        ],
      },
    },
  };

  input.ctx.signal?.throwIfAborted();
  const result = await input.ctx.provider.decide(request, input.ctx.signal);
  input.ctx.signal?.throwIfAborted();
  const choice = requireChoice(result, "next_action");
  const goalComplete = requireNoul(result, "goal_complete").noul;
  const candidatesSufficient = requireNoul(result, "candidates_sufficient").noul;
  const risk = requireScore(result, "action_risk").score;
  const candidate = candidateSet.candidates.find(({ id }) => id === choice.choice);
  const selectedProbability = choice.probabilities?.[choice.choice];

  const stop = (reason: DecisionStopReason) => stopped(
    reason,
    candidateSet,
    result,
    choice,
    goalComplete,
    candidatesSufficient,
    risk
  );
  if (!candidate) return stop("invalid_provider_response");
  if (choice.probabilities && selectedProbability === undefined) {
    return stop("invalid_provider_response");
  }
  if (
    selectedProbability !== undefined &&
    Object.entries(choice.probabilities ?? {}).some(
      ([id, probability]) => id !== choice.choice && probability >= selectedProbability
    )
  ) {
    return stop("decision_conflict");
  }
  if (choice.confidence === undefined || choice.confidence < input.ctx.thresholds.action) {
    return stop("low_confidence");
  }
  if (candidate.action.type === "done" && goalComplete < input.ctx.thresholds.assertion) {
    return stop("decision_conflict");
  }
  if (candidate.action.type !== "done" && goalComplete >= input.ctx.thresholds.assertion) {
    return stop("decision_conflict");
  }
  if (candidate.action.type === "stop") {
    if (candidatesSufficient >= input.ctx.thresholds.sufficiency) {
      return stop("decision_conflict");
    }
    return stop(
      candidateSet.omitted.some(({ reason }) => reason === "explicit_value_required")
        ? "explicit_value_required"
        : "no_safe_candidates"
    );
  }
  if (
    candidate.action.type === "done" &&
    candidatesSufficient < input.ctx.thresholds.sufficiency
  ) {
    return stop("decision_conflict");
  }
  if (candidatesSufficient < input.ctx.thresholds.sufficiency) {
    return stop("candidates_insufficient");
  }
  if (risk > input.ctx.thresholds.maxRisk) return stop("risk_exceeded");

  return {
    candidate,
    candidateSet,
    result,
    selectedProbability,
    confidence: choice.confidence,
    goalComplete,
    candidatesSufficient,
    risk,
    output: {
      action: candidate.action.type,
      ...actionParameters(candidate.action),
      candidateId: candidate.id,
      selectedProbability,
      confidence: choice.confidence,
      alternatives: topAlternatives(choice),
      goalComplete,
      candidatesSufficient,
      risk,
      _meta: result.metadata,
    },
  };
}

function stopped(
  reason: DecisionStopReason,
  candidateSet: CandidateSet,
  result: DecisionResult,
  choice: ChoiceAnswer,
  goalComplete: number,
  candidatesSufficient: number,
  risk: number
): NextActionDecision {
  return {
    candidateSet,
    result,
    selectedProbability: choice.probabilities?.[choice.choice],
    confidence: choice.confidence,
    goalComplete,
    candidatesSufficient,
    risk,
    output: {
      action: "stop",
      reason,
      selectedCandidateId: choice.choice,
      selectedProbability: choice.probabilities?.[choice.choice],
      confidence: choice.confidence,
      alternatives: topAlternatives(choice),
      goalComplete,
      candidatesSufficient,
      risk,
      _meta: result.metadata,
    },
  };
}

interface NavigationStep {
  step: number;
  candidateId?: string;
  action?: BrowserAction;
  success: boolean;
  stopReason?: DecisionStopReason;
  error?: string;
  selectedProbability?: number;
  confidence?: number;
  goalComplete?: number;
  candidatesSufficient?: number;
  risk?: number;
  alternatives?: Array<{ id: string; probability: number }>;
  metadata?: DecisionResult["metadata"];
  pageElements: number;
  pageRefsDropped: number;
}

async function handleAiNavigate(
  args: Record<string, unknown>,
  ctx: AiToolContext
): Promise<McpTextResult> {
  const tabId = numberArg(args.tabId);
  const goal = stringArg(args.goal);
  if (tabId === undefined || !goal) {
    return textResult("Missing required arguments: tabId, goal", true);
  }
  const maxSteps = normalizeMaxSteps(args.maxSteps);
  const startUrl = stringArg(args.startUrl);
  const steps: NavigationStep[] = [];
  const history: BrowserAction[] = [];
  let inferences = 0;
  let actionsExecuted = 0;
  let stopReason: DecisionStopReason = "step_limit";
  let startUrlAction:
    | { action: BrowserAction; success: boolean; error?: string }
    | undefined;
  let startUrlInProgress = false;

  try {
    if (startUrl) {
      ctx.signal?.throwIfAborted();
      startUrlInProgress = true;
      await send(ctx, "navigate", { tabId, url: startUrl, action: "goto" });
      startUrlAction = {
        action: { type: "navigate", url: startUrl },
        success: true,
      };
      actionsExecuted++;
      await abortableSleep(NAVIGATION_SETTLE_MS, ctx.signal);
      startUrlInProgress = false;
    }

    for (let index = 0; index < maxSteps; index++) {
      ctx.signal?.throwIfAborted();
      let compact;
      let sourceElements: CompactElement[] = [];
      try {
        const page = extractText(await send(ctx, "read_page", {
          tabId,
          format: "accessibility",
        }));
        compact = compactTree(page, MAX_ELEMENTS);
        sourceElements = actionableElements(page);
      } catch (error) {
        if (isCancellation(error, ctx.signal)) throw error;
        stopReason = "browser_action_failed";
        steps.push({
          step: index + 1,
          success: false,
          stopReason,
          error: safeErrorMessage(error),
          pageElements: 0,
          pageRefsDropped: 0,
        });
        break;
      }

      let decision: NextActionDecision;
      try {
        decision = await decideNextAction({
          goal,
          page: compact.text,
          elements: compact.elements,
          history,
          ctx,
        });
        if (decision.result.metadata.resolvedModel !== "not-called") inferences++;
      } catch (error) {
        if (isCancellation(error, ctx.signal)) throw error;
        stopReason = stopReasonForError(error, ctx.signal);
        steps.push({
          step: index + 1,
          success: false,
          stopReason,
          error: safeErrorMessage(error),
          pageElements: compact.elements.length,
          pageRefsDropped: compact.droppedRefs,
        });
        break;
      }

      const common = {
        step: index + 1,
        selectedProbability: decision.selectedProbability,
        confidence: decision.confidence,
        goalComplete: decision.goalComplete,
        candidatesSufficient: decision.candidatesSufficient,
        risk: decision.risk,
        alternatives: extractAlternatives(decision.output),
        metadata: decision.result.metadata,
        pageElements: compact.elements.length,
        pageRefsDropped: compact.droppedRefs,
      };
      if (!decision.candidate) {
        stopReason = decision.output.reason as DecisionStopReason;
        steps.push({ ...common, success: false, stopReason });
        break;
      }
      if (decision.candidate.action.type === "done") {
        stopReason = "completed";
        steps.push({
          ...common,
          candidateId: decision.candidate.id,
          success: true,
          stopReason,
        });
        break;
      }

      ctx.signal?.throwIfAborted();
      let currentElements = compact.elements;
      if (candidateNeedsRefValidation(decision.candidate)) {
        try {
          const currentPage = extractText(await send(ctx, "read_page", {
            tabId,
            format: "accessibility",
          }));
          currentElements = actionableElements(currentPage);
          ctx.signal?.throwIfAborted();
        } catch (error) {
          if (isCancellation(error, ctx.signal)) throw error;
          stopReason = "browser_action_failed";
          steps.push({
            ...common,
            candidateId: decision.candidate.id,
            action: decision.candidate.action,
            success: false,
            stopReason,
            error: `Could not revalidate candidate: ${safeErrorMessage(error)}`,
          });
          break;
        }
      }
      if (!candidateStillValid(decision.candidate, sourceElements, currentElements)) {
        stopReason = "browser_action_failed";
        steps.push({
          ...common,
          candidateId: decision.candidate.id,
          action: decision.candidate.action,
          success: false,
          stopReason,
          error: "Candidate became stale before dispatch",
        });
        break;
      }

      ctx.signal?.throwIfAborted();
      actionsExecuted++;
      let outcome: { success: boolean; error?: string };
      try {
        outcome = await executeCandidate(decision.candidate, tabId, ctx);
      } catch (error) {
        if (isCancellation(error, ctx.signal)) {
          steps.push({
            ...common,
            candidateId: decision.candidate.id,
            action: decision.candidate.action,
            success: false,
            stopReason: "cancelled",
            error: "Action outcome unknown after cancellation",
          });
        }
        throw error;
      }
      steps.push({
        ...common,
        candidateId: decision.candidate.id,
        action: decision.candidate.action,
        success: outcome.success,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      if (!outcome.success) {
        stopReason = "browser_action_failed";
        steps.at(-1)!.stopReason = stopReason;
        break;
      }
      history.push(decision.candidate.action);
      await abortableSleep(
        decision.candidate.action.type === "click" ||
          decision.candidate.action.type === "navigate" ||
          decision.candidate.action.type === "key"
          ? NAVIGATION_SETTLE_MS
          : SETTLE_MS,
        ctx.signal
      );
    }
  } catch (error) {
    if (isCancellation(error, ctx.signal)) {
      stopReason = "cancelled";
    } else if (startUrlInProgress && startUrl) {
      stopReason = "browser_action_failed";
      startUrlAction = {
        action: { type: "navigate", url: startUrl },
        success: false,
        error: safeErrorMessage(error),
      };
    } else {
      throw error;
    }
  }

  const finalPagePreview = stopReason === "cancelled"
    ? ""
    : await readFinalPreview(tabId, ctx);
  return jsonResult({
    success: stopReason === "completed",
    stopReason,
    goal,
    stepsUsed: steps.length,
    maxSteps,
    inferences,
    actionsExecuted,
    ...(startUrlAction ? { startUrlAction } : {}),
    steps,
    finalPagePreview,
  });
}

async function executeCandidate(
  candidate: ActionCandidate,
  tabId: number,
  ctx: AiToolContext
): Promise<{ success: boolean; error?: string }> {
  try {
    switch (candidate.action.type) {
      case "click":
        await send(ctx, "computer", { tabId, action: "click", ref: candidate.action.ref });
        break;
      case "type":
        await send(ctx, "form_input", {
          tabId,
          ref: candidate.action.ref,
          value: candidate.action.value,
        });
        break;
      case "key":
        await send(ctx, "computer", { tabId, action: "key", key: candidate.action.key });
        break;
      case "scroll":
        await send(ctx, "computer", {
          tabId,
          action: "scroll",
          direction: candidate.action.direction,
        });
        break;
      case "navigate":
        await send(ctx, "navigate", { tabId, action: "goto", url: candidate.action.url });
        break;
      case "wait":
        await abortableSleep(NAVIGATION_SETTLE_MS, ctx.signal);
        break;
      case "done":
      case "stop":
        return { success: false, error: `${candidate.action.type} is not executable` };
    }
    return { success: true };
  } catch (error) {
    if (isCancellation(error, ctx.signal)) throw error;
    return { success: false, error: safeErrorMessage(error) };
  }
}

function candidateNeedsRefValidation(candidate: ActionCandidate): boolean {
  return candidate.action.type === "click" || candidate.action.type === "type";
}

function candidateStillValid(
  candidate: ActionCandidate,
  originalElements: CompactElement[],
  currentElements: CompactElement[]
): boolean {
  const action = candidate.action;
  if (action.type !== "click" && action.type !== "type") return true;
  const original = originalElements.find(({ ref }) => ref === action.ref);
  const current = currentElements.find(({ ref }) => ref === action.ref);
  if (!original || !current) return false;
  const sameIdentity = ({ role, name }: CompactElement) =>
    role === original.role && name === original.name;
  return Boolean(
    original.role === current.role &&
    original.name === current.name &&
    originalElements.filter(({ ref }) => ref === action.ref).length === 1 &&
    currentElements.filter(({ ref }) => ref === action.ref).length === 1 &&
    originalElements.filter(sameIdentity).length === 1 &&
    currentElements.filter(sameIdentity).length === 1 &&
    !/\b(disabled|hidden|stale)\b/i.test(current.state ?? "")
  );
}

function actionableElements(page: string): CompactElement[] {
  return parseTree(page).all.filter(isActionable);
}

async function readActionPage(
  tabId: number,
  supplied: unknown,
  ctx: AiToolContext
): Promise<string> {
  if (typeof supplied === "string") return supplied;
  try {
    return extractText(await send(ctx, "read_page", { tabId, format: "accessibility" }));
  } catch (error) {
    if (isCancellation(error, ctx.signal)) throw error;
    return extractText(await send(ctx, "get_page_text", { tabId }));
  }
}

async function readFinalPreview(tabId: number, ctx: AiToolContext): Promise<string> {
  try {
    return truncate(extractText(await send(ctx, "get_page_text", {
      tabId,
      maxLength: 1200,
    })), 600);
  } catch {
    return "";
  }
}

async function send(
  ctx: AiToolContext,
  tool: string,
  args: Record<string, unknown>
): Promise<ToolRequestResult> {
  const result = await ctx.browser.sendToolRequest(
    tool,
    args,
    undefined,
    { clientId: ctx.clientId }
  );
  if (result.isError) {
    throw new Error(extractText(result) || `${tool} failed`);
  }
  return result;
}

function topAlternatives(answer: ChoiceAnswer): Array<{ id: string; probability: number }> {
  return Object.entries(answer.probabilities ?? {})
    .filter(([id]) => id !== answer.choice)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([id, probability]) => ({ id, probability }));
}

function extractAlternatives(output: Record<string, unknown>) {
  return Array.isArray(output.alternatives)
    ? output.alternatives as Array<{ id: string; probability: number }>
    : undefined;
}

function requireChoice(result: DecisionResult, name: string): ChoiceAnswer {
  const answer = result.answers[name];
  if (answer?.type !== "choice") throw new InvalidJevResponseError(`${name} must be choice`);
  return answer;
}

function requireNoul(result: DecisionResult, name: string): NoulAnswer {
  const answer = result.answers[name];
  if (answer?.type !== "noul") throw new InvalidJevResponseError(`${name} must be Noul`);
  return answer;
}

function requireScore(result: DecisionResult, name: string): ScoreAnswer {
  const answer = result.answers[name];
  if (answer?.type !== "score") throw new InvalidJevResponseError(`${name} must be Score`);
  return answer;
}

function stopReasonForError(error: unknown, signal?: AbortSignal): DecisionStopReason {
  if (isCancellation(error, signal)) return "cancelled";
  if (error instanceof InvalidJevResponseError) return "invalid_provider_response";
  if (error instanceof JevProviderError) return "provider_error";
  return "provider_error";
}

function stopOutput(reason: DecisionStopReason, error: unknown) {
  return { action: "stop", reason, message: safeErrorMessage(error) };
}

function isUnsupportedVisualGoal(goal: string): boolean {
  return /\b(screenshot|image|picture|photo|pixel|canvas|color|colou?r|icon shown|looks like|leftmost|rightmost|topmost|bottommost|on the left|on the right|left side|right side|at the top|at the bottom|top of|bottom of|upper|lower|above|below|beside|next to|nearest|farthest|visually)\b/i.test(goal);
}

function emptyDecisionResult(): DecisionResult {
  return {
    answers: {},
    metadata: {
      provider: "direct-jev",
      requestedModel: "typesafe/jev-1.13",
      resolvedModel: "not-called",
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  };
}

function actionParameters(action: BrowserAction): Record<string, unknown> {
  return Object.fromEntries(Object.entries(action).filter(([key]) => key !== "type"));
}

function normalizeMaxSteps(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_STEPS;
  }
  return Math.min(Math.floor(value), HARD_MAX_STEPS);
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractText(result: ToolRequestResult): string {
  for (const block of result.content) {
    if ((block as { type?: string }).type === "text") {
      return (block as { type: "text"; text: string }).text;
    }
  }
  return "";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(truncated at ${maxChars} chars)`;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    }, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`))
  );
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || isAbortError(error);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textResult(text: string, isError = false): McpTextResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function jsonResult(value: unknown, isError = false): McpTextResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}
