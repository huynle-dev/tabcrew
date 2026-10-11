import type { V2Op, V2Request } from "@chromeuse/shared/v2";
import type { CdpManager } from "./cdp.js";
import { OpError } from "./errors.js";
import { requireTabId, type TabManager } from "./tabs.js";

const NOT_YET: ReadonlySet<string> = new Set<V2Op>(["snapshot", "act", "navigate", "read_text", "debug_logs"]);

export interface OpDeps {
  tabs: TabManager;
  cdp: CdpManager;
}

/** Route one daemon request to its handler. Throws OpError for typed failures. */
export async function handleRequest(req: V2Request, deps: OpDeps): Promise<unknown> {
  const args = (req.args ?? {}) as Record<string, unknown>;
  const session = req.session;
  switch (req.op) {
    case "tab_create":
      return deps.tabs.tabCreate(session, args);
    case "tab_list":
      return deps.tabs.tabList(session);
    case "tab_close":
      return deps.tabs.tabClose(session, args);
    case "session_close":
      return deps.tabs.sessionClose(session);
    case "screenshot": {
      const tabId = requireTabId(args);
      await deps.tabs.assertOwned(session, tabId);
      return deps.cdp.screenshot(tabId, args);
    }
    default:
      if (NOT_YET.has(req.op)) throw new OpError("internal", "not implemented in this phase");
      throw new OpError("invalid_args", `unknown op: ${String(req.op)}`);
  }
}
