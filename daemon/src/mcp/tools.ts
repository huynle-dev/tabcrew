import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExtensionBridge } from "../bridge.js";
import { DaemonError, toV2Error } from "../errors.js";
import { log } from "../log.js";
import { sessionRef, type SessionRegistry } from "../sessions.js";

export interface ToolContext {
  readonly registry: SessionRegistry;
  readonly bridge: ExtensionBridge;
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

async function dispatch(ctx: ToolContext, name: ToolName, rawArgs: unknown): Promise<CallToolResult> {
  const { registry, bridge } = ctx;
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
      const ref = sessionRef(session);
      const ownedTabs = session.tabs.size;
      registry.close(session);
      log.info(`session ${ref.short_id} closed`);
      if (!bridge.connected) {
        return ok({ closed: true, closed_tabs: 0, tabs_left_open: ownedTabs });
      }
      const result = await bridge.request(ref, "session_close", {});
      return ok({ closed: true, closed_tabs: result.closed_tabs });
    }
    case "tab_create": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const tab = await bridge.request(sessionRef(session), "tab_create", args.url ? { url: args.url } : {});
      if (registry.getByShortId(session.short_id) !== session) {
        throw new DaemonError("bad_session", "session was closed while the tab was being created");
      }
      registry.addTab(session.short_id, tab.tab_id);
      return ok(tab);
    }
    case "tab_list": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const { tabs } = await bridge.request(sessionRef(session), "tab_list", {});
      if (registry.getByShortId(session.short_id) !== session) return ok({ tabs: [] });
      return ok({ tabs: registry.setTabs(session, tabs) });
    }
    case "tab_close": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      registry.requireTab(session, args.tab_id);
      try {
        const result = await bridge.request(sessionRef(session), "tab_close", { tab_id: args.tab_id });
        registry.removeTab(session.short_id, args.tab_id);
        return ok(result);
      } catch (err) {
        if (err instanceof DaemonError && err.code === "tab_gone") registry.removeTab(session.short_id, args.tab_id);
        throw err;
      }
    }
    case "screenshot": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      registry.requireTab(session, args.tab_id);
      const opArgs: { tab_id: number; format?: "jpeg" | "png"; quality?: number } = { tab_id: args.tab_id };
      if (args.format) opArgs.format = args.format;
      if (args.quality !== undefined) opArgs.quality = args.quality;
      let shot;
      try {
        shot = await bridge.request(sessionRef(session), "screenshot", opArgs);
      } catch (err) {
        if (err instanceof DaemonError && err.code === "tab_gone") registry.removeTab(session.short_id, args.tab_id);
        throw err;
      }
      return {
        content: [
          { type: "image", data: shot.data, mimeType: shot.media_type },
          { type: "text", text: JSON.stringify({ width: shot.width, height: shot.height, media_type: shot.media_type }) },
        ],
      };
    }
  }
}
