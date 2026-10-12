/**
 * The service-worker side of the bridge. The daemon socket lives in the offscreen document; this
 * relay receives its requests over the `v2-bridge` port, runs them concurrently (no queue), and
 * posts responses and events back. It also mirrors the socket status for the popup.
 */

import type { V2Event, V2Request, V2Response, V2Welcome } from "@tabcrew/shared/v2";
import type { BridgeConfig, BridgeStatus } from "./config.js";
import { toWireError } from "./errors.js";
import type { PortLike, ToOffscreen, ToServiceWorker } from "./relay-protocol.js";

export const RECHECK_OFFSCREEN_MS = 1_000;

export interface RelayDeps {
  loadConfig(): Promise<BridgeConfig>;
  handleRequest(req: V2Request): Promise<unknown>;
  /** Called after each daemon `welcome`. Use it to reconcile and send `groups`. */
  onWelcome(welcome: V2Welcome): Promise<void> | void;
  /** Create the offscreen document if it is missing. */
  ensureOffscreen(): Promise<void>;
  /** The offscreen socket status changed (e.g. to "unauthorized"). */
  onStatus?(status: BridgeStatus): void;
}

export class BridgeRelay {
  private port: PortLike | null = null;
  private _status: BridgeStatus = "offline";

  constructor(private readonly deps: RelayDeps) {}

  get status(): BridgeStatus {
    return this._status;
  }

  get isReady(): boolean {
    return this.port !== null && this._status === "connected";
  }

  /** A `v2-bridge` port opened by the offscreen document. Replaces any previous one. */
  attach(port: PortLike): void {
    const previous = this.port;
    this.port = port;
    if (previous) {
      try {
        previous.disconnect();
      } catch {
        // ignore
      }
    }
    port.onMessage.addListener((message) => {
      if (this.port === port) this.handle(message as ToServiceWorker);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this._status = "offline";
      // The document may be closing or gone: recreate it (once now, once after it has settled).
      void this.ensure();
      setTimeout(() => void this.ensure(), RECHECK_OFFSCREEN_MS);
    });
    void this.pushConfig(false);
  }

  /** Startup / alarm hook: make sure the offscreen document exists and its socket is trying. */
  async ensure(): Promise<void> {
    try {
      await this.deps.ensureOffscreen();
    } catch (err) {
      console.warn("[v2 relay] offscreen document unavailable:", err);
      return;
    }
    this.post({ type: "ensure" });
  }

  /** Send the current token/port to the offscreen document. `reconfigure` forces a reconnect. */
  async pushConfig(reconfigure: boolean): Promise<void> {
    const config = await this.deps.loadConfig();
    this.post({ type: "config", token: config.token, port: config.port, reconfigure });
  }

  /** Send an unsolicited event. Dropped (returns false) if not connected; the daemon resyncs via `groups`. */
  sendEvent(event: V2Event): boolean {
    if (!this.isReady) return false;
    return this.post({ type: "frame", frame: event });
  }

  private handle(message: ToServiceWorker): void {
    switch (message?.type) {
      case "status":
        if (this._status !== message.status) {
          this._status = message.status;
          this.deps.onStatus?.(message.status);
        }
        break;
      case "welcome":
        void Promise.resolve()
          .then(() => this.deps.onWelcome(message.welcome))
          .catch((err) => console.warn("[v2 relay] welcome handling failed:", err));
        break;
      case "request":
        void this.dispatch(message.request);
        break;
      case "keepalive":
        break;
      default:
        console.warn("[v2 relay] unknown port message:", (message as { type?: unknown })?.type);
    }
  }

  private async dispatch(req: V2Request): Promise<void> {
    if (typeof req?.id !== "string") return;
    let response: V2Response;
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
        response = { type: "response", id: req.id, ok: true, result } as V2Response;
      } catch (err) {
        response = { type: "response", id: req.id, ok: false, error: toWireError(err) };
      }
    }
    this.post({ type: "frame", frame: response });
  }

  private post(message: ToOffscreen): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(message);
      return true;
    } catch (err) {
      console.warn("[v2 relay] post failed:", err);
      return false;
    }
  }
}
