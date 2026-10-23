import { matchTabs, matchWindows } from './matching';
import type { GroupColor, SnapTab, SnapWindow } from './types';

/** Where a tab sits in a layout. `window` is 1-based; `index` is the position in its strip. */
export interface TabLocation {
  window: number;
  index: number;
  pinned: boolean;
  group?: { title: string; color: GroupColor };
}

export type MoveReason = 'window' | 'group' | 'pinned' | 'position';

export interface PlacedTab {
  tab: SnapTab;
  at: TabLocation;
}

export interface MovedTab {
  /** The tab as it is in `to`. */
  tab: SnapTab;
  from: TabLocation;
  to: TabLocation;
  reasons: MoveReason[];
}

export interface LayoutComparison {
  /** In `to` but not `from`, in `to` order. */
  opened: PlacedTab[];
  /** In `from` but not `to`, in `from` order. */
  closed: PlacedTab[];
  /** In both, but in a different window, group, pinned state or relative position; `to` order. */
  moved: MovedTab[];
  unchanged: number;
}

interface Pair {
  fw: number;
  fi: number;
  tw: number;
  ti: number;
  crossWindow: boolean;
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = []; // index into values of the smallest tail for each length
  const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i !== -1; i = prev[i]!) keep.add(i);
  return keep;
}

function locate(windows: readonly SnapWindow[], w: number, i: number): TabLocation {
  const win = windows[w]!;
  const tab = win.tabs[i]!;
  const group = tab.groupKey ? win.groups.find((g) => g.key === tab.groupKey) : undefined;
  const at: TabLocation = { window: w + 1, index: i, pinned: tab.pinned };
  if (group) at.group = { title: group.title, color: group.color };
  return at;
}

const groupId = (windows: readonly SnapWindow[], w: number, i: number) => {
  const key = windows[w]!.tabs[i]!.groupKey;
  return key && windows[w]!.groups.some((g) => g.key === key) ? `${w}:${key}` : undefined;
};

/**
 * Compares two layouts (SPEC.md v2 "Diffs"). Tabs match as a multiset by URL (exact first, then
 * normalized), within paired windows first and then across windows. A matched tab counts as
 * moved if it changed window, group (groups are paired by shared tabs, so renaming a group
 * doesn't move its tabs) or pinned state, or if its relative order changed. Relative order uses
 * the longest run of tabs that kept their order, so opening or closing one tab doesn't make every
 * later tab look moved.
 */
export function compareLayouts(
  from: readonly SnapWindow[],
  to: readonly SnapWindow[],
): LayoutComparison {
  const pairs: Pair[] = [];
  const leftFrom: { w: number; i: number; tab: SnapTab }[] = [];
  const leftTo: { w: number; i: number; tab: SnapTab }[] = [];

  const wm = matchWindows(from, to);
  const pairedTo = new Set(wm.matches.map((m) => m.target));
  for (const { current: fw, target: tw } of wm.matches) {
    const tm = matchTabs(from[fw]!.tabs, to[tw]!.tabs);
    for (const m of tm.matches)
      pairs.push({ fw, fi: m.current, tw, ti: m.target, crossWindow: false });
    for (const i of tm.unmatchedCurrent) leftFrom.push({ w: fw, i, tab: from[fw]!.tabs[i]! });
    for (const i of tm.unmatchedTarget) leftTo.push({ w: tw, i, tab: to[tw]!.tabs[i]! });
  }
  for (const fw of wm.unmatchedCurrent)
    from[fw]!.tabs.forEach((tab, i) => leftFrom.push({ w: fw, i, tab }));
  to.forEach((w, tw) => {
    if (!pairedTo.has(tw)) w.tabs.forEach((tab, i) => leftTo.push({ w: tw, i, tab }));
  });

  // Tabs that changed windows.
  const cross = matchTabs(
    leftFrom.map((x) => ({ url: x.tab.url })),
    leftTo.map((x) => ({ url: x.tab.url })),
  );
  for (const m of cross.matches) {
    const f = leftFrom[m.current]!;
    const t = leftTo[m.target]!;
    pairs.push({ fw: f.w, fi: f.i, tw: t.w, ti: t.i, crossWindow: true });
  }

  // Pair groups across the layouts by how many tabs they share.
  const counts = new Map<string, { fg: string; tg: string; n: number }>();
  for (const p of pairs) {
    const fg = groupId(from, p.fw, p.fi);
    const tg = groupId(to, p.tw, p.ti);
    if (!fg || !tg) continue;
    const k = `${fg}|${tg}`;
    const c = counts.get(k) ?? { fg, tg, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  const groupPair = new Map<string, string>();
  const usedTo = new Set<string>();
  for (const c of [...counts.values()].sort((a, b) => b.n - a.n)) {
    if (groupPair.has(c.fg) || usedTo.has(c.tg)) continue;
    groupPair.set(c.fg, c.tg);
    usedTo.add(c.tg);
  }

  // Relative order within each window pair.
  const reordered = new Set<Pair>();
  for (const { current: fw, target: tw } of wm.matches) {
    const inWindow = pairs
      .filter((p) => !p.crossWindow && p.fw === fw && p.tw === tw)
      .sort((a, b) => a.ti - b.ti);
    const keep = longestIncreasing(inWindow.map((p) => p.fi));
    inWindow.forEach((p, k) => {
      if (!keep.has(k)) reordered.add(p);
    });
  }

  const moved: MovedTab[] = [];
  let unchanged = 0;
  for (const p of pairs) {
    const fromAt = locate(from, p.fw, p.fi);
    const toAt = locate(to, p.tw, p.ti);
    const reasons: MoveReason[] = [];
    if (p.crossWindow) reasons.push('window');
    const fg = groupId(from, p.fw, p.fi);
    const tg = groupId(to, p.tw, p.ti);
    const groupChanged =
      fg === undefined ? tg !== undefined : tg === undefined || groupPair.get(fg) !== tg;
    if (groupChanged) reasons.push('group');
    if (fromAt.pinned !== toAt.pinned) reasons.push('pinned');
    if (reordered.has(p)) reasons.push('position');
    if (reasons.length) moved.push({ tab: to[p.tw]!.tabs[p.ti]!, from: fromAt, to: toAt, reasons });
    else unchanged++;
  }

  const byTo = (a: { to: TabLocation }, b: { to: TabLocation }) =>
    a.to.window - b.to.window || a.to.index - b.to.index;
  const byAt = (a: PlacedTab, b: PlacedTab) => a.at.window - b.at.window || a.at.index - b.at.index;
  return {
    opened: cross.unmatchedTarget
      .map((k) => ({ tab: leftTo[k]!.tab, at: locate(to, leftTo[k]!.w, leftTo[k]!.i) }))
      .sort(byAt),
    closed: cross.unmatchedCurrent
      .map((k) => ({ tab: leftFrom[k]!.tab, at: locate(from, leftFrom[k]!.w, leftFrom[k]!.i) }))
      .sort(byAt),
    moved: moved.sort(byTo),
    unchanged,
  };
}
