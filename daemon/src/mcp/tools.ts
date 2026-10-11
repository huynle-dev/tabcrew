import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExtensionBridge } from "../bridge.js";
import { DaemonError, toV2Error } from "../errors.js";
import { DEFAULT_MAX_STEPS, MAX_GOAL, MAX_MAX_STEPS, runBrowse, type JevRuntime } from "../jev/browse.js";
import { isCode, onTab } from "../lanes.js";
import { log } from "../log.js";
import {
  actionSpace,
  checkSnapshot,
  MAX_TYPE_TEXT,
  OPERATIONS,
  resolveAct,
  toObservation,
  type ObservationCache,
} from "../observe.js";
import type { Scheduler } from "../scheduler.js";
import { sessionRef, type Session, type SessionRegistry } from "../sessions.js";

export interface ToolContext {
  readonly registry: SessionRegistry;
  readonly bridge: ExtensionBridge;
  readonly scheduler: Scheduler;
  readonly observations: ObservationCache;
  readonly jev: JevRuntime;
}

const SESSION_HINT = "Your session handle from session_open. Never share it with other agents.";

const sessionArg = z.string().min(1).max(200);
const tabIdArg = z.number().int().nonnegative();
const urlArg = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => URL.canParse(v), "must be an absolute URL");

const schemas = {
  session_open: z.object({ label: z.string().max(200).optional() }),
  session_close: z.object({ session: sessionArg }),
  tab_create: z.object({ session: sessionArg, url: urlArg.optional() }),
  tab_list: z.object({ session: sessionArg }),
  tab_close: z.object({ session: sessionArg, tab_id: tabIdArg }),
  screenshot: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    format: z.enum(["jpeg", "png"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }),
  observe: z.object({ session: sessionArg, tab_id: tabIdArg }),
  act: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    fingerprint: z.string().min(1).max(200),
    operation: z.enum(OPERATIONS),
    target: z.union([z.string().max(32), z.number().int().nonnegative()]).optional(),
    text: z.string().max(MAX_TYPE_TEXT).optional(),
  }),
  browse: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    goal: z
      .string()
      .max(MAX_GOAL)
      .refine((v) => v.trim().length > 0, "must not be empty"),
    max_steps: z.number().int().min(1).max(MAX_MAX_STEPS).optional(),
  }),
};
type ToolName = keyof typeof schemas;

const sessionProp = { type: "string", description: SESSION_HINT } as const;
const tabIdProp = { type: "integer", minimum: 0, description: "Tab id from tab_create or tab_list." } as const;

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "session_open",
    description:
      "Open a private browser session and get its handle. Open one session per agent or subagent, pass the handle on every call, and never share it.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string", description: "Short name shown on the tab group, e.g. your task." } },
    },
  },
  {
    name: "session_close",
    description: "Close your session and all of its tabs.",
    inputSchema: { type: "object", properties: { session: sessionProp }, required: ["session"] },
  },
  {
    name: "tab_create",
    description: "Open a background tab in your session (optionally at a URL). Returns its tab_id.",
    inputSchema: {
      type: "object",
      properties: { session: sessionProp, url: { type: "string", description: "Absolute URL to open." } },
      required: ["session"],
    },
  },
  {
    name: "tab_list",
    description: "List the tabs in your session (only yours).",
    inputSchema: { type: "object", properties: { session: sessionProp }, required: ["session"] },
  },
  {
    name: "tab_close",
    description: "Close one of your session's tabs.",
    inputSchema: {
      type: "object",
      properties: { session: sessionProp, tab_id: tabIdProp },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "screenshot",
    description: "Capture the visible part of one of your tabs as an image.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg." },
        quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality." },
      },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "observe",
    description:
      "Read one of your tabs: URL, title, visible text, a numbered element table (each element lists the operations it supports; selects list options as \"<index>:<n>\"), available controls, and a fingerprint to pass to act.",
    inputSchema: {
      type: "object",
      properties: { session: sessionProp, tab_id: tabIdProp },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "act",
    description:
      "Do one operation on a tab, using the fingerprint and element indices from your latest observe of that tab. CLICK/TYPE_TEXT take an element index, SELECT takes an option index like \"3:2\", SCROLL_UP/SCROLL_DOWN/WAIT take no target. Returns stale_page (nothing done) if the page changed. Always observe again after act.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        fingerprint: { type: "string", description: "fingerprint from your latest observe of this tab." },
        operation: { type: "string", enum: [...OPERATIONS] },
        target: {
          type: ["string", "integer"],
          description: "Element index (CLICK, TYPE_TEXT) or option index like \"3:2\" (SELECT).",
        },
        text: { type: "string", maxLength: MAX_TYPE_TEXT, description: "Text to enter; required for TYPE_TEXT." },
      },
      required: ["session", "tab_id", "fingerprint", "operation"],
    },
  },
  {
    name: "browse",
    description:
      "Let Jev pursue a natural-language goal on one of your tabs: it repeatedly observes, chooses one operation (CLICK, TYPE_TEXT, SELECT, scroll, WAIT) and acts, until DONE, BLOCKED, no progress, max_steps, or Stop. Returns a status, the step trace, the final URL/title and a short element table, and model usage/cost. DONE is only Jev's claim: verify the result with observe or screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        goal: { type: "string", maxLength: MAX_GOAL, description: "What to achieve on this tab, in plain language, with every required value." },
        max_steps: { type: "integer", minimum: 1, maximum: MAX_MAX_STEPS, description: `Maximum actions (default ${DEFAULT_MAX_STEPS}).` },
      },
      required: ["session", "tab_id", "goal"],
    },
  },
];

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(toV2Error(err)) }] };
}

