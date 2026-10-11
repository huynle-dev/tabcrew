import type { V2Op, V2Request } from "@chromeuse/shared/v2";
import type { CdpManager } from "./cdp.js";
import { OpError } from "./errors.js";
import type { PageController } from "./snapshot/controller.js";
import { requireTabId, type TabManager } from "./tabs.js";

const NOT_YET: ReadonlySet<string> = new Set<V2Op>(["navigate", "read_text", "debug_logs"]);

export interface OpDeps {
  tabs: TabManager;
  cdp: CdpManager;
  page: PageController;
}

/** Route one daemon request to its handler. Throws OpError for typed failures. */
export async function handleRequest(req: V2Request, deps: OpDeps): Promise<unknown> {
  const args = (req.args ?? {}) as Record<string, unknown>;
  const session = req.session;
  switch (req.op) {
    case "tab_create": {
      const info = await deps.tabs.tabCreate(session, args);
      // Attach now (focus emulation keeps the background tab rendering) so the first
      // screenshot/snapshot does not pay for attaching and waking a hidden renderer.
      deps.cdp.ensureAttached(info.tab_id).catch(() => undefined);
      return info;
    }
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
    case "snapshot": {
      const tabId = requireTabId(args);
      await deps.tabs.assertOwned(session, tabId);
      return deps.page.snapshot(tabId);
    }
    case "act": {
      const tabId = requireTabId(args);
      await deps.tabs.assertOwned(session, tabId);
      return deps.page.act(tabId, args);
    }
    default:
      if (NOT_YET.has(req.op)) throw new OpError("internal", "not implemented in this phase");
      throw new OpError("invalid_args", `unknown op: ${String(req.op)}`);
  }
}
