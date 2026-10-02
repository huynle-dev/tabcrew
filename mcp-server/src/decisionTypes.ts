export type BrowserAction =
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; value: string }
  | { type: "key"; key: "Enter" }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "navigate"; url: string }
  | { type: "wait" }
  | { type: "done" }
  | { type: "stop" };

export interface ActionCandidate {
  id: string;
  description: string;
  action: BrowserAction;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type DecisionQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface DecisionRequest {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, unknown>;
}

export type DecisionAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}

export interface DecisionMetadata {
  provider: "direct-jev";
  requestedModel: string;
  resolvedModel: string;
  requestId?: string;
  upstreamProvider?: string;
  latencyMs: number;
  usage: DecisionUsage;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  metadata: DecisionMetadata;
}

export type DecisionStopReason =
  | "completed"
  | "low_confidence"
  | "no_safe_candidates"
  | "explicit_value_required"
  | "unsupported_visual_task"
  | "goal_not_verifiable"
  | "candidates_insufficient"
  | "decision_conflict"
  | "risk_exceeded"
  | "step_limit"
  | "cancelled"
  | "provider_error"
  | "invalid_provider_response"
  | "browser_action_failed";

export interface DecisionProvider {
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult>;
}
