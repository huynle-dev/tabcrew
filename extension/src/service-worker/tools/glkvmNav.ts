import type { ToolContext, ToolHandler, ToolResult } from "../../types/messages.js";
import { GlkvmSequenceTool } from "./glkvmSequence.js";

type OsProfile = "macos" | "windows" | "linux" | "unknown";
type NavMacro = "app_switch" | "app_switch_n" | "open_launcher" | "open_app" | "confirm" | "escape" | "next_field" | "previous_field";

type SequenceStep = Record<string, unknown>;

const SUPPORTED_OS = new Set<OsProfile>(["macos", "windows", "linux", "unknown"]);
const SUPPORTED_MACROS = new Set<NavMacro>(["app_switch", "app_switch_n", "open_launcher", "open_app", "confirm", "escape", "next_field", "previous_field"]);

function json(success: boolean, value: Record<string, unknown>): ToolResult {
  return { success, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function requireTabId(args: Record<string, unknown>): number {
  if (typeof args.tabId !== "number" || !Number.isInteger(args.tabId)) throw new Error('The "tabId" argument is required for GLKVM nav');
  return args.tabId;
}

function navMacro(value: unknown): NavMacro {
  if (typeof value !== "string" || !SUPPORTED_MACROS.has(value as NavMacro)) throw new Error("Unsupported GLKVM nav macro");
  return value as NavMacro;
}

function osProfile(value: unknown): OsProfile {
  if (value === undefined) return "unknown";
  if (typeof value === "string" && SUPPORTED_OS.has(value as OsProfile)) return value as OsProfile;
  throw new Error("Unsupported GLKVM nav os");
}

function requireKnownOs(macro: NavMacro, os: OsProfile): Exclude<OsProfile, "unknown"> {
  if (os === "unknown") throw new Error(`GLKVM nav macro "${macro}" requires os to be one of: macos, windows, linux`);
  return os;
}

function waitStep(args: Record<string, unknown>): SequenceStep {
  return { action: "wait", ...(args.timeout !== undefined ? { timeout: args.timeout } : {}), ...(args.pollInterval !== undefined ? { pollInterval: args.pollInterval } : {}) };
}

function launcherKey(os: Exclude<OsProfile, "unknown">): string {
  if (os === "macos") return "Meta+Space";
  if (os === "windows") return "Meta";
  return "Alt+F2";
}

function appSwitchKey(os: Exclude<OsProfile, "unknown">): string {
  return os === "macos" ? "Meta+Tab" : "Alt+Tab";
}

function appSwitchModifier(os: Exclude<OsProfile, "unknown">): string {
  return os === "macos" ? "Meta" : "Alt";
}

function appSwitchNSteps(os: Exclude<OsProfile, "unknown">, args: Record<string, unknown>): SequenceStep[] {
  const count = args.count === undefined ? 1 : args.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) throw new Error('The "count" argument must be a positive integer');
  const modifier = appSwitchModifier(os);
  return [{ action: "key", key: modifier, keyAction: "down" }, ...Array.from({ length: count }, () => ({ action: "key", key: "Tab" })), { action: "key", key: modifier, keyAction: "up" }, waitStep(args)];
}

function requireApp(args: Record<string, unknown>): string {
  if (typeof args.app !== "string" || args.app.length === 0) throw new Error('The "app" argument is required');
  return args.app;
}

function expandSteps(macro: NavMacro, os: OsProfile, args: Record<string, unknown>): SequenceStep[] {
  if (macro === "confirm") return [{ action: "key", key: "Enter" }, waitStep(args)];
  if (macro === "escape") return [{ action: "key", key: "Escape" }, waitStep(args)];
  if (macro === "next_field") return [{ action: "key", key: "Tab" }, waitStep(args)];
  if (macro === "previous_field") return [{ action: "key", key: "Shift+Tab", keyAction: "hotkey" }, waitStep(args)];

  const knownOs = requireKnownOs(macro, os);
  if (macro === "app_switch") return [{ action: "key", key: appSwitchKey(knownOs), keyAction: "hotkey" }, waitStep(args)];
  if (macro === "app_switch_n") return appSwitchNSteps(knownOs, args);

  const launcherSteps = [{ action: "key", key: launcherKey(knownOs), keyAction: "hotkey" }, waitStep(args)];
  if (macro === "open_launcher") return launcherSteps;
  return [...launcherSteps, { action: "type", text: requireApp(args) }, { action: "key", key: "Enter" }, waitStep(args)];
}

export class GlkvmNavTool implements ToolHandler {
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const tabId = requireTabId(args);
      const macro = navMacro(args.macro);
      const os = osProfile(args.os);
      const steps = expandSteps(macro, os, args);
      return await new GlkvmSequenceTool().execute({ tabId, ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {}), steps }, context);
    } catch (error) {
      return json(false, { completed: false, errorType: "nav_validation_error", error: error instanceof Error ? error.message : String(error) });
    }
  }
}
