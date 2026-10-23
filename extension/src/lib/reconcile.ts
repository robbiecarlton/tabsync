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

export interface ApplyResult {
  /** URLs the browser refused to open (left out rather than aborting the apply). */
  skipped: string[];
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
): Promise<ApplyResult> {
  const [windows, groups] = await Promise.all([browser.getWindows(), browser.getGroups()]);
  const plan = planApply(windows, target);
  const toDiscard: number[] = [];
  const skipped: string[] = [];

  for (const wp of plan.windows) {
    const existing = windows.find((w) => w.id === wp.windowId);
    if (existing && isAlreadyApplied(existing, groups, wp, options.mode)) continue;
    await applyWindow(browser, wp, existing, options.mode, toDiscard, skipped);
  }

  if (options.mode === 'match-exactly' && options.closeSurplusWindows) {
    for (const id of plan.surplusWindowIds) await browser.removeWindow(id);
  }
  for (const id of toDiscard) await browser.discardTab(id);
  return { skipped };
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

/** A stretch of the target strip: one ungrouped tab, or all tabs of one group (in order). */
interface Unit {
  group?: string;
  pinned: boolean;
  ids: number[];
}

function unitsOf(target: SnapWindow, tabIds: (number | undefined)[]): Unit[] {
  const groupKeys = new Set(target.groups.map((g) => g.key));
  const units: Unit[] = [];
  target.tabs.forEach((t, i) => {
    const id = tabIds[i];
    if (id === undefined) return;
    const group = !t.pinned && t.groupKey && groupKeys.has(t.groupKey) ? t.groupKey : undefined;
    const existing = group ? units.find((u) => u.group === group) : undefined;
    if (existing) existing.ids.push(id);
    else units.push({ group, pinned: t.pinned, ids: [id] });
  });
  return units;
}

interface LiveStrip {
  order: number[];
  groupOf: Map<number, number>;
  pinnedCount: number;
}

async function readStrip(browser: BrowserApi, windowId: number): Promise<LiveStrip> {
  const w = (await browser.getWindows()).find((x) => x.id === windowId);
  const tabs = [...(w?.tabs ?? [])].sort((a, b) => a.index - b.index);
  return {
    order: tabs.map((t) => t.id!),
    groupOf: new Map(tabs.map((t) => [t.id!, t.groupId])),
    pinnedCount: tabs.filter((t) => t.pinned).length,
  };
}

/**
 * Makes one window match its target with as few browser operations as possible, so tabs and
 * groups that are already right aren't touched (no collapsed group flickering open):
 * existing groups are reused, only tabs whose membership changes are (un)grouped, and only
 * out-of-place tabs and groups are moved.
 */
async function applyWindow(
  browser: BrowserApi,
  wp: WindowPlan,
  existing: BrowserWindow | undefined,
  mode: ApplyMode,
  toDiscard: number[],
  skipped: string[],
): Promise<void> {
  const { target } = wp;
  /** Per target tab; undefined where the browser refused to open it. */
  const tabIds: (number | undefined)[] = [];
  let windowId: number;
  const created = new Set<number>();
  /** Placeholder tab of a new window whose first URL was refused. */
  const toCloseLater: number[] = [];

  if (existing) {
    windowId = existing.id!;
  } else {
    const first = target.tabs[0]!;
    let w;
    try {
      w = await browser.createWindow({
        url: urlToOpen(first.url),
        focused: false,
        state: target.state,
      });
      tabIds[0] = w.tabId;
      if (first.pinned) await browser.updateTab(w.tabId, { pinned: true });
    } catch {
      // The first URL was refused; open the window on a New Tab page and drop that tab.
      w = await browser.createWindow({ focused: false, state: target.state });
      skipped.push(first.url);
      tabIds[0] = undefined;
      toCloseLater.push(w.tabId);
    }
    windowId = w.windowId;
    created.add(w.tabId);
  }

  // 1. Every target tab exists, with the right pinned state.
  const liveTabs = new Map((existing?.tabs ?? []).map((t) => [t.id, t]));
  for (const [i, tab] of target.tabs.entries()) {
    if (i === 0 && !existing) continue;
    const reuse = wp.reuse[i];
    if (reuse !== undefined) {
      tabIds[i] = reuse;
      if (liveTabs.get(reuse)?.pinned !== tab.pinned)
        await browser.updateTab(reuse, { pinned: tab.pinned });
    } else {
      try {
        tabIds[i] = await browser.createTab({
          windowId,
          url: urlToOpen(tab.url),
          pinned: tab.pinned,
          active: false,
        });
        created.add(tabIds[i]!);
      } catch {
        // One bad URL (e.g. one the browser won't open from an extension) mustn't abort the rest.
        skipped.push(tab.url);
      }
    }
  }
  const placed = tabIds.filter((id): id is number => id !== undefined);
  const units = unitsOf(target, tabIds);
  let strip = await readStrip(browser, windowId);

  // 2. Each target group reuses the live group most of its tabs are already in.
  const groupFor = new Map<string, number>();
  const candidates: { key: string; gid: number; count: number }[] = [];
  for (const u of units) {
    if (!u.group) continue;
    const counts = new Map<number, number>();
    for (const id of u.ids) {
      const g = strip.groupOf.get(id) ?? -1;
      if (g !== -1) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    for (const [gid, count] of counts) candidates.push({ key: u.group, gid, count });
  }
  candidates.sort((a, b) => b.count - a.count);
  const claimed = new Set<number>();
  for (const c of candidates) {
    if (groupFor.has(c.key) || claimed.has(c.gid)) continue;
    groupFor.set(c.key, c.gid);
    claimed.add(c.gid);
  }

  // 3. Ungroup only tabs in the wrong group: target tabs whose group differs, and other tabs
  //    sitting inside a reused group. Groups that aren't reused (e.g. among kept tabs) stay.
  const wanted = new Map<number, number | 'new'>();
  for (const u of units) {
    for (const id of u.ids) wanted.set(id, u.group ? (groupFor.get(u.group) ?? 'new') : -1);
  }
  const toUngroup = strip.order.filter((id) => {
    const g = strip.groupOf.get(id) ?? -1;
    if (g === -1) return false;
    return wanted.has(id) ? wanted.get(id) !== g : claimed.has(g);
  });
  if (toUngroup.length) {
    await browser.ungroupTabs(toUngroup);
    strip = await readStrip(browser, windowId);
  }

  // 4. Place units left to right; move only what's out of place.
  const moveIfNeeded = async (id: number, to: number) => {
    const from = strip.order.indexOf(id);
    if (from === to) return;
    await browser.moveTab(id, windowId, to);
    strip.order.splice(from, 1);
    strip.order.splice(to, 0, id);
  };
  let p = 0;
  let pastPinned = false;
  for (const u of units) {
    if (!u.pinned && !pastPinned) {
      // Unpinned tabs start after every pinned tab, including pinned tabs kept in add-missing mode.
      pastPinned = true;
      p = Math.max(p, strip.pinnedCount);
    }
    if (!u.group) {
      await moveIfNeeded(u.ids[0]!, p++);
      continue;
    }
    let gid = groupFor.get(u.group);
    if (gid === undefined) {
      gid = await browser.groupTabs(u.ids, windowId);
      groupFor.set(u.group, gid);
      strip = await readStrip(browser, windowId);
    } else {
      const add = u.ids.filter((id) => strip.groupOf.get(id) !== gid);
      if (add.length) {
        await browser.groupTabs(add, windowId, gid);
        strip = await readStrip(browser, windowId);
      }
    }
    if (strip.order.findIndex((id) => strip.groupOf.get(id) === gid) !== p) {
      await browser.moveGroup(gid, p);
      strip = await readStrip(browser, windowId);
    }
    for (const [k, id] of u.ids.entries()) await moveIfNeeded(id, p + k);
    p += u.ids.length;
  }

  // 5. Group properties, only where they differ; collapse last.
  const liveGroups = new Map((await browser.getGroups()).map((g) => [g.id, g]));
  const collapse: { id: number; collapsed: boolean }[] = [];
  for (const g of target.groups) {
    const gid = groupFor.get(g.key);
    const live = gid !== undefined ? liveGroups.get(gid) : undefined;
    if (gid === undefined || !live) continue;
    const props: { title?: string; color?: typeof g.color } = {};
    if ((live.title ?? '') !== g.title) props.title = g.title;
    if (live.color !== g.color) props.color = g.color;
    if (Object.keys(props).length) await browser.updateGroup(gid, props);
    if (live.collapsed !== g.collapsed) collapse.push({ id: gid, collapsed: g.collapsed });
  }
  for (const c of collapse) await browser.updateGroup(c.id, { collapsed: c.collapsed });

  // 6. "Match exactly" closes every unmatched syncable tab; both modes drop leftover blank New Tab
  //    pages, which hold no content.
  const toClose = wp.extras.filter(
    (id) => mode === 'match-exactly' || isNewTabUrl(liveTabs.get(id)?.url ?? ''),
  );
  if (placed.length > 0) toClose.push(...toCloseLater);
  await browser.removeTabs(toClose);

  // New windows show the snapshot's active tab; existing windows keep the user's active tab
  // unless it was just closed.
  const active = existing?.tabs?.find((t) => t.active);
  const activeSurvives = active && !toClose.includes(active.id!);
  let activeId: number | undefined;
  if (!activeSurvives) {
    activeId = tabIds[target.tabs.findIndex((t) => t.active)] ?? placed[0];
    if (activeId !== undefined) await browser.updateTab(activeId, { active: true });
  }
  for (const id of created) if (id !== activeId && !toClose.includes(id)) toDiscard.push(id);
}
