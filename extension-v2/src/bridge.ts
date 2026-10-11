/**
 * Connect-out WebSocket bridge to the ChromeUse v2 daemon.
 *
 * - Sends `hello` (protocol 2 + token) as the first frame; the daemon answers `welcome`
 *   or closes with 4401 if the token is wrong.
 * - Requests are dispatched concurrently: there is no queue here. Per-tab ordering is the
 *   daemon's job.
 * - Reconnects with exponential backoff (capped at 30 s). The service worker also calls
 *   `ensureConnected()` from a 1-minute alarm in case it was suspended while offline.
 * - No token → status `needs_token`, no connection. 4401 → status `unauthorized` and no
 *   retries until the token changes.
 */

import {
  V2_PROTOCOL_VERSION,
  type V2DaemonFrame,
  type V2Event,
  type V2ExtensionFrame,
  type V2Request,
  type V2Welcome,
} from "@chromeuse/shared/v2";
import type { BridgeConfig, BridgeStatus } from "./config.js";
import { toWireError } from "./errors.js";

export const UNAUTHORIZED_CLOSE_CODE = 4401;
export const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const OPEN = 1;

/** The subset of the browser WebSocket used here (lets tests inject a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface BridgeDeps {
  loadConfig(): Promise<BridgeConfig>;
  createSocket(url: string): SocketLike;
  extensionVersion: string;
  handleRequest(req: V2Request): Promise<unknown>;
  /** Called once per connection after `welcome`. Use it to reconcile and send `groups`. */
  onWelcome(welcome: V2Welcome): Promise<void> | void;
  onStatus?(status: BridgeStatus): void;
}

export class Bridge {
  private socket: SocketLike | null = null;
  private welcomed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private generation = 0;
  private unauthorizedToken: string | null = null;
  private _status: BridgeStatus = "offline";

  constructor(private readonly deps: BridgeDeps) {}

  get status(): BridgeStatus {
    return this._status;
  }

  get isReady(): boolean {
    return this.welcomed && this.socket !== null && this.socket.readyState === OPEN;
  }

  /** Read config and connect if possible. Supersedes any start in progress. */
  async start(): Promise<void> {
    const gen = ++this.generation;
    const config = await this.deps.loadConfig();
    if (gen !== this.generation) return;
    if (this.socket) return;
    if (!config.token) {
      this.setStatus("needs_token");
      return;
    }
    if (this.unauthorizedToken !== null && config.token === this.unauthorizedToken) {
      this.setStatus("unauthorized");
      return;
    }
    this.unauthorizedToken = null;
    this.open(config.token, config.port);
  }

  /** Alarm/wake hook: reconnect if nothing is connected or pending. */
  ensureConnected(): Promise<void> {
    if (this.socket || this.reconnectTimer !== null) return Promise.resolve();
    return this.start();
  }

  /** Token or port changed: drop the current connection and start over. */
  reconfigure(): Promise<void> {
    this.clearTimer();
    this.attempts = 0;
    this.unauthorizedToken = null;
    this.dropSocket();
    return this.start();
  }

  /** Send an unsolicited event. Dropped (returns false) if not connected; the daemon resyncs via `groups`. */
  sendEvent(event: V2Event): boolean {
    if (!this.isReady || !this.socket) return false;
    return this.sendOn(this.socket, event);
  }

  private open(token: string, port: number): void {
    this.setStatus("connecting");
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(`ws://127.0.0.1:${port}`);
    } catch (err) {
      console.warn("[v2 bridge] connect failed:", err);
      this.setStatus("offline");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.welcomed = false;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.sendOn(socket, {
        type: "hello",
        protocol: V2_PROTOCOL_VERSION,
        token,
        extension_version: this.deps.extensionVersion,
      });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handleRaw(socket, ev.data);
    };
    socket.onerror = () => {
      // onclose follows and handles reconnects.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.welcomed = false;
      if (ev.code === UNAUTHORIZED_CLOSE_CODE) {
        this.unauthorizedToken = token;
        this.setStatus("unauthorized");
        return;
      }
      this.setStatus("offline");
      this.scheduleReconnect();
    };
  }

  private handleRaw(socket: SocketLike, data: unknown): void {
    if (typeof data !== "string") return;
    let frame: V2DaemonFrame;
    try {
      frame = JSON.parse(data) as V2DaemonFrame;
    } catch {
      console.warn("[v2 bridge] ignoring malformed frame");
      return;
    }
    switch (frame?.type) {
      case "welcome":
        this.welcomed = true;
        this.attempts = 0;
        this.setStatus("connected");
        void Promise.resolve()
          .then(() => this.deps.onWelcome(frame))
          .catch((err) => console.warn("[v2 bridge] welcome handling failed:", err));
        break;
      case "ping":
        this.sendOn(socket, { type: "pong", t: frame.t });
        break;
      case "request":
        void this.dispatch(socket, frame);
        break;
      default:
        console.warn("[v2 bridge] unknown frame type:", (frame as { type?: unknown })?.type);
    }
  }

  private async dispatch(socket: SocketLike, req: V2Request): Promise<void> {
    if (typeof req.id !== "string") return;
    let response: V2ExtensionFrame;
    if (!req.session || typeof req.session.short_id !== "string" || typeof req.op !== "string") {
      response = {
        type: "response",
        id: req.id,
        ok: false,
        error: { code: "invalid_args", message: "request needs op and session.short_id" },
      };
    } else {
      try {
        const result = await this.deps.handleRequest(req);
        response = { type: "response", id: req.id, ok: true, result } as V2ExtensionFrame;
      } catch (err) {
        response = { type: "response", id: req.id, ok: false, error: toWireError(err) };
      }
    }
    this.sendOn(socket, response);
  }

  private sendOn(socket: SocketLike, frame: V2ExtensionFrame): boolean {
    if (socket !== this.socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      console.warn("[v2 bridge] send failed:", err);
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    if (socket) {
      try {
        socket.close(1000, "reconfigure");
      } catch {
        // ignore
      }
    }
  }

  private setStatus(status: BridgeStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.deps.onStatus?.(status);
  }
}
