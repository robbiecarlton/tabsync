import { describe, expect, it } from 'vitest';
import { describeDiff, diffLayouts } from './diff';
import { group, tab, win } from './testing/fixtures';

describe('diffLayouts', () => {
  it('reports no changes for identical layouts', () => {
    const w = [win([tab('https://a/')])];
    const d = diffLayouts(w, structuredClone(w));
    expect(d).toEqual({ opened: [], closed: [], groupsChanged: 0, layoutChanged: false });
    expect(describeDiff(d)).toBe('No changes');
  });

  it('counts opened and closed tabs across all windows', () => {
    const from = [win([tab('https://a/'), tab('https://b/')]), win([tab('https://c/')])];
    const to = [
      win([tab('https://a/'), tab('https://d/'), tab('https://e/')]),
      win([tab('https://c/')]),
    ];
    const d = diffLayouts(from, to);
    expect(d.opened.map((t) => t.url)).toEqual(['https://d/', 'https://e/']);
    expect(d.closed.map((t) => t.url)).toEqual(['https://b/']);
    expect(describeDiff(d)).toBe('2 opened, 1 closed');
  });

  it('counts duplicates', () => {
    const d = diffLayouts(
      [win([tab('https://a/')])],
      [win([tab('https://a/'), tab('https://a/')])],
    );
    expect(d.opened).toHaveLength(1);
  });

  it('treats a tab moved between windows as neither opened nor closed', () => {
    const d = diffLayouts(
      [win([tab('https://a/'), tab('https://b/')]), win([tab('https://c/')])],
      [win([tab('https://a/')]), win([tab('https://c/'), tab('https://b/')])],
    );
    expect(d.opened).toEqual([]);
    expect(d.closed).toEqual([]);
    expect(d.layoutChanged).toBe(true);
    expect(describeDiff(d)).toBe('Tabs rearranged');
  });

  describe('groups', () => {
    const grouped = (
      title: string,
      urls: string[],
      extra: Partial<Parameters<typeof group>[1]> = {},
    ) =>
      win(
        urls.map((u) => tab(u, { groupKey: 'g' })),
        [group('g', { title, ...extra })],
      );

    it('ignores unchanged groups, even with different keys', () => {
      const from = [win([tab('https://a/', { groupKey: 'k1' })], [group('k1', { title: 'Work' })])];
      const to = [win([tab('https://a/', { groupKey: 'k9' })], [group('k9', { title: 'Work' })])];
      expect(diffLayouts(from, to).groupsChanged).toBe(0);
    });

    it.each([
      ['renamed', grouped('Play', ['https://a/', 'https://b/'])],
      ['recoloured', grouped('Work', ['https://a/', 'https://b/'], { color: 'green' })],
      ['collapsed', grouped('Work', ['https://a/', 'https://b/'], { collapsed: true })],
      ['gained a member', grouped('Work', ['https://a/', 'https://b/', 'https://c/'])],
    ])('counts a group that was %s once', (_name, after) => {
      const d = diffLayouts([grouped('Work', ['https://a/', 'https://b/'])], [after]);
      expect(d.groupsChanged).toBe(1);
      expect(describeDiff(d)).toContain('1 group changed');
    });

    it('counts added and removed groups', () => {
      const from = [grouped('Old', ['https://a/'])];
      const to = [
        win(
          [tab('https://a/'), tab('https://z/', { groupKey: 'n' })],
          [group('n', { title: 'New' })],
        ),
      ];
      const d = diffLayouts(from, to);
      expect(d.groupsChanged).toBe(2);
      expect(describeDiff(d)).toBe('1 opened, 2 groups changed');
    });
  });
});
