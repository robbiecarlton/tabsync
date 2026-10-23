import {
  isNewTabUrl,
  normalizeUrlForMatching,
  type SnapGroup,
  type SnapTab,
} from '@tabsync/shared';
import type { BrowserApi } from './browser';

type Opener = Pick<BrowserApi, 'createTab' | 'groupTabs' | 'updateGroup'>;
type Focuser = Opener & Pick<BrowserApi, 'getWindows' | 'focusTab'>;

/** Opens one snapshot tab in `windowId`, focused unless `active` is false (e.g. cmd/ctrl-click). */
export async function openTab(
  browser: Opener,
  windowId: number,
  tab: SnapTab,
  { active = true }: { active?: boolean } = {},
): Promise<number> {
  return browser.createTab({
    windowId,
    url: isNewTabUrl(tab.url) ? undefined : tab.url,
    pinned: false,
    active,
  });
}

/**
 * Focuses the tab if it's already open in a normal window, otherwise opens it (focused) in
 * `windowId`. An exact URL beats one that differs only by fragment or tracking parameters, and
 * the current window wins ties. New Tab placeholders always open a new tab.
 */
export async function openOrFocusTab(
  browser: Focuser,
  windowId: number,
  tab: SnapTab,
): Promise<'focused' | 'opened'> {
  if (!isNewTabUrl(tab.url)) {
    const normalized = normalizeUrlForMatching(tab.url);
    const candidates = (await browser.getWindows())
      .filter((w) => !w.incognito && (w.type === undefined || w.type === 'normal'))
      .sort((a, b) => Number(b.id === windowId) - Number(a.id === windowId))
      .flatMap((w) => w.tabs ?? [])
      .filter((t) => t.id !== undefined);
    const url = (t: { url?: string; pendingUrl?: string }) => t.url || t.pendingUrl || '';
    const match =
      candidates.find((t) => url(t) === tab.url) ??
      candidates.find((t) => normalizeUrlForMatching(url(t)) === normalized);
    if (match) {
      await browser.focusTab(match.id!);
      return 'focused';
    }
  }
  await openTab(browser, windowId, tab);
  return 'opened';
}

/**
 * Reopens a snapshot group in `windowId` as a real tab group with the same title and colour
 * (expanded, with its first tab focused). Tabs the browser refuses to open are skipped.
 * Returns the new group's ID, or undefined if no tab could be opened.
 */
export async function openGroup(
  browser: Opener,
  windowId: number,
  group: SnapGroup,
  tabs: SnapTab[],
): Promise<number | undefined> {
  const ids: number[] = [];
  for (const [i, tab] of tabs.entries()) {
    try {
      ids.push(
        await browser.createTab({
          windowId,
          url: isNewTabUrl(tab.url) ? undefined : tab.url,
          pinned: false,
          active: i === 0,
        }),
      );
    } catch {
      // Skip a URL the browser won't open; keep the rest of the group.
    }
  }
  if (ids.length === 0) return undefined;
  const groupId = await browser.groupTabs(ids, windowId);
  await browser.updateGroup(groupId, { title: group.title, color: group.color, collapsed: false });
  return groupId;
}
