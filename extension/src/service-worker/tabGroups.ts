/**
 * TabGroupManager - manages "OpenCode" tab groups with rotating colors.
 *
 * Each session gets its own tab group. Colors rotate through Chrome's
 * available tab group colors so concurrent sessions are visually distinct.
 */

/** Chrome tab group colors in rotation order */
const GROUP_COLORS: chrome.tabGroups.ColorEnum[] = [
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

const OPENCODE_GROUP_TITLE = 'OpenCode';
const TAB_GROUP_ID_NONE = -1;

export type TabOwnershipErrorCode =
  | 'NO_TRACKED_GROUP'
  | 'TRACKED_GROUP_REMOVED'
  | 'TRACKED_GROUP_RENAMED'
  | 'TAB_NOT_FOUND'
  | 'TAB_UNGROUPED'
  | 'TAB_IN_DIFFERENT_GROUP';

export type TabOwnershipResult =
  | {
      readonly ok: true;
      readonly tabId: number;
      readonly groupId: number;
    }
  | {
      readonly ok: false;
      readonly code: TabOwnershipErrorCode;
      readonly message: string;
      readonly tabId: number;
      readonly sessionScope: string;
      readonly groupId?: number;
      readonly actualGroupId?: number;
      readonly actualTitle?: string;
    };

export class TabGroupManager {
  /** Maps session scope to tab group ID */
  private sessionGroups = new Map<string, number>();

  /** Index into GROUP_COLORS for next group created */
  private colorIndex = 0;

  /**
   * Add a tab to the OpenCode group for the given session.
   * Creates the group if it doesn't exist yet.
   *
   * @param tabId - The Chrome tab ID to add
   * @param sessionScope - Session identifier (groups tabs by session)
   * @returns The tab group ID
   */
  async addTabToGroup(tabId: number, sessionScope?: string): Promise<number> {
    const key = sessionScope ?? 'default';

    // Check if we already have a group for this session
    const existingGroupId = this.sessionGroups.get(key);
    if (existingGroupId !== undefined) {
      // Verify the group still exists (user may have ungrouped tabs)
      try {
        await chrome.tabGroups.get(existingGroupId);
        // Group exists - add tab to it
        await chrome.tabs.group({ tabIds: tabId, groupId: existingGroupId });
        return existingGroupId;
      } catch {
        // Group was removed - clean up and create a new one
        this.sessionGroups.delete(key);
      }
    }

    // Create a new group with this tab
    const groupId = await chrome.tabs.group({ tabIds: tabId });

    // Style the group
    const color = GROUP_COLORS[this.colorIndex % GROUP_COLORS.length];
    this.colorIndex++;

    await chrome.tabGroups.update(groupId, {
      title: OPENCODE_GROUP_TITLE,
      color,
      collapsed: false,
    });

    this.sessionGroups.set(key, groupId);
    return groupId;
  }

  /**
   * Get the group ID for a session, if one exists.
   */
  getGroupId(sessionScope?: string): number | undefined {
    return this.sessionGroups.get(sessionScope ?? 'default');
  }

  /**
   * Remove a session's group tracking (does not delete the Chrome group).
   */
  removeSession(sessionScope?: string): void {
    this.sessionGroups.delete(sessionScope ?? 'default');
  }

  /**
   * Validate that a tab is still owned by this session's tracked OpenCode group.
   *
   * This intentionally fails closed: if the tracked group was removed, renamed,
   * or the tab moved/ungrouped, callers get a structured failure instead of
   * silently trusting a stale tab ID.
   */
  async validateOwnedTab(
    tabId: number,
    sessionScope?: string,
  ): Promise<TabOwnershipResult> {
    const key = sessionScope ?? 'default';
    const groupId = this.sessionGroups.get(key);

    if (groupId === undefined) {
      return {
        ok: false,
        code: 'NO_TRACKED_GROUP',
        message: `No OpenCode tab group is tracked for session "${key}". Discover or open a GLKVM tab for this session first.`,
        tabId,
        sessionScope: key,
      };
    }

    let group: chrome.tabGroups.TabGroup;
    try {
      group = await chrome.tabGroups.get(groupId);
    } catch {
      return {
        ok: false,
        code: 'TRACKED_GROUP_REMOVED',
        message: `The tracked OpenCode tab group no longer exists for session "${key}". It may have been manually removed or ungrouped.`,
        tabId,
        sessionScope: key,
        groupId,
      };
    }

    if (group.title !== OPENCODE_GROUP_TITLE) {
      return {
        ok: false,
        code: 'TRACKED_GROUP_RENAMED',
        message: `The tracked OpenCode tab group for session "${key}" was renamed to "${group.title ?? ''}". Rename it back to "${OPENCODE_GROUP_TITLE}" or rediscover the tab before sending GLKVM input.`,
        tabId,
        sessionScope: key,
        groupId,
        actualTitle: group.title ?? '',
      };
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return {
        ok: false,
        code: 'TAB_NOT_FOUND',
        message: `Tab ${tabId} was not found. The tab may have been closed.`,
        tabId,
        sessionScope: key,
        groupId,
      };
    }

    const actualGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
    if (actualGroupId === TAB_GROUP_ID_NONE) {
      return {
        ok: false,
        code: 'TAB_UNGROUPED',
        message: `Tab ${tabId} is not in any tab group. It is not owned by the OpenCode group for session "${key}".`,
        tabId,
        sessionScope: key,
        groupId,
        actualGroupId,
      };
    }

    if (actualGroupId !== groupId) {
      return {
        ok: false,
        code: 'TAB_IN_DIFFERENT_GROUP',
        message: `Tab ${tabId} is in a different tab group (${actualGroupId}) than the tracked OpenCode group (${groupId}) for session "${key}".`,
        tabId,
        sessionScope: key,
        groupId,
        actualGroupId,
      };
    }

    return { ok: true, tabId, groupId };
  }
}

/** Singleton instance */
export const tabGroupManager = new TabGroupManager();
