import type { V2Request } from "@chromeuse/shared/v2";
import type { CdpManager } from "./cdp.js";
import { OpError } from "./errors.js";
import { navigateTab, readText } from "./navigate.js";
import type { PageController } from "./snapshot/controller.js";
import { requireTabId, type TabManager } from "./tabs.js";

export interface OpDeps {
  tabs: TabManager;
  cdp: CdpManager;
  page: PageController;
  /** Test hook: how long navigate waits for the load event. */
  navigateWaitMs?: number;
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
      await deps.tabs.prepareForPage(session, tabId);
      return deps.cdp.screenshot(tabId, args);
    }
    case "snapshot": {
      const tabId = requireTabId(args);
      await deps.tabs.prepareForPage(session, tabId);
      return deps.page.snapshot(tabId);
    }
    case "act": {
      const tabId = requireTabId(args);
      await deps.tabs.prepareForPage(session, tabId);
      return deps.page.act(tabId, args);
    }
    case "navigate": {
      const tabId = requireTabId(args);
      await deps.tabs.prepareForPage(session, tabId);
      return navigateTab(
        {
          cdp: deps.cdp,
          forgetSnapshot: (id) => deps.page.forget(id),
          getTab: (id) => chrome.tabs.get(id),
          ...(deps.navigateWaitMs !== undefined && { waitMs: deps.navigateWaitMs }),
        },
        tabId,
        args,
      );
    }
    case "read_text": {
      const tabId = requireTabId(args);
      await deps.tabs.prepareForPage(session, tabId);
      return readText((id, method, params) => deps.cdp.send(id, method, params), tabId, args, deps.page.sleep);
    }
    case "debug_logs": {
      const tabId = requireTabId(args);
      // Reading buffers does not drive the page, so the tab is not activated.
      await deps.tabs.assertOwned(session, tabId);
      const result = deps.cdp.logs.query(tabId, args);
      // Attaching (lazily) starts capture for a tab that has not been attached yet.
      if (!deps.cdp.isAttached(tabId)) deps.cdp.ensureAttached(tabId).catch(() => undefined);
      return result;
    }
    default:
      throw new OpError("invalid_args", `unknown op: ${String(req.op)}`);
  }
}
