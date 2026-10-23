import type { BrowserGroup, BrowserWindow } from './capture';
import type { Badge } from './status';

/** The browser operations the sync engine needs. */
export interface BrowserApi {
  getWindows(): Promise<BrowserWindow[]>;
  getGroups(): Promise<BrowserGroup[]>;
  setBadge(badge: Badge): Promise<void>;
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
};
