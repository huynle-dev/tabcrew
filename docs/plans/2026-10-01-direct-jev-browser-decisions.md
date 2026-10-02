# Direct Jev Browser Decisions

**Status:** Approved design, ready for implementation
**Date:** 2026-10-01
**Scope:** Replace the current Jev Router/chat-completion browser agent with direct Jev structured decisions.

## Summary

ChromeUse currently sends page state and natural-language instructions to `typesafe/jev-router`, receives model-generated JSON from a downstream generative model, parses that JSON, and executes the proposed browser actions.

This plan replaces that architecture with direct Jev (`typesafe/jev-1.13`) through OpenRouter's System One API. ChromeUse will construct a finite set of valid, atomic browser actions. Jev will select one candidate and return typed probabilities and confidence. ChromeUse will own all control flow, validation, safety gates, and execution.

There will be no generative fallback. If ChromeUse cannot construct a safe candidate, or Jev is insufficiently confident, the tool will stop and explain why.

## Product Decisions

- Keep the public MCP tools `ai_action`, `ai_assert`, and `ai_navigate`.
- Use direct Jev only. Do not invoke Jev Router or another generative model.
- Preserve current tool inputs where possible.
- Permit `type` and `navigate` only with values extracted verbatim from explicit goal text, supplied context, or the current page.
- Use configurable confidence gates and calibrate them against recorded browser evaluations.
- Execute one atomic action per Jev decision cycle.
- Preserve the recent extension reliability fixes; they are independent of the model-provider rewrite.
- Remove the unreleased chat-completion configuration instead of carrying compatibility aliases.

## Goals

- Eliminate downstream generative models from ChromeUse's AI browser tools.
- Eliminate prompt-enforced JSON, Markdown-fence stripping, unsafe casts, and generated executable parameters.
- Make every executable action originate from validated ChromeUse code.
- Expose Jev probabilities, confidence, usage, cost, latency, requested model, and resolved model.
- Stop safely on uncertainty, unsupported visual tasks, missing explicit values, cancellation, or provider failure.
- Preserve current browser orchestration behavior where it remains provider-independent.

## Non-Goals

- General screenshot or image understanding.
- Free-form query, URL, text, summary, or explanation generation.
- Automatic fallback to Jev Router, DeepSeek, Claude, Gemini, or any other model.
- Backward-compatible support for the unreleased `CHROMEUSE_AI_*` configuration.
- A new browser safety or permission framework beyond candidate validation and confidence gates.
- Changing extension protocols unless direct-Jev integration reveals a concrete need.

## Architecture

```text
User goal
   |
   v
Read main-frame accessibility tree
   |
   v
Compact to <= 150 useful elements
   |
   v
Extract explicit values and build <= 255 atomic candidates
   |
   v
POST /api/v1/systemone using typesafe/jev-1.13
   |
   +-- Choice: next_action
   +-- Noul: goal_complete
   +-- Noul: candidates_sufficient
   +-- Score: action_risk
   |
   v
Validate response and apply confidence/risk gates
   |
   +-- accepted -> execute exactly one candidate -> reread page
   +-- rejected -> stop with structured reason
```

## Direct Jev Wire Contract

ChromeUse will call OpenRouter directly with `fetch`; no new SDK dependency is required.

```http
POST https://openrouter.ai/api/v1/systemone
Authorization: Bearer <key>
Content-Type: application/json
```

