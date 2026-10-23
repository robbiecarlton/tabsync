import {
  canonicalLayout,
  isExcludedUrl,
  isNewTabUrl,
  matchTabs,
  matchWindows,
  NEW_TAB_URL,
  type SnapWindow,
} from '@tabsync/shared';
import type { BrowserApi } from './browser';
import { captureLayout, type BrowserGroup, type BrowserWindow } from './capture';

export type ApplyMode = 'add-missing' | 'match-exactly';

/** A browser tab as the planner sees it: ID plus the URL used for matching. */
interface LiveTab {
  id: number;
  url: string;
  groupId: number;
  pinned: boolean;
  active: boolean;
}

interface LiveWindow {
  id: number;
  /** Syncable tabs only (internal pages are never touched); New Tab pages normalized. */
  tabs: LiveTab[];
}

export interface WindowPlan {
  target: SnapWindow;
  /** Existing window to reconcile, or undefined to create one. */
  windowId?: number;
  /** For each target tab: an existing tab to reuse, or undefined to create. */
  reuse: (number | undefined)[];
  /** Syncable tabs in the window with no counterpart in the target. */
  extras: number[];
}

export interface ApplyPlan {
  windows: WindowPlan[];
  /** Windows with syncable tabs that match no target window. */
  surplusWindowIds: number[];
}

function syncableUrl(url: string): string | null {
  if (isNewTabUrl(url)) return NEW_TAB_URL;
  return isExcludedUrl(url) ? null : url;
}

function toLive(windows: BrowserWindow[]): LiveWindow[] {
  return windows
    .filter(
      (w) => !w.incognito && (w.type === undefined || w.type === 'normal') && w.id !== undefined,
    )
    .map((w) => ({
      id: w.id!,
      tabs: [...(w.tabs ?? [])]
        .sort((a, b) => a.index - b.index)
        .flatMap((t) => {
          const url = syncableUrl(t.url || t.pendingUrl || '');
          return url === null || t.id === undefined
            ? []
            : [{ id: t.id, url, groupId: t.groupId, pinned: t.pinned, active: t.active }];
        }),
    }));
}

/** Only New Tab pages among its syncable tabs (a window of just internal pages is not blank). */
const isBlank = (w: LiveWindow) => w.tabs.length > 0 && w.tabs.every((t) => t.url === NEW_TAB_URL);

/**
 * Decides which existing windows and tabs each target window reuses. Windows pair by greatest
 * tab overlap; remaining target windows reuse blank windows (only New Tab pages) before new
 * ones are created. Tabs match as a multiset by URL within a window.
 */
export function planApply(windows: BrowserWindow[], target: SnapWindow[]): ApplyPlan {
  const live = toLive(windows);
  const { matches, unmatchedCurrent, unmatchedTarget } = matchWindows(live, target);
  const pairs = new Map(matches.map((m) => [m.target, m.current]));

  const blanks = unmatchedCurrent.filter((c) => isBlank(live[c]!));
  for (const t of unmatchedTarget) {
    const c = blanks.shift();
    if (c === undefined) break;
    pairs.set(t, c);
  }
  const used = new Set(pairs.values());

  return {
    windows: target.map((tw, t) => {
      const c = pairs.get(t);
      if (c === undefined) return { target: tw, reuse: tw.tabs.map(() => undefined), extras: [] };
      const lw = live[c]!;
      const tm = matchTabs(lw.tabs, tw.tabs);
      const byTarget = new Map(tm.matches.map((m) => [m.target, lw.tabs[m.current]!.id]));
      return {
        target: tw,
        windowId: lw.id,
        reuse: tw.tabs.map((_, i) => byTarget.get(i)),
        extras: tm.unmatchedCurrent.map((i) => lw.tabs[i]!.id),
      };
    }),
    surplusWindowIds: live
      .filter((w, i) => !used.has(i) && w.tabs.length > 0 && !isBlank(w))
      .map((w) => w.id),
  };
}

export interface ApplyOptions {
  mode: ApplyMode;
  /** "Match exactly" closes surplus windows only when the user agreed to it. */
  closeSurplusWindows?: boolean;
}

const urlToOpen = (url: string) => (isNewTabUrl(url) ? undefined : url);

/**
 * Makes the browser's windows match `target` (reconcile steps 2–6 in SPEC.md):
 * creates missing tabs unloaded, puts tabs in target order (pinned first), rebuilds groups,
 * and in "match exactly" mode closes unmatched tabs last. Internal pages are never closed.
 */
