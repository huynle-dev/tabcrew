import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Request } from "@chromeuse/shared/v2";
import { Bridge, type BridgeDeps } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { OpError } from "./errors.js";
import { FakeSocket, flush } from "./test/fakes.js";

const session = { short_id: "abcd1234", label: "agent" };

function makeBridge(config: { current: BridgeConfig }, overrides: Partial<BridgeDeps> = {}) {
  const deps: BridgeDeps = {
    loadConfig: async () => config.current,
    createSocket: (url) => new FakeSocket(url),
    extensionVersion: "0.3.0",
    handleRequest: vi.fn(async () => ({ ok: 1 })),
    onWelcome: vi.fn(),
    ...overrides,
  };
  return { bridge: new Bridge(deps), deps };
}

function request(id: string, op: V2Request["op"] = "tab_list", args: object = {}): V2Request {
  return { type: "request", id, op, session, args } as V2Request;
}

async function connected(bridge: Bridge): Promise<FakeSocket> {
  await bridge.start();
  const ws = FakeSocket.instances.at(-1)!;
  ws.serverOpen();
  ws.serverSend({ type: "welcome", protocol: 2, sessions: [] });
  await flush();
  return ws;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Bridge", () => {
  it("sends hello with the token as the first frame", async () => {
    const { bridge } = makeBridge({ current: { token: "secret-token", port: 8771 } });
    await bridge.start();
    const ws = FakeSocket.instances[0]!;
    expect(ws.url).toBe("ws://127.0.0.1:8771");
    expect(bridge.status).toBe("connecting");
    ws.serverOpen();
    expect(ws.frames()[0]).toEqual({ type: "hello", protocol: 2, token: "secret-token", extension_version: "0.3.0" });
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    expect(bridge.status).toBe("connected");
  });

  it("uses the configured port", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 9999 } });
    await bridge.start();
    expect(FakeSocket.instances[0]!.url).toBe("ws://127.0.0.1:9999");
  });

  it("does not connect without a token", async () => {
    const { bridge } = makeBridge({ current: { token: null, port: 8771 } });
    await bridge.start();
    await bridge.ensureConnected();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(bridge.status).toBe("needs_token");
  });

  it("stops retrying after 4401 until the token changes", async () => {
    const config = { current: { token: "wrong", port: 8771 } as BridgeConfig };
    const { bridge } = makeBridge(config);
    await bridge.start();
    FakeSocket.instances[0]!.serverOpen();
    FakeSocket.instances[0]!.serverClose(4401);
    expect(bridge.status).toBe("unauthorized");

    await vi.advanceTimersByTimeAsync(120_000);
    await bridge.ensureConnected(); // the keepalive alarm
    expect(FakeSocket.instances).toHaveLength(1);
    expect(bridge.status).toBe("unauthorized");

    config.current = { token: "right", port: 8771 };
    await bridge.reconfigure();
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverOpen();
    expect(FakeSocket.instances[1]!.frames()[0]).toMatchObject({ type: "hello", token: "right" });
  });

  it("reconnects with capped exponential backoff after a normal close", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } });
    await bridge.start();
    FakeSocket.instances[0]!.serverClose(1006);
    expect(bridge.status).toBe("offline");
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    // second failure waits 2 s
    FakeSocket.instances[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);
    // many failures: never more than 30 s
    for (let i = 0; i < 10; i++) {
      FakeSocket.instances.at(-1)!.serverClose(1006);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(FakeSocket.instances).toHaveLength(13);
  });

  it("replies pong to ping", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } });
    const ws = await connected(bridge);
    ws.serverSend({ type: "ping", t: 42 });
    expect(ws.frames().at(-1)).toEqual({ type: "pong", t: 42 });
  });

  it("calls onWelcome after welcome", async () => {
    const { bridge, deps } = makeBridge({ current: { token: "t", port: 8771 } });
    await connected(bridge);
    expect(deps.onWelcome).toHaveBeenCalledWith({ type: "welcome", protocol: 2, sessions: [] });
  });

  it("handles requests concurrently and answers each by id", async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    const started: string[] = [];
    const { bridge } = makeBridge(
      { current: { token: "t", port: 8771 } },
      {
        handleRequest: (req) =>
          new Promise((resolve) => {
            started.push(req.id);
            resolvers[req.id] = resolve;
          }),
      },
    );
    const ws = await connected(bridge);
    ws.serverSend(request("r1"));
    ws.serverSend(request("r2"));
    await flush();
    expect(started).toEqual(["r1", "r2"]); // both in flight before either finished

    resolvers.r2!({ tabs: [] });
    await flush();
    resolvers.r1!({ tabs: [1] });
    await flush();
    const responses = ws.frames().filter((f) => f.type === "response");
    expect(responses).toEqual([
      { type: "response", id: "r2", ok: true, result: { tabs: [] } },
      { type: "response", id: "r1", ok: true, result: { tabs: [1] } },
    ]);
  });

  it("maps thrown errors to typed error responses without stacks", async () => {
    const { bridge } = makeBridge(
      { current: { token: "t", port: 8771 } },
      {
        handleRequest: async (req) => {
          if (req.id === "a") throw new OpError("tab_not_owned", "tab 5 is not in this session's tab group");
          throw new Error("boom\n    at stack line");
        },
      },
    );
    const ws = await connected(bridge);
    ws.serverSend(request("a"));
    ws.serverSend(request("b"));
    await flush();
    const responses = ws.frames().filter((f) => f.type === "response");
    expect(responses).toContainEqual({
      type: "response",
      id: "a",
      ok: false,
      error: { code: "tab_not_owned", message: "tab 5 is not in this session's tab group" },
    });
    expect(responses).toContainEqual({ type: "response", id: "b", ok: false, error: { code: "internal", message: "boom" } });
  });

  it("drops events when not connected", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } });
    await bridge.start();
    FakeSocket.instances[0]!.serverOpen();
    expect(bridge.sendEvent({ type: "event", event: "stop", short_id: null })).toBe(false); // before welcome
    FakeSocket.instances[0]!.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    expect(bridge.sendEvent({ type: "event", event: "stop", short_id: null })).toBe(true);
  });
});
