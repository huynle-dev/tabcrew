import type { DaemonError } from "./errors.js";

interface Job {
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
}

class Lane {
  readonly items: Job[] = [];
  running = false;
}

/**
 * FIFO lanes keyed by tab id (page ops) and by session short_id (tab creation, listing and
 * session close). Jobs in one lane run strictly in order; different lanes run concurrently.
 * There is deliberately no global queue.
 */
export class Scheduler {
  private readonly tabLanes = new Map<number, Lane>();
  private readonly sessionLanes = new Map<string, Lane>();

  /** Run `fn` after every earlier job for this tab has settled. */
  runTab<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    return enqueue(this.tabLanes, tabId, fn);
  }

  /** Run `fn` after every earlier session-level job for this session has settled. */
  runSession<T>(shortId: string, fn: () => Promise<T>): Promise<T> {
    return enqueue(this.sessionLanes, shortId, fn);
  }

  /** Reject every job still waiting for this tab. A job already running is left to finish. */
  dropTab(tabId: number, error: DaemonError): number {
    return drop(this.tabLanes, tabId, error);
  }

  dropSession(shortId: string, error: DaemonError): number {
    return drop(this.sessionLanes, shortId, error);
  }

  /** Jobs running or waiting, for diagnostics and tests. */
  pending(): { tabs: number; sessions: number } {
    const count = (lanes: Map<unknown, Lane>) =>
      [...lanes.values()].reduce((n, lane) => n + lane.items.length + (lane.running ? 1 : 0), 0);
    return { tabs: count(this.tabLanes), sessions: count(this.sessionLanes) };
  }
}

function enqueue<K, T>(lanes: Map<K, Lane>, key: K, fn: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key);
  if (!lane) {
    lane = new Lane();
    lanes.set(key, lane);
  }
  const promise = new Promise<T>((resolve, reject) => {
    lane!.items.push({ run: fn, resolve: resolve as (v: unknown) => void, reject });
  });
  if (!lane.running) void pump(lanes, key, lane);
  return promise;
}

async function pump<K>(lanes: Map<K, Lane>, key: K, lane: Lane): Promise<void> {
  lane.running = true;
  try {
    for (let job = lane.items.shift(); job; job = lane.items.shift()) {
      try {
        job.resolve(await job.run());
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    lane.running = false;
    if (lanes.get(key) === lane && lane.items.length === 0) lanes.delete(key);
  }
}

function drop<K>(lanes: Map<K, Lane>, key: K, error: DaemonError): number {
  const lane = lanes.get(key);
  if (!lane) return 0;
  const waiting = lane.items.splice(0);
  for (const job of waiting) job.reject(error);
  if (!lane.running) lanes.delete(key);
  return waiting.length;
}
