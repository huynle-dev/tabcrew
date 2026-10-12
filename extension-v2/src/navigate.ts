/**
 * navigate and read_text for one owned, activated tab, over the tab's own debugger session.
 */

import type { V2TabInfo } from "@chromeuse/shared/v2";
import type { CdpManager } from "./cdp.js";
import { OpError } from "./errors.js";
import { evaluate } from "./snapshot/controller.js";
import { toTabInfo } from "./tabs.js";

export const NAVIGATE_WAIT_MS = 15_000;
export const DEFAULT_READ_TEXT = 20_000;
export const MAX_READ_TEXT = 100_000;
const READ_ATTEMPTS = 5;
const READ_RETRY_MS = 50;

type NavAction = "url" | "back" | "forward" | "reload";
const ACTIONS: ReadonlySet<string> = new Set<NavAction>(["url", "back", "forward", "reload"]);

export interface NavigateDeps {
  cdp: Pick<CdpManager, "send" | "ensureAttached" | "waitForEvent">;
  /** Drop the tab's snapshot cache (node handles die with the document). */
  forgetSnapshot: (tabId: number) => void;
  getTab: (tabId: number) => Promise<chrome.tabs.Tab>;
  waitMs?: number;
}

export interface NavigateArgs {
  url?: unknown;
  action?: unknown;
}

export function parseNavigate(args: NavigateArgs): { action: NavAction; url?: string } {
  if (args.action !== undefined && (typeof args.action !== "string" || !ACTIONS.has(args.action))) {
    throw new OpError("invalid_args", "action must be url, back, forward or reload");
  }
  const action = (args.action as NavAction | undefined) ?? (args.url !== undefined ? "url" : undefined);
  if (!action) throw new OpError("invalid_args", "give a url or an action (back, forward, reload)");
  if (action !== "url") {
    if (args.url !== undefined) throw new OpError("invalid_args", `url is not allowed with action ${action}`);
    return { action };
  }
  if (typeof args.url !== "string" || !args.url) throw new OpError("invalid_args", "url is required for action url");
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    throw new OpError("invalid_args", "url must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OpError("invalid_args", "only http: and https: URLs can be opened");
  }
  return { action, url: parsed.href };
}

interface HistoryResponse {
  currentIndex?: number;
  entries?: { id?: number; url?: string }[];
}

const isMainLoad = (method: string) => method === "Page.loadEventFired";

/**
 * Navigate and wait for the main frame's load event (at most `waitMs`; a timeout returns the
 * current state instead of failing). Errors after the command was sent are `outcome_unknown`.
 */
export async function navigateTab(deps: NavigateDeps, tabId: number, args: NavigateArgs): Promise<V2TabInfo> {
  const { action, url } = parseNavigate(args);
  const { cdp } = deps;
  const waitMs = deps.waitMs ?? NAVIGATE_WAIT_MS;
  await cdp.ensureAttached(tabId);

  let command: string;
  let params: Record<string, unknown> | undefined;
  let match: (method: string, params: unknown) => boolean = isMainLoad;
  if (action === "back" || action === "forward") {
    const history = await cdp.send<HistoryResponse>(tabId, "Page.getNavigationHistory");
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const index = (typeof history?.currentIndex === "number" ? history.currentIndex : -1) + (action === "back" ? -1 : 1);
    const entry = index >= 0 ? entries[index] : undefined;
    if (!entry || typeof entry.id !== "number") {
      throw new OpError("target_invalid", `no ${action === "back" ? "previous" : "next"} page in this tab's history`);
    }
    // History may stay within the document (fragment / pushState): then no load event follows.
    const frameTree = await cdp.send<{ frameTree?: { frame?: { id?: string } } }>(tabId, "Page.getFrameTree").catch(() => null);
    const mainFrame = frameTree?.frameTree?.frame?.id;
    match = (method, p) =>
      isMainLoad(method) ||
      (method === "Page.navigatedWithinDocument" && mainFrame !== undefined && (p as { frameId?: string })?.frameId === mainFrame);
    command = "Page.navigateToHistoryEntry";
    params = { entryId: entry.id };
  } else if (action === "reload") {
    command = "Page.reload";
  } else {
    command = "Page.navigate";
    params = { url, transitionType: "typed" };
  }

  const wait = cdp.waitForEvent(tabId, match, waitMs);
  let response: { loaderId?: string; errorText?: string } | undefined;
  try {
    response = await cdp.send<{ loaderId?: string; errorText?: string }>(tabId, command, params);
  } catch (err) {
    wait.cancel();
    if (err instanceof OpError && err.code === "tab_gone") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpError("outcome_unknown", `navigation was sent but its result is unknown (${msg.split("\n")[0]!.slice(0, 120)}); check the tab`);
  } finally {
    deps.forgetSnapshot(tabId);
  }
  // Page.navigate without a loaderId stayed in the same document: no load event will follow.
  if (action === "url" && response && !response.loaderId) wait.cancel();
  await wait.done;
  deps.forgetSnapshot(tabId);

  let tab: chrome.tabs.Tab;
  try {
    tab = await deps.getTab(tabId);
  } catch {
    throw new OpError("tab_gone", `tab ${tabId} no longer exists`);
  }
  return toTabInfo(tab);
}

/** Whole-document text (not only the viewport). `innerText` never includes form field values. */
export const READ_TEXT_SOURCE = (max: number) =>
  `/*cu:read_text*/(() => {
  const root = document.body || document.documentElement;
  const text = root ? root.innerText || "" : "";
  return { text: text.slice(0, ${max}), url: location.href, title: document.title || "" };
})()`;

export interface ReadTextArgs {
  max_length?: unknown;
}

export async function readText(
  send: (tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  args: ReadTextArgs,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ text: string; url: string; title: string }> {
  let max = DEFAULT_READ_TEXT;
  if (args.max_length !== undefined) {
    if (typeof args.max_length !== "number" || !Number.isInteger(args.max_length) || args.max_length < 1) {
      throw new OpError("invalid_args", `max_length must be an integer from 1 to ${MAX_READ_TEXT}`);
    }
    max = Math.min(args.max_length, MAX_READ_TEXT);
  }
  let last = "the document is navigating";
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(READ_RETRY_MS);
    let result;
    try {
      result = await evaluate(send, tabId, READ_TEXT_SOURCE(max));
    } catch (err) {
      if (err instanceof OpError) throw err;
      last = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!result.ok) {
      last = result.reason;
      continue;
    }
    const v = result.value as { text?: unknown; url?: unknown; title?: unknown } | null;
    if (!v || typeof v.text !== "string") continue;
    return {
      text: v.text.slice(0, max),
      url: typeof v.url === "string" ? v.url : "",
      title: typeof v.title === "string" ? v.title : "",
    };
  }
  throw new OpError("stale_page", `could not read the page (${last.slice(0, 120)}); try again`);
}
