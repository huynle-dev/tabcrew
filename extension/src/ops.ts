import type { V2Request } from "@tabcrew/shared/v2";
import type { CdpManager } from "./cdp.js";
import { OpError } from "./errors.js";
import { navigateTab, readText } from "./navigate.js";
import type { PageController } from "./snapshot/controller.js";
import { requireTabId, type TabManager } from "./tabs.js";

export const BACKGROUND_SCREENSHOT_TIMEOUT =
  "tab is in the background; screenshots of background tabs may fail in 'My current window' mode";

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
    case "session_release":
      return deps.tabs.releaseSession(session, async (tabId) => {
        await deps.cdp.detach(tabId);
        deps.page.forget(tabId);
      });
    case "screenshot": {
      const tabId = requireTabId(args);
      const tab = await deps.tabs.prepareForPage(session, tabId);
      // A user_window tab is never activated, and Chrome may not paint a hidden tab.
      const background = !tab.active && (await deps.tabs.placementFor(session.short_id)) === "user_window";
      return deps.cdp.screenshot(tabId, args, background ? { timeoutMessage: BACKGROUND_SCREENSHOT_TIMEOUT } : {});
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
