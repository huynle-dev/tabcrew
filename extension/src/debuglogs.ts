/**
 * Per-tab console and network ring buffers, fed by CDP events of the tab's own debugger session.
 *
 * Only the fields of V2ConsoleEntry / V2NetworkEntry are ever stored: entries are built field by
 * field from the event, so headers, cookies, post data, bodies and query strings never enter the
 * buffer. Buffers live only while the debugger is attached; they are dropped on detach/close.
 */

import type { V2ConsoleEntry, V2NetworkEntry } from "@tabcrew/shared/v2";
import { OpError } from "./errors.js";

export const CONSOLE_CAPACITY = 500;
export const NETWORK_CAPACITY = 500;
export const MAX_CONSOLE_TEXT = 500;
export const MAX_URL = 500;
export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 200;

type ConsoleLevel = V2ConsoleEntry["level"];
type NetworkRecord = { -readonly [K in keyof V2NetworkEntry]: V2NetworkEntry[K] };

const CONSOLE_LEVELS: Readonly<Record<string, ConsoleLevel>> = {
  log: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
  debug: "debug",
};

/** Origin + path only. data:/blob: keep just the scheme. Never a query string or fragment. */
export function sanitizeUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  let out: string;
  try {
    const u = new URL(raw);
    if (u.protocol === "data:" || u.protocol === "blob:") return u.protocol;
    out = u.origin !== "null" ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname}`;
  } catch {
    const scheme = /^(data|blob):/i.exec(raw);
    if (scheme) return `${scheme[1]!.toLowerCase()}:`;
    out = raw.split(/[?#]/, 1)[0]!;
  }
  return out.length > MAX_URL ? out.slice(0, MAX_URL) : out;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

interface RemoteObjectLike {
  type?: unknown;
  subtype?: unknown;
  value?: unknown;
  unserializableValue?: unknown;
  description?: unknown;
}

function remoteText(arg: unknown): string {
  const o = (arg ?? {}) as RemoteObjectLike;
  if (typeof o.unserializableValue === "string") return o.unserializableValue;
  if (o.value !== undefined) {
    if (typeof o.value === "string") return o.value;
    if (typeof o.value === "number" || typeof o.value === "boolean") return String(o.value);
    if (o.value === null) return "null";
  }
  if (typeof o.description === "string") return o.description;
  if (o.subtype === "null") return "null";
  return typeof o.type === "string" ? o.type : "";
}

function stackUrl(stack: unknown): string | undefined {
  const frames = (stack as { callFrames?: { url?: unknown }[] } | undefined)?.callFrames;
  const url = Array.isArray(frames) ? frames.find((f) => typeof f?.url === "string" && f.url)?.url : undefined;
  return typeof url === "string" ? sanitizeUrl(url) : undefined;
}

class Ring<T> {
  readonly items: T[] = [];
  dropped = 0;
  constructor(private readonly capacity: number) {}

  /** Append; returns the evicted item, if any. */
  push(item: T): T | undefined {
    this.items.push(item);
    if (this.items.length <= this.capacity) return undefined;
    this.dropped++;
    return this.items.shift();
  }
}

interface TabLogs {
  console: Ring<V2ConsoleEntry>;
  network: Ring<NetworkRecord>;
  /** CDP requestId → live entry, with the monotonic start time (seconds). */
  inflight: Map<string, { entry: NetworkRecord; start: number | null }>;
}

export interface LogQuery {
  source?: unknown;
  limit?: unknown;
  only_errors?: unknown;
}

export type LogResult = { entries: V2ConsoleEntry[] | V2NetworkEntry[]; dropped: number };

export class DebugLogStore {
  private readonly tabs = new Map<number, TabLogs>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Start (or keep) the tab's buffers. Called when the debugger attaches. */
  start(tabId: number): void {
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        console: new Ring(CONSOLE_CAPACITY),
        network: new Ring(NETWORK_CAPACITY),
        inflight: new Map(),
      });
    }
  }

  forget(tabId: number): void {
    this.tabs.delete(tabId);
  }

  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  handleEvent(tabId: number, method: string, params: unknown): void {
    const logs = this.tabs.get(tabId);
    if (!logs) return;
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "Runtime.consoleAPICalled":
        return this.onConsole(logs, p);
      case "Runtime.exceptionThrown":
        return this.onException(logs, p);
      case "Network.requestWillBeSent":
        return this.onRequest(logs, p);
      case "Network.responseReceived":
        return this.onResponse(logs, p);
      case "Network.loadingFinished":
        return this.onFinished(logs, p, undefined);
      case "Network.loadingFailed":
        return this.onFinished(logs, p, typeof p.errorText === "string" && p.errorText ? p.errorText : p.canceled ? "canceled" : "failed");
      default:
        return;
    }
  }

  query(tabId: number, q: LogQuery): LogResult {
    if (q.source !== "console" && q.source !== "network") throw new OpError("invalid_args", "source must be console or network");
    let limit = DEFAULT_LOG_LIMIT;
    if (q.limit !== undefined) {
      if (typeof q.limit !== "number" || !Number.isInteger(q.limit) || q.limit < 1) {
        throw new OpError("invalid_args", `limit must be an integer from 1 to ${MAX_LOG_LIMIT}`);
      }
      limit = Math.min(q.limit, MAX_LOG_LIMIT);
    }
    if (q.only_errors !== undefined && typeof q.only_errors !== "boolean") {
      throw new OpError("invalid_args", "only_errors must be a boolean");
    }
    const logs = this.tabs.get(tabId);
    if (!logs) return { entries: [], dropped: 0 };
    if (q.source === "console") {
      let items = logs.console.items;
      if (q.only_errors) items = items.filter((e) => e.level === "error" || e.level === "exception");
      return { entries: items.slice(-limit).map((e) => ({ ...e })), dropped: logs.console.dropped };
    }
    let items: readonly NetworkRecord[] = logs.network.items;
    if (q.only_errors) items = items.filter((e) => e.failed !== undefined || (e.status !== null && e.status >= 400));
    return { entries: items.slice(-limit).map((e) => ({ ...e })), dropped: logs.network.dropped };
  }

  private pushConsole(logs: TabLogs, level: ConsoleLevel, text: string, url: string | undefined, t: number): void {
    const entry: { level: ConsoleLevel; text: string; url?: string; t: number } = { level, text: clip(text, MAX_CONSOLE_TEXT), t };
    if (url) entry.url = url;
    logs.console.push(entry);
  }

  private onConsole(logs: TabLogs, p: Record<string, unknown>): void {
    const level = CONSOLE_LEVELS[String(p.type)] ?? "log";
    const args = Array.isArray(p.args) ? p.args : [];
    // Build the text lazily and stop once it is long enough.
    let text = "";
    for (const arg of args) {
      text += (text ? " " : "") + remoteText(arg);
      if (text.length >= MAX_CONSOLE_TEXT) break;
    }
    const t = typeof p.timestamp === "number" ? Math.round(p.timestamp) : this.now();
    this.pushConsole(logs, level, text, stackUrl(p.stackTrace), t);
  }

  private onException(logs: TabLogs, p: Record<string, unknown>): void {
    const d = (p.exceptionDetails ?? {}) as { text?: unknown; url?: unknown; exception?: { description?: unknown }; stackTrace?: unknown };
    const description = typeof d.exception?.description === "string" ? d.exception.description : undefined;
    const text = description ?? (typeof d.text === "string" ? d.text : "exception");
    const url = typeof d.url === "string" && d.url ? sanitizeUrl(d.url) : stackUrl(d.stackTrace);
    const t = typeof p.timestamp === "number" ? Math.round(p.timestamp) : this.now();
    this.pushConsole(logs, "exception", text, url, t);
  }

  private onRequest(logs: TabLogs, p: Record<string, unknown>): void {
    const requestId = typeof p.requestId === "string" ? p.requestId : null;
    if (!requestId) return;
    const timestamp = typeof p.timestamp === "number" ? p.timestamp : null;
    const prior = logs.inflight.get(requestId);
    if (prior) {
      // A redirect reuses the requestId: close the previous hop with its redirect status.
      const redirect = p.redirectResponse as { status?: unknown } | undefined;
      if (typeof redirect?.status === "number") prior.entry.status = redirect.status;
      prior.entry.ms = elapsed(prior.start, timestamp);
      logs.inflight.delete(requestId);
    }
    const request = (p.request ?? {}) as { url?: unknown; method?: unknown };
    const entry: NetworkRecord = {
      method: typeof request.method === "string" ? clip(request.method, 16) : "GET",
      url: sanitizeUrl(request.url),
      status: null,
      type: typeof p.type === "string" ? clip(p.type, 32) : "Other",
      ms: null,
      t: typeof p.wallTime === "number" ? Math.round(p.wallTime * 1000) : this.now(),
    };
    const evicted = logs.network.push(entry);
    if (evicted) {
      for (const [id, live] of logs.inflight) if (live.entry === evicted) logs.inflight.delete(id);
    }
    logs.inflight.set(requestId, { entry, start: timestamp });
  }

  private onResponse(logs: TabLogs, p: Record<string, unknown>): void {
    const live = typeof p.requestId === "string" ? logs.inflight.get(p.requestId) : undefined;
    if (!live) return;
    const status = (p.response as { status?: unknown } | undefined)?.status;
    if (typeof status === "number") live.entry.status = status;
    if (typeof p.type === "string") live.entry.type = clip(p.type, 32);
  }

  private onFinished(logs: TabLogs, p: Record<string, unknown>, failure: string | undefined): void {
    const id = typeof p.requestId === "string" ? p.requestId : "";
    const live = logs.inflight.get(id);
    if (!live) return;
    logs.inflight.delete(id);
    live.entry.ms = elapsed(live.start, typeof p.timestamp === "number" ? p.timestamp : null);
    if (failure !== undefined) live.entry.failed = clip(failure, 200);
  }
}

function elapsed(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null;
  return Math.round((end - start) * 1000);
}