Illustrative request:

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "goal": "Open the latest technology news article",
    "page": "[ref_14] link Latest\n[ref_27] link Example article",
    "history": [],
    "candidates": {
      "a000": "Click the link named Latest at ref_14",
      "a001": "Click the link named Example article at ref_27",
      "a002": "Scroll down",
      "a003": "The goal is complete",
      "a004": "Stop because no safe action is available"
    }
  },
  "questions": {
    "next_action": {
      "type": "choice",
      "instructions": "Select the single best next action for the goal using only the supplied candidates.",
      "criteria": {
        "a000": "Click the link named Latest at ref_14",
        "a001": "Click the link named Example article at ref_27",
        "a002": "Scroll down",
        "a003": "The goal is complete",
        "a004": "Stop because no safe action is available"
      }
    },
    "goal_complete": {
      "type": "noul",
      "instructions": "Is the user's goal already satisfied by the current page?"
    },
    "candidates_sufficient": {
      "type": "noul",
      "instructions": "Does the candidate set contain a safe action that makes progress or correctly completes the goal?"
    },
    "action_risk": {
      "type": "score",
      "instructions": "Rate the operational risk of the most appropriate next action.",
      "criteria": [
        "Read-only or harmless navigation",
        "Reversible page interaction or text entry",
        "Potentially external, destructive, financial, or account-changing action"
      ]
    }
  }
}
```

The adapter must validate the HTTP response rather than trusting wire data. Expected answers are:

- `next_action`: `type`, `choice`, optional `probabilities`, optional `confidence`.
- `goal_complete`: `type`, numeric `noul` probability.
- `candidates_sufficient`: `type`, numeric `noul` probability.
- `action_risk`: `type`, numeric `score`, optional `probabilities`, optional `confidence`.
- Top level: `model`, `answers`, `usage`, optional `id`, `provider`, and `usage.cost`.

The requested model may resolve to a dated direct-Jev revision. This is model resolution, not routing to a generative model.

## Components

### Decision Types

Add provider-independent domain types for:

- `ActionCandidate`
- `DecisionRequest`
- `DecisionResult`
- `ChoiceAnswer`
- `NoulAnswer`
- `ScoreAnswer`
- `DecisionMetadata`
- `DecisionStopReason`

Executable actions remain a discriminated union. Candidate IDs are opaque (`a000`, `a001`, and so on); a map owned by ChromeUse resolves an ID to validated action parameters.

### Direct Jev Provider

Replace the completion-oriented provider with:

```ts
interface DecisionProvider {
  decide(
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<DecisionResult>;
}
```

`DirectJevProvider` owns:

- Authentication and configuration.
- System One request serialization.
- Abort propagation.
- HTTP and OpenRouter error mapping.
- Runtime response validation.
- Latency and usage metadata.

It does not know about browser refs or execute actions.

### Candidate Builder

The candidate builder consumes compact accessibility elements, the goal, optional context, and recent action history. It returns:

```ts
interface CandidateSet {
  candidates: ActionCandidate[];
  criteria: Record<string, string>;
  explicitValues: ExplicitValue[];
  omitted: CandidateOmission[];
}
```

Candidate construction rules:

- Links and buttons produce `click` candidates.
- Textboxes and searchboxes produce `type` candidates only when explicit values exist.
- Explicit URLs produce `navigate` candidates.
- `Enter` is offered after an accepted text-entry action or when page semantics indicate submission.
- `scroll:up`, `scroll:down`, `wait`, `done`, and `stop` are bounded global candidates.
- Hidden, disabled, stale, malformed, or missing refs never produce executable candidates.
- Candidate count must never exceed Jev's 255-choice limit.
- Candidate ordering must be deterministic.
- Every candidate description must include enough page and action context for Jev to distinguish it.

Explicit-value extraction is deliberately conservative:

- Quoted strings in the goal.
- Structured strings supplied through `context`.
- URLs, email addresses, numbers, and exact page text already present.
- No model-generated paraphrases or inferred search terms.

If a textbox is the apparent next target but no explicit value exists, the builder records `explicit_value_required` and does not invent a value.

### Decision Gates

Initial configuration:

```text
CHROMEUSE_JEV_API_KEY
CHROMEUSE_JEV_BASE_URL=https://openrouter.ai/api/v1
CHROMEUSE_JEV_MODEL=typesafe/jev-1.13
CHROMEUSE_JEV_ACTION_THRESHOLD=0.80
CHROMEUSE_JEV_ASSERT_THRESHOLD=0.80
CHROMEUSE_JEV_SUFFICIENCY_THRESHOLD=0.80
CHROMEUSE_JEV_MAX_AUTO_RISK=1.0
```

These defaults are provisional until calibration. Parsing must reject missing, nonnumeric, nonfinite, or out-of-range configuration.

Execution requires all applicable conditions:

- The selected candidate ID exists in the current candidate map.
- Choice confidence meets the action threshold.
- The selected probability is present and consistent with the selected choice when probabilities are returned.
- Candidate sufficiency meets its threshold.
- Risk score does not exceed the configured maximum.
- MCP cancellation has not fired.
- The candidate still passes action-specific validation immediately before dispatch.

`done` additionally requires the goal-complete Noul probability to meet the assertion threshold. A disagreement between `next_action`, goal completion, and candidate sufficiency stops with `decision_conflict`; ChromeUse does not guess which answer to trust.

Because Noul returns a probability but no confidence field, assertions gate directly on Noul probability.

## Tool Behavior

### `ai_action`

- Read and compact the page unless `pageContent` is supplied.
- Build candidates.
- Request one direct-Jev decision.
- Return the selected validated candidate without executing it.
- Return `action: "stop"` plus a stop reason when gates fail.
- Include selected probability, choice confidence, bounded top alternatives, Noul values, risk, latency, model, usage, and cost.

### `ai_assert`

- Read visible page text unless `pageContent` is supplied.
- Ask one Noul question matching the supplied condition.
- Return `pass: noul >= configured threshold`.
- Include the raw Noul probability, threshold, direct model metadata, latency, usage, and cost.
- Do not generate a free-form reason. Return a deterministic explanation such as `probability 0.91 met threshold 0.80`.

### `ai_navigate`

- Preserve `tabId`, `goal`, `startUrl`, and bounded `maxSteps` inputs.
- Execute one accepted atomic candidate per decision step.
- Reread and rebuild candidates after every action.
- Preserve browser action outcomes, history, cancellation, step counts, and final snapshot.
- Replace inference/action-plan logs with structured direct-Jev decision logs.
- Stop immediately when a gate fails; never invoke another model.

Terminal outcomes:

- `completed`
- `low_confidence`
- `no_safe_candidates`
- `explicit_value_required`
- `unsupported_visual_task`
- `goal_not_verifiable`
- `candidates_insufficient`
- `decision_conflict`
- `risk_exceeded`
- `step_limit`
- `cancelled`
- `provider_error`
- `invalid_provider_response`
- `browser_action_failed`

## Stable Output Metadata

Provider-specific wire details must map into stable metadata:

```json
{
  "provider": "direct-jev",
  "requestedModel": "typesafe/jev-1.13",
  "resolvedModel": "typesafe/jev-1.13-20260917",
  "requestId": "...",
  "latencyMs": 140,
  "usage": {
    "inputTokens": 430,
    "outputTokens": 12,
    "cost": 0.00001
  }
}
```

`ai_navigate` should return the selected probability, confidence, and a bounded list of top alternatives per step. Avoid returning all 255 probabilities by default because that can make MCP responses larger than the page state they summarize.

## Migration Boundaries

### Preserve

- `mcp-server/src/pageCompactor.ts` and its tests.
- Browser-state acquisition and main-frame reads.
- Browser action execution and action-specific validation.
- Navigation loop limits, history, settle behavior, and final snapshot.
- MCP request cancellation checks.
- Extension focus, CDP keyboard, tab activation, and main-frame reliability fixes.

### Replace

- `mcp-server/src/aiProvider.ts` completion semantics.
- `/chat/completions` requests.
- `typesafe/jev-router` defaults.
- Message arrays, max tokens, temperature, and JSON mode.
- JSON-only system prompts and generated plan prompts.
- Markdown-fence stripping and handler-level `JSON.parse`.
- Model-generated action parameters.
- Batched speculative plans.
- Router/downstream-model metadata.
- `CHROMEUSE_AI_*` configuration.

### Proposed Files

```text
mcp-server/src/decisionTypes.ts
mcp-server/src/directJevProvider.ts
mcp-server/src/actionCandidates.ts
mcp-server/src/aiTools.ts
mcp-server/src/server.ts
mcp-server/src/library.ts

mcp-server/src/decisionTypes.test.ts
mcp-server/src/directJevProvider.test.ts
mcp-server/src/actionCandidates.test.ts
mcp-server/src/aiAction.test.ts
mcp-server/src/aiAssert.test.ts
mcp-server/src/aiNavigate.test.ts
mcp-server/src/server.test.ts
```

Delete `aiProvider.ts` and `aiProvider.test.ts` after their direct-Jev replacements are green. Do not retain the old class as an alias.

## Implementation Plan

### Phase 1: Pin Domain And Wire Contracts

1. Add tests for all decision answer variants and malformed responses.
2. Define provider-independent domain types and runtime validators.
3. Add direct System One request serialization fixtures based on the official API schema.
4. Verify exact model slug behavior using `typesafe/jev-1.13`; do not assume `jev-1.13.0` is an alias.
5. Record representative 400, 401, 402, 429, 500, 503, 524, and 529 error mappings.

Acceptance criteria:

- Wire data cannot enter browser orchestration without validation.
- Choice, Noul, Score, usage, cost, model resolution, errors, and cancellation are covered.

### Phase 2: Implement Direct Jev Provider

1. Write failing provider request/response tests.
2. Implement `loadJevConfig()` with strict parsing.
3. Implement `DirectJevProvider.decide()` using `/systemone`.
4. Forward `AbortSignal` to `fetch` and preserve abort semantics.
5. Replace the cached global singleton with provider injection or a per-server factory.
6. Export the new provider and types from `library.ts`.

Acceptance criteria:

- No `/chat/completions` code remains.
- No router model is referenced.
- Server tests can inject a fake decision provider without mutating process-global state.

### Phase 3: Build Atomic Candidates

1. Write candidate tests for links, buttons, textboxes, searchboxes, explicit quoted text, context values, URLs, keys, scroll, wait, done, and stop.
2. Add deterministic explicit-value extraction.
3. Add opaque candidate IDs and descriptions.
4. Enforce the 255-choice maximum with deterministic omission reporting.
5. Add malformed, duplicate, disabled, hidden, and missing-ref tests.
6. Add candidate lookup validation to prevent stale or invented IDs.

Acceptance criteria:

- Jev can select only actions ChromeUse already knows how to execute.
- Candidate generation never invents text or URLs.
- Candidate output is deterministic for a given state.

### Phase 4: Rewrite `ai_assert`

1. Add focused handler tests; none currently exist.
2. Replace chat completion with a single Noul question.
3. Apply the configured assertion threshold.
4. Return deterministic reasoning and direct-Jev metadata.
5. Preserve page-content override, page reading, errors, and cancellation.

Acceptance criteria:

- No generated prose or JSON parsing is used.
- Pass/fail is reproducible from the returned Noul probability and threshold.

### Phase 5: Rewrite `ai_action`

1. Add focused handler tests for page reading, fallback, candidates, thresholds, risk, stop reasons, metadata, and cancellation.
2. Build candidates and submit one direct-Jev request.
3. Resolve only known candidate IDs.
4. Return one validated action without executing it.
5. Bound alternative-probability output.

Acceptance criteria:

- All returned executable parameters originated in ChromeUse.
- Low confidence, missing values, unsupported visual state, and invalid provider data stop safely.

### Phase 6: Rewrite `ai_navigate`

1. Convert existing generated-plan fixtures to structured Jev decisions.
2. Preserve tests for validation, compaction, `startUrl`, history, step limits, action outcomes, and cancellation.
3. Remove batched-plan parsing and retry-on-non-JSON behavior.
4. Execute one atomic candidate per step.
5. Add completion/sufficiency conflicts, risk, low confidence, explicit-value, unsupported-visual, and stale-candidate tests.
6. Make settle delays abortable.
7. Decide separately whether `BrowserTransport.sendToolRequest()` should accept an abort signal; do not expand that interface unless a failing test demonstrates an in-flight mutation problem.

Acceptance criteria:

- No action runs after cancellation or a failed decision gate.
- Each action is based on the page state read in the same step.
- No additional model is called under any stop condition.

### Phase 7: Server Registration And Configuration

1. Inject `DecisionProvider` into `createMcpServer()` while retaining a simple default factory for production startup.
2. Test that AI tools are absent without `CHROMEUSE_JEV_API_KEY`.
3. Test that all three tools appear with a configured provider.
4. Test local AI dispatch versus extension forwarding.
5. Test cancellation through an actual MCP in-memory transport.
6. Remove `CHROMEUSE_AI_API_KEY`, `CHROMEUSE_AI_BASE_URL`, `CHROMEUSE_AI_MODEL`, and `CHROMEUSE_AI_MAX_TOKENS` references.

Acceptance criteria:

- Registration is deterministic and testable without singleton resets.
- Configuration names and errors explicitly identify direct Jev.

### Phase 8: Documentation And Local Migration

1. Update `README.md` with direct-Jev setup and behavioral constraints.
2. Document all three tools in `docs/TOOLS.md`.
3. Document the local inference/control-flow boundary in `docs/ARCHITECTURE.md`.
4. Update `DISTRIBUTION.md` examples.
5. Update the active OpenCode configuration to `CHROMEUSE_JEV_*` variables without exposing credentials in source control.
6. Reassess the current 120-second MCP timeout after measured direct-Jev runs; do not reduce it until live multi-step evidence supports a lower value.
7. Remove documentation claiming Jev Router or downstream generative-model use.

Acceptance criteria:

- A new user can configure direct Jev without learning the old router architecture.
- Documentation clearly states that images and arbitrary text generation are unsupported.

### Phase 9: Evaluation And Threshold Calibration

Create a repeatable evaluation harness or fixture set covering:

- Hacker News search with explicit quoted text.
- Craigslist search with explicit quoted text.
- Engadget latest-article selection.
- Multi-field forms with explicit values.
- Duplicate controls with ambiguous labels.
- Missing explicit type values.
- Login, CAPTCHA, canvas, and inaccessible-page states.
- Already-completed goals.
- Impossible goals.
- Stale refs and navigation between decisions.
- Cancellation before inference, after inference, and before action dispatch.

Capture:

- Selected action correctness.
- Goal-completion correctness.
- Stop-reason correctness.
- Choice probability and confidence.
- Noul probabilities.
- Risk score.
- Per-step and end-to-end latency.
- Input/output tokens and cost.
- Steps and browser actions.
- Unsafe-action attempts.

Thresholds must be calibrated from these results. The provisional `0.80` values are not production evidence.

Acceptance criteria:

- No unsafe action is executed in the fixture set.
- Low-confidence and unsupported cases stop instead of guessing.
- Successful scenarios complete without any chat-completion request.
- Threshold recommendations are documented with measured false-positive and false-negative tradeoffs.

### Phase 10: Full Verification

Run fresh verification after all final edits:

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

Reload the unpacked extension and start a fresh OpenCode process so configuration and MCP code are not stale. Run the live evaluation scenarios and inspect network/log evidence that requests go only to `/api/v1/systemone` with `typesafe/jev-1.13`.

## Acceptance Criteria

- ChromeUse does not reference `typesafe/jev-router` at runtime or in setup documentation.
- ChromeUse makes no `/chat/completions` requests for AI browser tools.
- No direct-Jev result can introduce executable refs, text, URLs, keys, or directions that ChromeUse did not construct.
- `ai_action`, `ai_assert`, and `ai_navigate` retain their public names and compatible core inputs.
- `ai_navigate` performs one atomic action per direct-Jev decision.
- Low-confidence, high-risk, missing-value, visual-only, malformed, and cancelled cases stop safely.
- Outputs expose direct model resolution, probabilities, confidence where available, thresholds, latency, tokens, and cost.
- Full tests, typecheck, build, and diff checks pass.
- Live browser evidence confirms direct Jev only.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Choice always ranks one candidate even when none is useful | Ask `candidates_sufficient` independently and always include `stop`. |
| Goal-completion Noul disagrees with action Choice | Stop with `decision_conflict`; never guess. |
| Candidate count exceeds 255 | Deterministic budgeting and omission reporting. |
| Explicit-value extraction is too restrictive | Return `explicit_value_required`; expand only with evidence-backed deterministic parsers. |
| Confidence is overtrusted | Calibrate against ChromeUse fixtures; thresholds remain configurable. |
| Risk Score does not align with selected Choice | Keep action validation and deterministic restrictions authoritative; treat Jev risk as an additional gate, not the sole safety mechanism. |
| Direct Jev service or schema changes | Runtime validation, provider-specific adapter, fixture tests, and explicit error mapping. |
| Existing callers rely on generated `thought` or `reason` fields | Return deterministic decision summaries and document the intentional output change. |
| One action per inference increases request count | Measure real latency/cost; correctness and fresh page grounding take priority. |

## Rollback

Implementation should occur in reviewable phases. Before deleting the old provider, keep the branch or commit containing the current router implementation available for comparison. Rollback means reverting the direct-Jev feature commits as a unit; do not maintain both architectures in production code.

The extension reliability fixes are outside the rollback boundary and should remain unless independently shown to regress browser behavior.

## References

- [OpenRouter System One API](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md)
- [OpenRouter direct Jev documentation](https://openrouter.ai/docs/guides/community/jev)
- [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe Choice primitive](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe confidence guidance](https://docs.typesafe.ai/confidence)
- [TypeSafe use-case map](https://docs.typesafe.ai/concepts/use-case-map)
