/**
 * Execute one observed action (port of jev-ultrafast browser.py `fresh()` + `act`).
 *
 * Order: fingerprint must be the tab's latest snapshot → action must exist → freshness
 * (click/select: page key + that node's guard; others: the full marker) → re-resolve the node
 * and hit-test it → CDP input → settle wait → fresh snapshot. Nothing before input is a side
 * effect; once input dispatch has begun, any failure is `outcome_unknown`. Input is never
 * retried.
 */

import type { V2ActResult } from "@chromeuse/shared/v2";
import { OpError } from "./errors.js";
import { evaluate, type PageController, type RawAction } from "./snapshot/controller.js";
import { sameJson } from "./snapshot/fingerprint.js";
import { guardSource, MARKER_SOURCE, settleSource, targetSource } from "./snapshot/scripts.js";

export interface ActArgs {
  fingerprint?: unknown;
  action_id?: unknown;
  text?: unknown;
}

export const WAIT_MS = 100;
const MOD_CTRL = 2;
const MOD_META = 4;

type TargetResult = { x: number; y: number } | { error: "stale_page" | "target_invalid" | "target_covered"; message: string };

export async function runAct(page: PageController, tabId: number, args: ActArgs): Promise<V2ActResult> {
  if (typeof args.fingerprint !== "string" || !args.fingerprint) {
    throw new OpError("invalid_args", "fingerprint must be the string returned by the last snapshot");
  }
  if (typeof args.action_id !== "string" || !args.action_id) throw new OpError("invalid_args", "action_id must be a string");
  if (args.text !== undefined && typeof args.text !== "string") throw new OpError("invalid_args", "text must be a string");

  const state = page.latest(tabId);
  if (!state || state.fingerprint !== args.fingerprint) {
    throw new OpError("stale_page", "The page changed since this observation. Observe again.");
  }
  const action = state.raw.actions.find((a) => a.id === args.action_id);
  if (!action) throw new OpError("target_invalid", `Unknown action ${args.action_id}. Observe and choose again.`);
  if (action.kind === "fill" && typeof args.text !== "string") {
    throw new OpError("target_invalid", "TYPE_TEXT needs `text` to type into the field.");
  }
  const send = page.deps.send;
  const oldFingerprint = state.fingerprint;

  // 1. Freshness: read-only, nothing executed on failure.
  if (!(await isFresh(page, tabId, action))) {
    throw new OpError("stale_page", "The page changed since this observation. Observe again.");
  }

  // 2. Input. From the first side effect on, failures are outcome_unknown.
  let dispatched = false;
  try {
    if (action.kind === "wait") {
      await page.sleep(WAIT_MS);
    } else if (action.kind === "scroll") {
      const { w, h } = state.raw;
      dispatched = true;
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(w / 2),
        y: Math.round(h / 2),
        deltaX: 0,
        deltaY: action.delta ?? 0,
      });
    } else {
      // For select, the target evaluation also sets the value, so it counts as input dispatch.
      dispatched = action.kind === "select";
      const target = await resolveTarget(page, tabId, action);
      if ("error" in target) {
        // The script reports errors before mutating anything: nothing was executed.
        dispatched = false;
        throw new OpError(target.error, target.message);
      }
      if (action.kind !== "select") {
        dispatched = true;
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send(tabId, "Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
        }
        if (action.kind === "fill") {
          const modifiers = (await page.deps.isMac()) ? MOD_META : MOD_CTRL;
          await send(tabId, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            modifiers,
            commands: ["selectAll"],
          });
          await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
          await send(tabId, "Input.insertText", { text: args.text as string });
        }
      }
    }
  } catch (err) {
    if (!dispatched) {
      if (err instanceof OpError) throw err;
      throw new OpError("stale_page", `The page changed while checking the target (${oneLine(err)}). Observe again.`);
    }
    page.forget(tabId);
    throw new OpError("outcome_unknown", `Input was sent but its result is unknown (${oneLine(err)}). Observe before acting again.`);
  }

  // 3. Settle (read-only; navigation may interrupt it).
  if (action.kind !== "wait") {
    try {
      await evaluate(send, tabId, settleSource(action), true);
    } catch {
      // ignore: the page may be navigating
    }
  }

  // 4. Fresh snapshot; it becomes the tab's latest.
  try {
    const next = await page.capture(tabId);
    return { executed: action.id, page_changed: next.fingerprint !== oldFingerprint };
  } catch {
    page.forget(tabId);
    return { executed: action.id, page_changed: null };
  }
}

async function isFresh(page: PageController, tabId: number, action: RawAction): Promise<boolean> {
  const state = page.latest(tabId)!;
  try {
    if (action.kind === "click" || action.kind === "select") {
      const node = action.node;
      if (typeof node !== "number" || !Number.isInteger(node)) return false;
      const current = await evaluate(page.deps.send, tabId, guardSource(node));
      return current.ok && sameJson(current.value, [state.raw.page_key, state.raw.guards[String(node)] ?? null]);
    }
    const current = await evaluate(page.deps.send, tabId, MARKER_SOURCE);
    return current.ok && current.value !== null && sameJson(current.value, state.raw.marker);
  } catch (err) {
    if (err instanceof OpError) throw err;
    return false;
  }
}

async function resolveTarget(page: PageController, tabId: number, action: RawAction): Promise<TargetResult> {
  if (typeof action.node !== "number" || (action.kind !== "click" && action.kind !== "fill" && action.kind !== "select")) {
    return { error: "target_invalid", message: "This action has no observed element." };
  }
  const result = await evaluate(page.deps.send, tabId, targetSource({ node: action.node, kind: action.kind, value: action.value }));
  if (!result.ok) throw new Error(result.reason);
  const v = result.value as TargetResult | null;
  if (v && typeof v === "object" && "error" in v) return v;
  if (!v || typeof v.x !== "number" || typeof v.y !== "number") throw new Error("target check returned no position");
  return v;
}

function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 160);
}