function parseArgs<N extends ToolName>(name: N, args: unknown): z.infer<(typeof schemas)[N]> {
  const parsed = schemas[name].safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    throw new DaemonError("invalid_args", `${where}${issue.message}`);
  }
  return parsed.data as z.infer<(typeof schemas)[N]>;
}

/** Run one tool call. Never throws: errors become `isError` results with `{code, message}`. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<CallToolResult> {
  try {
    if (!(name in schemas)) throw new DaemonError("invalid_args", `unknown tool ${name}`);
    return await dispatch(ctx, name as ToolName, args);
  } catch (err) {
    if (!(err instanceof DaemonError)) log.error(`tool ${name} failed: ${(err as Error)?.message ?? "error"}`);
    return fail(err);
  }
}

/** Queue `fn` on the session's lane (tab creation and listing). */
function onSession<T>(ctx: ToolContext, session: Session, fn: () => Promise<T>): Promise<T> {
  return ctx.scheduler.runSession(session.short_id, async () => {
    ctx.registry.requireActive(session);
    return fn();
  });
}

export interface CloseResult {
  closed: boolean;
  closed_tabs: number;
  tabs_left_open?: number;
}

/**
 * Forget a session now (later calls get bad_session, queued work is rejected), then close its
 * tabs in the browser after any in-flight session-level op. `closeTabs: false` leaves them open.
 */
export async function closeSession(ctx: ToolContext, session: Session, closeTabs = true): Promise<CloseResult> {
  const { registry, scheduler, observations, bridge } = ctx;
  const ref = sessionRef(session);
  const owned = session.tabs.size;
  if (!registry.close(session)) return { closed: false, closed_tabs: 0 };
  scheduler.dropSession(ref.short_id, new DaemonError("bad_session", "session was closed"));
  observations.forgetSession(ref.short_id);
  if (!closeTabs) return { closed: true, closed_tabs: 0, tabs_left_open: owned };
  return scheduler.runSession(ref.short_id, async () => {
    if (!bridge.connected) return { closed: true, closed_tabs: 0, tabs_left_open: owned };
    const result = await bridge.request(ref, "session_close", {});
    return { closed: true, closed_tabs: result.closed_tabs };
  });
}

