/**
 * Everything the `tabcrew` CLI does to the outside world goes through `System`, so tests can run
 * the whole setup/doctor/uninstall flow against a temp HOME with fake launchctl, claude and fetch.
 */

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { Env } from "../home.js";
import { stableNodePath } from "../launchd.js";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program without a shell. Never pass secrets you would not want in `ps` output. */
export type Runner = (cmd: string, args: readonly string[]) => Promise<RunResult>;

export interface Prompter {
  /** Yes/no question; returns `defaultValue` on empty input. */
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  /** Hidden input (no echo). Empty string means skip. */
  secret(question: string): Promise<string>;
}

export interface System {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly uid: number;
  readonly env: Env;
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  /** Absolute node binary for launchd and the pairing host wrapper. */
  readonly nodePath: string;
  /** Directory holding the bundled daemon.mjs and pair-host.mjs (null if unknown). */
  readonly runtimeDir: string | null;
  run: Runner;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  prompt: Prompter;
  out(line: string): void;
  which(cmd: string): string | null;
}

export const realRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function whichIn(cmd: string, pathEnv: string | undefined): string | null {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function ask(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
  });
}

function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question).then((v) => (v ?? "").trim());
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export const ttyPrompter: Prompter = {
  async confirm(question, defaultValue) {
    const answer = await ask(`${question} ${defaultValue ? "[Y/n]" : "[y/N]"} `);
    if (answer === null || answer.trim() === "") return defaultValue;
    return /^y(es)?$/i.test(answer.trim());
  },
  secret: readHidden,
};

export function realSystem(runtimeDir: string | null): System {
  return {
    platform: process.platform,
    homedir: homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    env: process.env,
    nodeVersion: process.versions.node,
    nodePath: stableNodePath(),
    runtimeDir,
    run: realRunner,
    fetch: (...args) => fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    prompt: ttyPrompter,
    out: (line) => process.stdout.write(`${line}\n`),
    which: (cmd) => whichIn(cmd, process.env.PATH),
  };
}
