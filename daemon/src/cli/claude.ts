import { SERVER_NAME } from "./opencode.js";
import type { RunResult, System } from "./system.js";

/** Claude Code stores the header itself, so the token value (not a file reference) is passed. */
export function claudeAddArgs(url: string, token: string): string[] {
  // --header is variadic, so it must come after the name and URL.
  return ["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, url, "--header", `Authorization: Bearer ${token}`];
}

export async function claudeHasServer(sys: System, claude: string, name: string = SERVER_NAME): Promise<boolean> {
  return (await sys.run(claude, ["mcp", "get", name])).code === 0;
}

export type ClaudeResult = { status: "present" } | { status: "added" } | { status: "failed"; message: string };

function redact(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

function firstLine(result: RunResult, token: string): string {
  return redact((result.stderr || result.stdout).trim().split("\n")[0] ?? "", token) || `exit ${result.code}`;
}

/** Register TabCrew in Claude Code (user scope) unless it is already there. Never prints the token. */
export async function ensureClaudeServer(sys: System, claude: string, url: string, token: string): Promise<ClaudeResult> {
  if (await claudeHasServer(sys, claude)) return { status: "present" };
  const result = await sys.run(claude, claudeAddArgs(url, token));
  if (result.code !== 0) return { status: "failed", message: firstLine(result, token) };
  return { status: "added" };
}

export async function removeClaudeServer(sys: System, claude: string, name: string = SERVER_NAME): Promise<boolean> {
  if (!(await claudeHasServer(sys, claude, name))) return false;
  return (await sys.run(claude, ["mcp", "remove", "--scope", "user", name])).code === 0;
}
