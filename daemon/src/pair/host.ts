/**
 * Chrome native messaging host `com.tabcrew.pair`: hands the daemon token to the TabCrew extension.
 *
 * Framing (both directions): uint32 little-endian byte length, then that many bytes of UTF-8 JSON.
 * One request per launch: `{type:"get_token"}` → `{token}`; anything else → `{error}`.
 * Chrome passes the caller's origin (`chrome-extension://<id>/`) as the first argument; it must be
 * a known TabCrew extension even though the host manifest's allowed_origins already restricts it.
 * Never logs the token.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tabcrewExtensionOrigins, type PairResponse } from "@tabcrew/shared/product";
import { resolveHome } from "../home.js";

/** Chrome caps host → extension messages at 1 MB; requests here are tiny. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Decode one framed message from the start of `buf`; null if incomplete. Throws if malformed or too large. */
export function decodeMessage(buf: Buffer): { message: unknown; rest: Buffer } | null {
  if (buf.length < 4) return null;
  const length = buf.readUInt32LE(0);
  if (length > MAX_MESSAGE_BYTES) throw new Error("message too large");
  if (buf.length < 4 + length) return null;
  const message = JSON.parse(buf.subarray(4, 4 + length).toString("utf8")) as unknown;
  return { message, rest: buf.subarray(4 + length) };
}

/** The origin argument Chrome passes (ignores `--parent-window=` on Windows). */
export function callerOrigin(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("chrome-extension://")) ?? null;
}

export function originAllowed(origin: string | null, allowed: readonly string[] = tabcrewExtensionOrigins()): boolean {
  if (!origin) return false;
  const normalized = origin.endsWith("/") ? origin : `${origin}/`;
  return allowed.includes(normalized);
}

export interface PairHostDeps {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly homedir: string;
  readonly allowedOrigins?: readonly string[];
  readonly readToken?: (path: string) => string;
}

function tokenFile(env: Record<string, string | undefined>, homedir: string): string {
  return join(resolveHome(env, homedir), "token");
}

/** Answer one request. Pure apart from reading the token file. */
export function handlePairRequest(request: unknown, deps: PairHostDeps): PairResponse {
  if (!originAllowed(callerOrigin(deps.argv), deps.allowedOrigins)) return { error: "caller is not a TabCrew extension" };
  if (!request || typeof request !== "object" || (request as { type?: unknown }).type !== "get_token") {
    return { error: "unsupported request" };
  }
  let token: string;
  try {
    token = (deps.readToken ?? ((p) => readFileSync(p, "utf8")))(tokenFile(deps.env, deps.homedir)).trim();
  } catch {
    return { error: "no token: run npx tabcrew setup" };
  }
  if (token.length < 32) return { error: "no token: run npx tabcrew setup" };
  return { token };
}

export interface PairStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}

/** Read one framed request from stdin, write one framed response to stdout, then resolve. */
export function runPairHost(streams: PairStreams, deps: PairHostDeps): Promise<PairResponse> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (response: PairResponse) => {
      if (done) return;
      done = true;
      streams.stdin.removeListener("data", onData);
      streams.stdin.removeListener("end", onEnd);
      streams.stdout.write(encodeMessage(response), () => resolve(response));
    };
    const onData = (chunk: Buffer | string) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      let decoded: ReturnType<typeof decodeMessage>;
      try {
        decoded = decodeMessage(buf);
      } catch {
        finish({ error: "malformed request" });
        return;
      }
      if (decoded) finish(handlePairRequest(decoded.message, deps));
    };
    const onEnd = () => finish({ error: "no request" });
    streams.stdin.on("data", onData);
    streams.stdin.on("end", onEnd);
  });
}
