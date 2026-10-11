import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PopupState } from "./config.js";
import { OFFSCREEN_PATH } from "./offscreen-client.js";
import { createFakeChrome, flush, type FakeChrome, type FakePort } from "./test/fakes.js";

const DOC = `chrome-extension://fake/${OFFSCREEN_PATH}`;
const session = { short_id: "abcd1234", label: "agent" };

let fake: FakeChrome;

/** Load a fresh service worker against the fake browser. */
async function boot(): Promise<void> {
  vi.resetModules();
  await import("./service-worker.js");
  await settle();
}

/** Let port messages and the fake getContexts/createDocument round trips finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** What the offscreen document does on load: open the v2-bridge port. */
function offscreenConnects(): FakePort {
  return fake.chrome.runtime.connect({ name: "v2-bridge" });
}

function popupState(): Promise<PopupState> {
  return new Promise((resolve) => {
    fake.chrome.runtime.onMessage.fire({ type: "v2:get_state" }, {}, (state) => resolve(state as PopupState));
  });
}

beforeEach(async () => {
  fake = createFakeChrome();
  fake.install();
  await fake.chrome.storage.local.set({ "v2:token": "secret-token" });
});

describe("service worker bridge wiring", () => {
  it("creates the offscreen document once on startup, even with concurrent startup events", async () => {
    vi.resetModules();
    await import("./service-worker.js");
    fake.chrome.runtime.onStartup.fire();
    fake.chrome.runtime.onInstalled.fire({ reason: "install" });
    await settle();
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect([...fake.offscreenDocs]).toEqual([DOC]);
  });

  it("sends the stored config to the offscreen document and forces a reconnect when it changes", async () => {
    await boot();
    const port = offscreenConnects();
    await settle();
    expect(port.messages()).toEqual([{ type: "config", token: "secret-token", port: 8771, reconfigure: false }]);

    await fake.chrome.storage.local.set({ "v2:token": "new-token" });
    fake.chrome.storage.onChanged.fire({ "v2:token": { newValue: "new-token" } }, "local");
    await settle();
    expect(port.messages().at(-1)).toEqual({ type: "config", token: "new-token", port: 8771, reconfigure: true });
  });

  it("reflects relayed status in the popup state", async () => {
    await boot();
    expect((await popupState()).status).toBe("offline");
    const port = offscreenConnects();
    port.postMessage({ type: "status", status: "connected" });
    await settle();
    expect(await popupState()).toMatchObject({ status: "connected", port: 8771, token_set: true });
    port.postMessage({ type: "status", status: "unauthorized" });
    await settle();
    expect((await popupState()).status).toBe("unauthorized");
  });

  it("handles forwarded requests and posts responses back over the port", async () => {
    await boot();
    const port = offscreenConnects();
    port.postMessage({ type: "status", status: "connected" });
    port.postMessage({ type: "request", request: { type: "request", id: "r1", op: "tab_list", session, args: {} } });
    port.postMessage({ type: "request", request: { type: "request", id: "r2", op: "tab_close", session, args: {} } });
    await settle();
    const responses = port
      .messages<{ type: string; frame: { id: string; ok: boolean } }>()
      .filter((m) => m.type === "frame")
      .map((m) => m.frame);
    expect(responses.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(responses.find((r) => r.id === "r1")).toMatchObject({ type: "response", ok: true });
    expect(responses.find((r) => r.id === "r2")).toMatchObject({ type: "response", ok: false });
  });

  it("reconciles and sends groups after a relayed welcome", async () => {
    await boot();
    const port = offscreenConnects();
    port.postMessage({ type: "status", status: "connected" });
    port.postMessage({ type: "welcome", welcome: { type: "welcome", protocol: 2, sessions: [] } });
    await settle();
    expect(port.messages().at(-1)).toEqual({ type: "frame", frame: { type: "event", event: "groups", groups: [] } });
  });

  it("recreates the offscreen document when its port disconnects and it is gone", async () => {
    await boot();
    const port = offscreenConnects();
    await settle();
    await fake.chrome.offscreen.closeDocument();
    port.disconnect();
    await settle();
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledTimes(2);
    expect(fake.offscreenDocs.size).toBe(1);
    expect((await popupState()).status).toBe("offline");
  });

  it("recreates a missing offscreen document from the keepalive alarm and nudges the socket", async () => {
    await boot();
    const port = offscreenConnects();
    await settle();
    fake.offscreenDocs.clear(); // closed without the port noticing yet
    fake.chrome.alarms.onAlarm.fire({ name: "v2-bridge-keepalive" });
    await settle();
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledTimes(2);
    expect(port.messages().at(-1)).toEqual({ type: "ensure" });
  });

  it("ignores ports with other names", async () => {
    await boot();
    const other = fake.chrome.runtime.connect({ name: "something-else" });
    await settle();
    expect(other.messages()).toEqual([]);
  });
});
