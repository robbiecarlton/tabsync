import type { BrowserGroup, BrowserWindow } from './capture';
import type { Badge } from './status';
import type { GroupColor, WindowState } from '@tabsync/shared';

/** The browser operations the sync engine needs. */
export interface BrowserApi {
  getWindows(): Promise<BrowserWindow[]>;
  getGroups(): Promise<BrowserGroup[]>;
  setBadge(badge: Badge): Promise<void>;

  /** Opens a window with one tab (`url` undefined = New Tab page). */
  createWindow(opts: {
    url?: string;
    focused: boolean;
    state?: WindowState;
  }): Promise<{ windowId: number; tabId: number }>;
  createTab(opts: {
    windowId: number;
    url?: string;
    pinned: boolean;
    active: boolean;
  }): Promise<number>;
  moveTab(tabId: number, windowId: number, index: number): Promise<void>;
  updateTab(tabId: number, props: { pinned?: boolean; active?: boolean }): Promise<void>;
  /** Groups the tabs (in this order) into a new group in `windowId`; returns the group ID. */
  groupTabs(tabIds: number[], windowId: number): Promise<number>;
  ungroupTabs(tabIds: number[]): Promise<void>;
  updateGroup(
    groupId: number,
    props: { title?: string; color?: GroupColor; collapsed?: boolean },
  ): Promise<void>;
  /** Unloads a tab to save memory. Best effort. */
  discardTab(tabId: number): Promise<void>;
  removeTabs(tabIds: number[]): Promise<void>;
  removeWindow(windowId: number): Promise<void>;
}

const DISCARD_WAIT_MS = 5_000;

/**
 * Discarding a tab before its navigation commits can leave it blank, so wait until the tab
 * reports a URL (or give up after a few seconds and leave it loaded).
 */
async function discardWhenCommitted(tabId: number): Promise<void> {
  const deadline = Date.now() + DISCARD_WAIT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.active) return;
    if (tab.url && tab.url !== 'about:blank') {
      await chrome.tabs.discard(tabId).catch(() => undefined);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export const chromeBrowser: BrowserApi = {
  getWindows: () =>
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }) as Promise<BrowserWindow[]>,
  getGroups: () => chrome.tabGroups.query({}) as Promise<BrowserGroup[]>,
  async setBadge({ text, color, title }) {
    await Promise.all([
      chrome.action.setBadgeText({ text }),
      chrome.action.setBadgeBackgroundColor({ color }),
      chrome.action.setBadgeTextColor?.({ color: '#ffffff' }),
      chrome.action.setTitle({ title }),
    ]);
  },
  async createWindow({ url, focused, state }) {
    const w = await chrome.windows.create({
      url,
      focused,
      ...(state === 'maximized' || state === 'fullscreen' ? { state } : {}),
    });
    return { windowId: w!.id!, tabId: w!.tabs![0]!.id! };
  },
  async createTab({ windowId, url, pinned, active }) {
    return (await chrome.tabs.create({ windowId, url, pinned, active })).id!;
  },
  async moveTab(tabId, windowId, index) {
    await chrome.tabs.move(tabId, { windowId, index });
  },
  async updateTab(tabId, props) {
    await chrome.tabs.update(tabId, props);
  },
  groupTabs: (tabIds, windowId) =>
    chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], createProperties: { windowId } }),
  async ungroupTabs(tabIds) {
    if (tabIds.length) await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
  },
  async updateGroup(groupId, props) {
    await chrome.tabGroups.update(groupId, props);
  },
  discardTab: (tabId) => discardWhenCommitted(tabId),
  async removeTabs(tabIds) {
    if (tabIds.length) await chrome.tabs.remove(tabIds);
  },
  async removeWindow(windowId) {
    await chrome.windows.remove(windowId);
  },
};
