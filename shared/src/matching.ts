import { normalizeUrlForMatching } from './urls';

export interface HasUrl {
  url: string;
}

export interface IndexPair {
  current: number;
  target: number;
}

export interface TabMatchResult {
  /** Sorted by target index. */
  matches: IndexPair[];
  unmatchedCurrent: number[];
  unmatchedTarget: number[];
}

function pairByKey(
  current: readonly HasUrl[],
  target: readonly HasUrl[],
  currentFree: Set<number>,
  targetFree: Set<number>,
  key: (url: string) => string,
  matches: IndexPair[],
): void {
  const queues = new Map<string, number[]>();
  for (const i of currentFree) {
    const k = key(current[i]!.url);
    const queue = queues.get(k);
    if (queue) queue.push(i);
    else queues.set(k, [i]);
  }
  for (const t of [...targetFree]) {
    const c = queues.get(key(target[t]!.url))?.shift();
    if (c === undefined) continue;
    matches.push({ current: c, target: t });
    currentFree.delete(c);
    targetFree.delete(t);
  }
}

/**
 * Matches tabs as a multiset: each current tab pairs with at most one target tab, so duplicate
 * URLs count separately. Exact URLs pair first, then normalized URLs (fragment and tracking
 * parameters ignored). Within one URL, tabs pair in strip order.
 */
export function matchTabs(current: readonly HasUrl[], target: readonly HasUrl[]): TabMatchResult {
  const currentFree = new Set(current.keys());
  const targetFree = new Set(target.keys());
  const matches: IndexPair[] = [];
  pairByKey(current, target, currentFree, targetFree, (u) => u, matches);
  pairByKey(current, target, currentFree, targetFree, normalizeUrlForMatching, matches);
  matches.sort((a, b) => a.target - b.target);
  return { matches, unmatchedCurrent: [...currentFree], unmatchedTarget: [...targetFree] };
}

export interface WindowMatch extends IndexPair {
  /** Number of tabs the two windows share (multiset). */
  overlap: number;
}

export interface WindowMatchResult {
  /** Sorted by target index. */
  matches: WindowMatch[];
  /** Target windows with no counterpart: to be created. */
  unmatchedTarget: number[];
  /** Current windows with no counterpart: surplus. */
  unmatchedCurrent: number[];
}

/**
 * Pairs target windows with current windows by greatest tab overlap, greedily (largest overlap
 * first; ties go to the lower target index, then the lower current index). Windows that share
 * no tabs are never paired.
 */
export function matchWindows(
  current: readonly { tabs: readonly HasUrl[] }[],
  target: readonly { tabs: readonly HasUrl[] }[],
): WindowMatchResult {
  const candidates: WindowMatch[] = [];
  target.forEach((tw, t) => {
    current.forEach((cw, c) => {
      const overlap = matchTabs(cw.tabs, tw.tabs).matches.length;
      if (overlap > 0) candidates.push({ current: c, target: t, overlap });
    });
  });
  candidates.sort((a, b) => b.overlap - a.overlap || a.target - b.target || a.current - b.current);

  const usedCurrent = new Set<number>();
  const usedTarget = new Set<number>();
  const matches: WindowMatch[] = [];
  for (const m of candidates) {
    if (usedCurrent.has(m.current) || usedTarget.has(m.target)) continue;
    usedCurrent.add(m.current);
    usedTarget.add(m.target);
    matches.push(m);
  }
  matches.sort((a, b) => a.target - b.target);
  return {
    matches,
    unmatchedTarget: [...target.keys()].filter((t) => !usedTarget.has(t)),
    unmatchedCurrent: [...current.keys()].filter((c) => !usedCurrent.has(c)),
  };
}
