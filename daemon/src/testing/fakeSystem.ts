/**
 * An in-memory `System` for CLI tests: temp HOME, fake launchctl/claude (recorded calls), fake
 * fetch for /health and the OpenRouter key check, a virtual clock and scripted prompts.
 * Nothing here touches the real machine.
 */

import { vi } from "vitest";
import type { Prompter, RunResult, System } from "../cli/system.js";

export interface FakeState {
  /** launchd labels currently loaded. */
  loaded: Set<string>;
  /** Claude Code MCP servers. */
  claudeServers: Set<string>;
  /** Whether /health answers (true while com.tabcrew.daemon is loaded, unless overridden). */
  healthy: () => boolean;
  extensionConnected: boolean;
  /** OpenRouter /api/v1/key status for each key. */
  keyStatus: (key: string) => number;
  bootstrapFailures: number;
}

export interface FakeSystem extends System {
  readonly state: FakeState;
  readonly calls: string[][];
  readonly lines: string[];
  readonly fetchUrls: string[];
  readonly answers: { confirm: boolean[]; secret: string[] };
  output(): string;
}

export function fakeSystem(homedir: string, overrides: Partial<System> = {}): FakeSystem {
  const calls: string[][] = [];
  const lines: string[] = [];
  const fetchUrls: string[] = [];
  const answers = { confirm: [] as boolean[], secret: [] as string[] };
  let clock = 1_000_000;
  const state: FakeState = {
    loaded: new Set(),
    claudeServers: new Set(),
    healthy: () => state.loaded.has("com.tabcrew.daemon") || state.loaded.has("com.chromeuse.daemon"),
    extensionConnected: false,
    keyStatus: (key) => (key.startsWith("sk-or-good") ? 200 : 401),
    bootstrapFailures: 0,
  };

  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

  const run = vi.fn(async (cmd: string, args: readonly string[]): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    if (cmd === "launchctl") {
      const [verb, target, plist] = args;
      const label = (target ?? "").split("/").pop() ?? "";
      if (verb === "print") return state.loaded.has(label) ? ok(`${label} = {}`) : fail("Could not find service", 113);
      if (verb === "bootout") {
        if (!state.loaded.delete(label)) return fail("No such process", 3);
        return ok();
      }
      if (verb === "bootstrap") {
        if (state.bootstrapFailures > 0) {
          state.bootstrapFailures--;
          return fail("Bootstrap failed: 5: Input/output error", 5);
        }
        const name = (plist ?? "").split("/").pop()?.replace(/\.plist$/, "") ?? "";
        state.loaded.add(name);
        return ok();
      }
      return fail(`unexpected launchctl ${verb}`);
    }
    if (cmd.endsWith("claude")) {
      const [, verb, ...rest] = args;
      if (verb === "get") return state.claudeServers.has(rest[0]) ? ok(`${rest[0]}:`) : fail(`No MCP server found with name: ${rest[0]}`);
      if (verb === "add") {
        const name = rest.find((a, i) => !a.startsWith("-") && !["http", "user"].includes(a) && rest[i - 1] !== "--header");
        state.claudeServers.add(name ?? "?");
        return ok();
      }
      if (verb === "remove") {
        const name = rest.at(-1) ?? "";
        return state.claudeServers.delete(name) ? ok() : fail("not found");
      }
    }
    return fail(`unexpected command ${cmd}`, 127);
  });

  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    fetchUrls.push(url);
    if (url.endsWith("/health")) {
      if (!state.healthy()) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ ok: true, version: "0.4.0", extension_connected: state.extensionConnected }), { status: 200 });
    }
    if (url === "https://openrouter.ai/api/v1/key") {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response("{}", { status: state.keyStatus(auth.replace(/^Bearer /, "")) });
    }
    throw new TypeError(`unexpected fetch ${url}`);
  });

  const prompt: Prompter = {
    confirm: vi.fn(async (_q: string, def: boolean) => answers.confirm.shift() ?? def),
    secret: vi.fn(async () => answers.secret.shift() ?? ""),
  };

  const sys: FakeSystem = {
    platform: "darwin",
    homedir,
    uid: 501,
    env: {},
    nodeVersion: "22.1.0",
    nodePath: "/opt/homebrew/bin/node",
    runtimeDir: null,
    run,
    fetch: fetchFn as unknown as typeof fetch,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    prompt,
    out: (line) => {
      lines.push(line);
    },
    which: () => null,
    ...overrides,
    state,
    calls,
    lines,
    fetchUrls,
    answers,
    output: () => lines.join("\n"),
  };
  return sys;
}
