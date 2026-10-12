import { beforeEach, describe, expect, it } from "vitest";
import { OFFSCREEN_PATH, ensureOffscreenDocument } from "./offscreen-client.js";
import { createFakeChrome, type FakeChrome } from "./test/fakes.js";

let fake: FakeChrome;
beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
});

describe("ensureOffscreenDocument", () => {
  it("creates the document once under concurrent calls", async () => {
    await Promise.all([ensureOffscreenDocument(), ensureOffscreenDocument(), ensureOffscreenDocument()]);
    await ensureOffscreenDocument();
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledWith({
      url: OFFSCREEN_PATH,
      reasons: ["WORKERS"],
      justification: "Maintain the local WebSocket connection to the TabCrew daemon",
    });
    expect([...fake.offscreenDocs]).toEqual([`chrome-extension://fake/${OFFSCREEN_PATH}`]);
  });

  it("recreates the document after it is closed", async () => {
    await ensureOffscreenDocument();
    await fake.chrome.offscreen.closeDocument();
    await ensureOffscreenDocument();
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledTimes(2);
    expect(fake.offscreenDocs.size).toBe(1);
  });

  it("treats a duplicate-document rejection as success", async () => {
    fake.chrome.runtime.getContexts.mockResolvedValueOnce([]);
    fake.offscreenDocs.add(`chrome-extension://fake/${OFFSCREEN_PATH}`);
    await expect(ensureOffscreenDocument()).resolves.toBeUndefined();
  });
});