export async function applyLayout(
  browser: BrowserApi,
  target: SnapWindow[],
  options: ApplyOptions,
): Promise<void> {
  const [windows, groups] = await Promise.all([browser.getWindows(), browser.getGroups()]);
  const plan = planApply(windows, target);
  const toDiscard: number[] = [];

  for (const wp of plan.windows) {
    const existing = windows.find((w) => w.id === wp.windowId);
    if (existing && isAlreadyApplied(existing, groups, wp, options.mode)) continue;
    await applyWindow(browser, wp, existing, options.mode, toDiscard);
  }

  if (options.mode === 'match-exactly' && options.closeSurplusWindows) {
    for (const id of plan.surplusWindowIds) await browser.removeWindow(id);
  }
  for (const id of toDiscard) await browser.discardTab(id);
}

function isAlreadyApplied(
  window: BrowserWindow,
  groups: BrowserGroup[],
  wp: WindowPlan,
  mode: ApplyMode,
): boolean {
  if (
    wp.extras.length > 0 &&
    (mode === 'match-exactly' || wp.extras.length === window.tabs?.length)
  )
    return false;
  if (wp.reuse.some((id) => id === undefined)) return false;
  const [current] = captureLayout([window], groups);
  return !!current && canonicalLayout([current]) === canonicalLayout([wp.target]);
}

async function applyWindow(
  browser: BrowserApi,
  wp: WindowPlan,
  existing: BrowserWindow | undefined,
  mode: ApplyMode,
  toDiscard: number[],
): Promise<void> {
  const { target } = wp;
  const tabIds: number[] = [];
  let windowId: number;
  const created = new Set<number>();

  if (existing) {
    windowId = existing.id!;
    // Ungroup reused tabs first so moves can't drag them into, or split, old groups.
    const grouped = (existing.tabs ?? [])
      .filter((t) => t.groupId !== -1 && wp.reuse.includes(t.id))
      .map((t) => t.id!);
    await browser.ungroupTabs(grouped);
  } else {
    const first = target.tabs[0]!;
    const w = await browser.createWindow({
      url: urlToOpen(first.url),
      focused: false,
      state: target.state,
    });
    windowId = w.windowId;
    tabIds[0] = w.tabId;
    created.add(w.tabId);
    if (first.pinned) await browser.updateTab(w.tabId, { pinned: true });
  }

  const liveTabs = new Map((existing?.tabs ?? []).map((t) => [t.id, t]));
  for (const [i, tab] of target.tabs.entries()) {
    if (tabIds[i] !== undefined) continue;
    const reuse = wp.reuse[i];
    if (reuse !== undefined) {
      tabIds[i] = reuse;
      if (liveTabs.get(reuse)?.pinned !== tab.pinned)
        await browser.updateTab(reuse, { pinned: tab.pinned });
    } else {
      const id = await browser.createTab({
        windowId,
        url: urlToOpen(tab.url),
        pinned: tab.pinned,
        active: false,
      });
      tabIds[i] = id;
      created.add(id);
    }
  }

  // Target order (pinned tabs are first in a valid snapshot). Each tab lands right after the
  // previous target tab, which is ungrouped at this point, so it can't join a leftover group.
  for (const [i, id] of tabIds.entries()) await browser.moveTab(id, windowId, i);

  const groupIds: { id: number; collapsed: boolean }[] = [];
  for (const g of target.groups) {
    const members = target.tabs.flatMap((t, i) =>
      t.groupKey === g.key && !t.pinned ? [tabIds[i]!] : [],
    );
    if (members.length === 0) continue;
    const id = await browser.groupTabs(members, windowId);
    await browser.updateGroup(id, { title: g.title, color: g.color });
    groupIds.push({ id, collapsed: g.collapsed });
  }
  // Collapse last: tabs are created and moved while groups are still expanded.
  for (const g of groupIds) if (g.collapsed) await browser.updateGroup(g.id, { collapsed: true });

  // "Match exactly" closes every unmatched syncable tab; both modes drop leftover blank New Tab
  // pages, which hold no content.
  const toClose = wp.extras.filter(
    (id) => mode === 'match-exactly' || isNewTabUrl(liveTabs.get(id)?.url ?? ''),
  );
  await browser.removeTabs(toClose);

  // New windows show the snapshot's active tab; existing windows keep the user's active tab
  // unless it was just closed.
  const active = existing?.tabs?.find((t) => t.active);
  const activeSurvives = active && !toClose.includes(active.id!);
  let activeId: number | undefined;
  if (!activeSurvives) {
    activeId =
      tabIds[
        Math.max(
          0,
          target.tabs.findIndex((t) => t.active),
        )
      ]!;
    await browser.updateTab(activeId, { active: true });
  }
  for (const id of created) if (id !== activeId) toDiscard.push(id);
}
