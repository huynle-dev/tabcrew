import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  V2_PROTOCOL_VERSION,
  type V2DaemonFrame,
  type V2Error,
  type V2Event,
  type V2Request,
  type V2TabInfo,
  type V2Welcome,
} from "@chromeuse/shared/v2";
import { WebSocket } from "ws";
import { loadConfig, type DaemonConfig } from "../config.js";
import { startDaemon, type DaemonOverrides, type RunningDaemon } from "../daemon.js";
import { setLogSink } from "../log.js";

setLogSink(() => {});

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "chromeuse-daemon-test-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function testConfig(home: string, extra: Record<string, string> = {}): DaemonConfig {
  return loadConfig({ CHROMEUSE_HOME: home, CHROMEUSE_MCP_PORT: "0", CHROMEUSE_EXTENSION_PORT: "0", ...extra });
}

export async function startTestDaemon(
  home: string,
  overrides: DaemonOverrides = {},
  env: Record<string, string> = {},
): Promise<RunningDaemon> {
  return startDaemon(testConfig(home, env), { offlineWaitMs: 300, ...overrides });
}

export function rawHttp(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function mcpClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

export type ToolOutcome = { ok: true; value: any } | { ok: false; error: V2Error };

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.find((c) => c.type === "text");
  const parsed = text && text.type === "text" ? JSON.parse(text.text) : undefined;
  if (result.isError) return { ok: false, error: parsed };
  return { ok: true, value: result.content.some((c) => c.type === "image") ? result : parsed };
}

type Handler = (req: V2Request) => unknown | Promise<unknown>;

/** Thrown by a FakeExtension handler to answer with `ok: false`. */
export class WireError {
  constructor(readonly error: V2Error) {}
}

/** Minimal stand-in for extension-v2: speaks the v2 protocol and simulates tab groups. */
export class FakeExtension {
  readonly requests: V2Request[] = [];
  readonly groups = new Map<string, V2TabInfo[]>();
  welcome: V2Welcome | null = null;
  respondToPings = true;
  handler: Handler;
  private nextTabId = 100;
  readonly closed: Promise<{ code: number }>;

  private constructor(readonly ws: WebSocket) {
    this.handler = (req) => this.simulate(req);
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve({ code })));
    ws.on("message", (data) => void this.onMessage(JSON.parse(data.toString()) as V2DaemonFrame));
  }

  static async connect(port: number, token: string, hello: Record<string, unknown> = {}): Promise<FakeExtension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const ext = new FakeExtension(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const welcomed = new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    });
    ws.send(JSON.stringify({ type: "hello", protocol: V2_PROTOCOL_VERSION, token, extension_version: "test", ...hello }));
    await welcomed;
    return ext;
  }

  send(frame: V2Event | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.ws.close();
  }

  /** Wait until at least `n` requests have arrived. */
  async waitForRequests(n: number, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (this.requests.length < n) {
      if (Date.now() - start > timeoutMs) throw new Error(`only ${this.requests.length} requests`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async onMessage(frame: V2DaemonFrame): Promise<void> {
    if (frame.type === "welcome") {
      this.welcome = frame;
      return;
    }
    if (frame.type === "ping") {
      if (this.respondToPings) this.ws.send(JSON.stringify({ type: "pong", t: frame.t }));
      return;
    }
    this.requests.push(frame);
    try {
      const result = await this.handler(frame);
      if (result === HOLD) return;
      this.ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
    } catch (err) {
      const error = err instanceof WireError ? err.error : { code: "internal", message: String(err) };
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "response", id: frame.id, ok: false, error }));
      }
    }
  }

  simulate(req: V2Request): unknown {
    const tabs = this.groups.get(req.session.short_id) ?? [];
    this.groups.set(req.session.short_id, tabs);
    const args = req.args as Record<string, unknown>;
    switch (req.op) {
      case "tab_create": {
        const tab = { tab_id: this.nextTabId++, url: (args.url as string) ?? "about:blank", title: "" };
        tabs.push(tab);
        return tab;
      }
      case "tab_list":
        return { tabs };
      case "tab_close": {
        const idx = tabs.findIndex((t) => t.tab_id === args.tab_id);
        if (idx < 0) throw new WireError({ code: "tab_gone", message: "tab is gone" });
        tabs.splice(idx, 1);
        return { closed: true };
      }
      case "session_close": {
        this.groups.delete(req.session.short_id);
        return { closed_tabs: tabs.length };
      }
      case "screenshot":
        if (!tabs.some((t) => t.tab_id === args.tab_id)) throw new WireError({ code: "tab_not_owned", message: "x" });
        return { media_type: "image/png", data: "iVBORw0KGgo=", width: 800, height: 600 };
      default:
        throw new WireError({ code: "internal", message: "unsupported" });
    }
  }
}

/** Return from a handler to never answer the request. */
export const HOLD = Symbol("hold");

export async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}
