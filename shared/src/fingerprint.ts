import { sha256Hex } from './crypto-primitives';
import type { SnapWindow } from './types';

/**
 * Canonical string of the parts of a layout that count as a change: window order, tab URLs
 * and order, pinned state, and group membership and properties (title, colour, collapsed).
 * Titles, favicons, active tabs, focus and window geometry are ignored. Group keys are
 * snapshot-local, so groups are identified by order of first appearance instead.
 */
export function canonicalLayout(windows: readonly SnapWindow[]): string {
  return JSON.stringify(
    windows.map((w) => {
      const byKey = new Map(w.groups.map((g) => [g.key, g]));
      const order: string[] = [];
      const tabs = w.tabs.map((t) => {
        let groupIndex = -1;
        if (t.groupKey !== undefined && byKey.has(t.groupKey)) {
          groupIndex = order.indexOf(t.groupKey);
          if (groupIndex < 0) groupIndex = order.push(t.groupKey) - 1;
        }
        return [t.url, t.pinned ? 1 : 0, groupIndex];
      });
      const groups = order.map((key) => {
        const g = byKey.get(key)!;
        return [g.title, g.color, g.collapsed ? 1 : 0];
      });
      return { tabs, groups };
    }),
  );
}

/** Hex SHA-256 of `canonicalLayout`. Equal fingerprints mean nothing worth pushing changed. */
export function fingerprint(windows: readonly SnapWindow[]): Promise<string> {
  return sha256Hex(canonicalLayout(windows));
}