async function dispatch(ctx: ToolContext, name: ToolName, rawArgs: unknown): Promise<CallToolResult> {
  const { registry, bridge, observations } = ctx;
  switch (name) {
    case "session_open": {
      const args = parseArgs(name, rawArgs);
      const { handle, session } = registry.open(args.label);
      log.info(`session ${session.short_id} opened`);
      return ok({ session: handle, short_id: session.short_id, label: session.label });
    }
    case "session_close": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const result = await closeSession(ctx, session);
      log.info(`session ${session.short_id} closed`);
      return ok(result);
    }
    case "tab_create": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const tab = await onSession(ctx, session, async () => {
        const created = await bridge.request(sessionRef(session), "tab_create", args.url ? { url: args.url } : {});
        if (registry.getByShortId(session.short_id) !== session) {
          throw new DaemonError("bad_session", "session was closed while the tab was being created");
        }
        registry.addTab(session.short_id, created.tab_id);
        return created;
      });
      return ok(tab);
    }
    case "tab_list": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const tabs = await onSession(ctx, session, async () => {
        const { tabs: listed } = await bridge.request(sessionRef(session), "tab_list", {});
        if (registry.getByShortId(session.short_id) !== session) return [];
        return registry.setTabs(session, listed);
      });
      return ok({ tabs });
    }
    case "tab_close": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const result = await onTab(ctx, session, args.tab_id, async () => {
        const closed = await bridge.request(sessionRef(session), "tab_close", { tab_id: args.tab_id });
        registry.removeTab(session.short_id, args.tab_id);
        return closed;
      });
      return ok(result);
    }
    case "screenshot": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const opArgs: { tab_id: number; format?: "jpeg" | "png"; quality?: number } = { tab_id: args.tab_id };
      if (args.format) opArgs.format = args.format;
      if (args.quality !== undefined) opArgs.quality = args.quality;
      const shot = await onTab(ctx, session, args.tab_id, () => bridge.request(sessionRef(session), "screenshot", opArgs));
      return {
        content: [
          { type: "image", data: shot.data, mimeType: shot.media_type },
          { type: "text", text: JSON.stringify({ width: shot.width, height: shot.height, media_type: shot.media_type }) },
        ],
      };
    }
    case "observe": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const observation = await onTab(ctx, session, args.tab_id, async () => {
        const snapshot = checkSnapshot(await bridge.request(sessionRef(session), "snapshot", { tab_id: args.tab_id }));
        const space = actionSpace(snapshot.actions);
        observations.set(session.short_id, args.tab_id, snapshot.fingerprint, space);
        return toObservation(snapshot, space);
      });
      return ok(observation);
    }
    case "act": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      registry.requireTab(session, args.tab_id);
      if (args.operation === "TYPE_TEXT" && !args.text) {
        throw new DaemonError("invalid_args", "TYPE_TEXT needs non-empty text");
      }
      const executed = await onTab(ctx, session, args.tab_id, async () => {
        const space = observations.require(session.short_id, args.tab_id, args.fingerprint);
        const { action, target } = resolveAct(space, args.operation, args.target);
        const opArgs: { tab_id: number; fingerprint: string; action_id: string; text?: string } = {
          tab_id: args.tab_id,
          fingerprint: args.fingerprint,
          action_id: action.id,
        };
        if (action.kind === "fill") opArgs.text = args.text;
        let result;
        try {
          // Browser actions are never retried.
          result = await bridge.request(sessionRef(session), "act", opArgs);
        } catch (err) {
          // Nothing executed on target_covered/target_invalid, so the observation stays usable.
          if (!isCode(err, "target_covered", "target_invalid")) observations.forget(session.short_id, args.tab_id);
          throw err;
        }
        observations.forget(session.short_id, args.tab_id);
        return {
          executed: { operation: args.operation, target, label: action.label },
          page_changed: typeof result?.page_changed === "boolean" ? result.page_changed : null,
        };
      });
      return ok(executed);
    }
    case "browse": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      registry.requireTab(session, args.tab_id);
      return ok(await runBrowse(ctx, session, args.tab_id, args.goal.trim(), args.max_steps ?? DEFAULT_MAX_STEPS));
    }
  }
}
