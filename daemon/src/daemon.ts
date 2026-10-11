import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { V2Event } from "@chromeuse/shared/v2";
import { ExtensionBridge } from "./bridge.js";
import type { DaemonConfig } from "./config.js";
import { log } from "./log.js";
import { McpHttpServer } from "./mcp/httpServer.js";
import { sessionRef, SessionRegistry, type Session } from "./sessions.js";
import { ensureHome, ensureToken } from "./token.js";

export interface DaemonOverrides {
  /** How long requests wait for the extension to connect (default 10 s). */
  readonly offlineWaitMs?: number;
  readonly helloTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  /** Overrides `idle_timeout_minutes`. */
  readonly idleTimeoutMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface RunningDaemon {
  readonly mcpPort: number;
  readonly extensionPort: number;
  readonly token: string;
  readonly registry: SessionRegistry;
  readonly bridge: ExtensionBridge;
  /** Close idle sessions now (also runs on a timer). */
  sweepIdle(): Promise<void>;
  close(): Promise<void>;
}

export function daemonVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function startDaemon(config: DaemonConfig, overrides: DaemonOverrides = {}): Promise<RunningDaemon> {
  ensureHome(config.home);
  const token = ensureToken(config.home);
  const idleTimeoutMs = overrides.idleTimeoutMs ?? config.idleTimeoutMinutes * 60_000;

  const registry = new SessionRegistry({ file: join(config.home, "sessions.json"), idleTimeoutMs });
  registry.load();

  const onEvent = (event: V2Event): void => {
    switch (event.event) {
      case "groups":
        if (Array.isArray(event.groups)) registry.reconcile(event.groups);
        return;
      case "tab_adopted":
        if (event.tab && Number.isInteger(event.tab.tab_id)) registry.addTab(event.short_id, event.tab.tab_id);
        return;
      case "tab_removed":
        if (Number.isInteger(event.tab_id)) registry.removeTab(event.short_id, event.tab_id);
        return;
      case "stop":
        // Stop handling (stopped_by_user) arrives in phase 6.
        log.info(`extension: stop requested for ${event.short_id ?? "all sessions"}`);
        return;
    }
  };

  const bridge = new ExtensionBridge({
    token,
    port: config.extensionPort,
    offlineWaitMs: overrides.offlineWaitMs,
    helloTimeoutMs: overrides.helloTimeoutMs,
    pingIntervalMs: overrides.pingIntervalMs,
    defaultRequestTimeoutMs: overrides.requestTimeoutMs,
    sessions: () => registry.refs(),
    onEvent,
  });

  const version = daemonVersion();
  const mcp = new McpHttpServer({
    token,
    port: config.mcpPort,
    allowedOrigins: config.allowedOrigins,
    version,
    registry,
    bridge,
  });

  const extensionPort = await bridge.start();
  let mcpPort: number;
  try {
    mcpPort = await mcp.start();
  } catch (err) {
    await bridge.close();
    throw err;
  }

  const closeIdle = async (session: Session): Promise<void> => {
    const ref = sessionRef(session);
    registry.close(session);
    log.info(`session ${ref.short_id} closed after idle timeout`);
    if (!bridge.connected) return;
    try {
      await bridge.request(ref, "session_close", {});
    } catch (err) {
      log.warn(`session ${ref.short_id}: closing tabs failed (${(err as { code?: string }).code ?? "error"})`);
    }
  };
  const sweepIdle = async (): Promise<void> => {
    await Promise.all(registry.idleSessions().map(closeIdle));
  };

  let sweepTimer: NodeJS.Timeout | null = null;
  if (idleTimeoutMs > 0) {
    const every = overrides.sweepIntervalMs ?? Math.max(1_000, Math.min(60_000, Math.floor(idleTimeoutMs / 2)));
    sweepTimer = setInterval(() => void sweepIdle(), every);
    sweepTimer.unref();
  }

  log.info(
    `chromeuse-daemon ${version} listening: mcp http://127.0.0.1:${mcpPort}/mcp, extension ws://127.0.0.1:${extensionPort}, ${registry.size} session(s) restored`,
  );

  return {
    mcpPort,
    extensionPort,
    token,
    registry,
    bridge,
    sweepIdle,
    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      await mcp.close();
      await bridge.close();
      registry.save();
    },
  };
}
