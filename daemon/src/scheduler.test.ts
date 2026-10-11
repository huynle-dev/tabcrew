import { describe, expect, it } from "vitest";
import { DaemonError } from "./errors.js";
import { Scheduler } from "./scheduler.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Scheduler", () => {
  it("runs jobs for one tab strictly in FIFO order, one at a time", async () => {
    const s = new Scheduler();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const jobs = Array.from({ length: 6 }, (_, i) =>
      s.runTab(1, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start ${i}`);
        await new Promise((r) => setTimeout(r, (6 - i) * 2));
        log.push(`end ${i}`);
        running -= 1;
        return i;
      }),
    );
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxRunning).toBe(1);
    expect(log).toEqual(Array.from({ length: 6 }, (_, i) => [`start ${i}`, `end ${i}`]).flat());
    expect(s.pending()).toEqual({ tabs: 0, sessions: 0 });
  });

  it("runs different tabs concurrently", async () => {
    const s = new Scheduler();
    const slow = deferred();
    const order: string[] = [];
    const a1 = s.runTab(1, async () => {
      await slow.promise;
      order.push("tab1 first");
    });
    const a2 = s.runTab(1, async () => {
      order.push("tab1 second");
    });
    const b = s.runTab(2, async () => {
      order.push("tab2");
      return "b";
    });
    expect(await b).toBe("b");
    expect(order).toEqual(["tab2"]);
    slow.resolve();
    await Promise.all([a1, a2]);
    expect(order).toEqual(["tab2", "tab1 first", "tab1 second"]);
  });

  it("keeps going after a failed job", async () => {
    const s = new Scheduler();
    const first = s.runTab(1, async () => {
      throw new Error("boom");
    });
    const second = s.runTab(1, async () => "ok");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
  });

  it("serialises session lanes independently of tab lanes", async () => {
    const s = new Scheduler();
    const hold = deferred();
    const order: string[] = [];
    const c1 = s.runSession("AAAAAAAA", async () => {
      await hold.promise;
      order.push("create 1");
    });
    const c2 = s.runSession("AAAAAAAA", async () => {
      order.push("create 2");
    });
    await s.runSession("BBBBBBBB", async () => order.push("other session"));
    await s.runTab(5, async () => order.push("tab op"));
    await tick();
    expect(order).toEqual(["other session", "tab op"]);
    hold.resolve();
    await Promise.all([c1, c2]);
    expect(order).toEqual(["other session", "tab op", "create 1", "create 2"]);
  });

  it("drops waiting jobs but lets the running one finish", async () => {
    const s = new Scheduler();
    const hold = deferred<string>();
    const running = s.runTab(1, () => hold.promise);
    const ran: number[] = [];
    const queued = [1, 2].map((n) => s.runTab(1, async () => void ran.push(n)));
    await tick();
    expect(s.dropTab(1, new DaemonError("tab_gone", "gone"))).toBe(2);
    for (const q of queued) await expect(q).rejects.toMatchObject({ code: "tab_gone" });
    hold.resolve("done");
    expect(await running).toBe("done");
    expect(ran).toEqual([]);
    // A later job on the same tab still runs after the drop.
    expect(await s.runTab(1, async () => "later")).toBe("later");
    expect(s.pending()).toEqual({ tabs: 0, sessions: 0 });
  });
});
