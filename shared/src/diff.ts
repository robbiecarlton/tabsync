import { canonicalLayout } from './fingerprint';
import { matchTabs } from './matching';
import type { SnapGroup, SnapTab, SnapWindow } from './types';
import { normalizeUrlForMatching } from './urls';

export interface SnapshotDiff {
  /** Tabs in `to` with no counterpart in `from`. */
  opened: SnapTab[];
  /** Tabs in `from` with no counterpart in `to`. */
  closed: SnapTab[];
  /** Groups added, removed, or changed in title, colour, collapsed state or membership. */
  groupsChanged: number;
  /** Anything in the fingerprinted layout differs (includes pure reorders and pin changes). */
  layoutChanged: boolean;
}

interface GroupInfo {
  group: SnapGroup;
  /** Sorted normalized member URLs (a multiset). */
  members: string[];
}

function collectGroups(windows: readonly SnapWindow[]): GroupInfo[] {
  const out: GroupInfo[] = [];
  for (const w of windows) {
    for (const g of w.groups) {
      const members = w.tabs
        .filter((t) => t.groupKey === g.key)
        .map((t) => normalizeUrlForMatching(t.url))
        .sort();
      if (members.length > 0) out.push({ group: g, members });
    }
  }
  return out;
}

function multisetOverlap(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let n = 0;
  for (const x of b) {
    const c = counts.get(x) ?? 0;
    if (c > 0) {
      n++;
      counts.set(x, c - 1);
    }
  }
  return n;
}

function sameGroup(a: GroupInfo, b: GroupInfo): boolean {
  return (
    a.group.title === b.group.title &&
    a.group.color === b.group.color &&
    a.group.collapsed === b.group.collapsed &&
    a.members.length === b.members.length &&
    a.members.every((m, i) => m === b.members[i])
  );
}

/**
 * Pairs groups across the two layouts (same non-empty title weighs most, then shared members)
 * and counts each changed pair, plus each unpaired group on either side, once.
 */
function countGroupChanges(from: GroupInfo[], to: GroupInfo[]): number {
  const TITLE_WEIGHT = 1_000_000;
  const candidates: { f: number; t: number; score: number }[] = [];
  from.forEach((fg, f) => {
    to.forEach((tg, t) => {
      const titleMatch = fg.group.title !== '' && fg.group.title === tg.group.title;
      const score = (titleMatch ? TITLE_WEIGHT : 0) + multisetOverlap(fg.members, tg.members);
      if (score > 0) candidates.push({ f, t, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.t - b.t || a.f - b.f);

  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();
  let changed = 0;
  for (const { f, t } of candidates) {
    if (usedFrom.has(f) || usedTo.has(t)) continue;
    usedFrom.add(f);
    usedTo.add(t);
    if (!sameGroup(from[f]!, to[t]!)) changed++;
  }
  return changed + (from.length - usedFrom.size) + (to.length - usedTo.size);
}

/** Summarizes what changes going from one layout to another. Windows are ignored for opened/closed. */
export function diffLayouts(from: readonly SnapWindow[], to: readonly SnapWindow[]): SnapshotDiff {
  const fromTabs = from.flatMap((w) => w.tabs);
  const toTabs = to.flatMap((w) => w.tabs);
  const { unmatchedCurrent, unmatchedTarget } = matchTabs(fromTabs, toTabs);
  return {
    opened: unmatchedTarget.map((i) => toTabs[i]!),
    closed: unmatchedCurrent.map((i) => fromTabs[i]!),
    groupsChanged: countGroupChanges(collectGroups(from), collectGroups(to)),
    layoutChanged: canonicalLayout(from) !== canonicalLayout(to),
  };
}

/** Human summary, e.g. "3 opened, 1 closed, 1 group changed". */
export function describeDiff(diff: SnapshotDiff): string {
  const parts: string[] = [];
  if (diff.opened.length) parts.push(`${diff.opened.length} opened`);
  if (diff.closed.length) parts.push(`${diff.closed.length} closed`);
  if (diff.groupsChanged) {
    parts.push(`${diff.groupsChanged} ${diff.groupsChanged === 1 ? 'group' : 'groups'} changed`);
  }
  if (parts.length) return parts.join(', ');
  return diff.layoutChanged ? 'Tabs rearranged' : 'No changes';
}
