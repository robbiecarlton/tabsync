import type {
  MovedTab,
  SnapGroup,
  SnapshotReason,
  SnapTab,
  SnapWindow,
  TabLocation,
} from '@tabsync/shared';

/** A run of tabs in strip order: ungrouped tabs, or one group's tabs. */
export interface Section {
  group?: SnapGroup;
  tabs: SnapTab[];
}

/** Splits a window's strip into sections so groups can be shown under their header. */
export function windowSections(window: SnapWindow): Section[] {
  const groups = new Map(window.groups.map((g) => [g.key, g]));
  const sections: Section[] = [];
  for (const tab of window.tabs) {
    const group = tab.groupKey ? groups.get(tab.groupKey) : undefined;
    const last = sections.at(-1);
    if (last && last.group === group) last.tabs.push(tab);
    else sections.push({ group, tabs: [tab] });
  }
  return sections;
}

export interface DayGroup<T> {
  /** "Today", "Yesterday", or e.g. "Tue 20 Oct" / "Tue 20 Oct 2025". */
  label: string;
  items: T[];
}

/** Groups items (already newest first) by local calendar day. */
export function groupByDay<T extends { createdAt: string }>(
  items: T[],
  now: number,
  locale?: string,
): DayGroup<T>[] {
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const days: DayGroup<T>[] = [];
  let lastKey = '';
  for (const item of items) {
    const d = new Date(Date.parse(item.createdAt));
    const key = d.toDateString();
    if (key !== lastKey) {
      let label: string;
      if (key === today.toDateString()) label = 'Today';
      else if (key === yesterday.toDateString()) label = 'Yesterday';
      else {
        const weekday = d.toLocaleDateString(locale, { weekday: 'short' });
        const date = d.toLocaleDateString(locale, {
          day: 'numeric',
          month: 'short',
          ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
        });
        label = `${weekday} ${date}`;
      }
      days.push({ label, items: [] });
      lastKey = key;
    }
    days.at(-1)!.items.push(item);
  }
  return days;
}

export const KIND_LABEL: Record<SnapshotReason, string> = {
  auto: 'Auto',
  manual: 'Restore / resolve',
  'pre-restore': 'Undo point',
};

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const groupName = (at: TabLocation) => (at.group ? at.group.title || 'untitled group' : 'no group');

/** Human description of a move, e.g. ["Window 1 → 2", "Work → no group", "reordered"]. */
export function describeMove(m: MovedTab): string[] {
  const parts: string[] = [];
  if (m.reasons.includes('window')) parts.push(`Window ${m.from.window} → ${m.to.window}`);
  if (m.reasons.includes('group')) parts.push(`${groupName(m.from)} → ${groupName(m.to)}`);
  if (m.reasons.includes('pinned')) parts.push(m.to.pinned ? 'pinned' : 'unpinned');
  if (m.reasons.includes('position')) parts.push('reordered');
  return parts;
}

/** A side of a comparison: a snapshot ID, or the tabs open right now. */
export type CompareRef = string | 'now';

export type PageRoute =
  { view: string } | { compare: { a: CompareRef; b: CompareRef } } | { none: true };

/** `#<id>` views a snapshot; `#<a>/vs/<b>` compares (either side may be `now`). */
export function parseRoute(hash: string): PageRoute {
  const h = decodeURIComponent(hash.replace(/^#/, ''));
  if (!h) return { none: true };
  const [a, b] = h.split('/vs/');
  if (a && b) return { compare: { a, b } };
  return { view: h };
}

export function routeHash(route: PageRoute): string {
  if ('view' in route) return `#${route.view}`;
  if ('compare' in route) return `#${route.compare.a}/vs/${route.compare.b}`;
  return '';
}
