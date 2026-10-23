import { describe, expect, it } from 'vitest';
import { compareLayouts } from './compare';
import { group, tab, win } from './testing/fixtures';
import type { SnapWindow } from './types';

const w = (...urls: string[]) => win(urls.map((u) => tab(`https://${u}/`)));
const urls = (xs: { tab: { url: string } }[]) =>
  xs.map((x) => x.tab.url.replace(/^https:\/\/|\/$/g, ''));

describe('compareLayouts', () => {
  it('reports nothing for identical layouts', () => {
    const l = [w('a', 'b'), w('c')];
    expect(compareLayouts(l, structuredClone(l))).toEqual({
      opened: [],
      closed: [],
      moved: [],
      unchanged: 3,
    });
  });

  it('lists opened and closed tabs, counting duplicates separately', () => {
    const r = compareLayouts([w('a', 'b', 'b')], [w('a', 'b', 'c', 'c')]);
    expect(urls(r.opened)).toEqual(['c', 'c']);
    expect(urls(r.closed)).toEqual(['b']);
    expect(r.opened[0]!.at).toEqual({ window: 1, index: 2, pinned: false });
  });

  it('does not mark later tabs as moved when a tab is inserted or removed', () => {
    const r = compareLayouts([w('a', 'b', 'c', 'd')], [w('x', 'a', 'c', 'd')]);
    expect(r.moved).toEqual([]);
    expect(r.unchanged).toBe(3);
  });

  it('marks only the tab that changed position', () => {
    const r = compareLayouts([w('a', 'b', 'c', 'd', 'e')], [w('e', 'a', 'b', 'c', 'd')]);
    expect(r.moved.map((m) => [m.tab.url, m.reasons])).toEqual([['https://e/', ['position']]]);
    expect(r.moved[0]!.from.index).toBe(4);
    expect(r.moved[0]!.to.index).toBe(0);
  });

  it('marks a tab moved to another window, but not tabs in reordered windows', () => {
    const r = compareLayouts([w('a', 'b'), w('c', 'd')], [w('c', 'd', 'b'), w('a')]);
    expect(r.moved.map((m) => [m.tab.url, m.reasons, m.from.window, m.to.window])).toEqual([
      ['https://b/', ['window'], 1, 1],
    ]);
    expect(r.unchanged).toBe(3);
  });

  it('marks tabs that changed group, and records the groups', () => {
    const from: SnapWindow[] = [
      win(
        [
          tab('https://a/', { groupKey: 'w' }),
          tab('https://b/', { groupKey: 'w' }),
          tab('https://c/', { groupKey: 'r' }),
        ],
        [group('w', { title: 'Work', color: 'red' }), group('r', { title: 'Read', color: 'blue' })],
      ),
    ];
    const to: SnapWindow[] = [
      win(
        [
          tab('https://a/', { groupKey: 'x' }),
          tab('https://b/', { groupKey: 'y' }),
          tab('https://c/', { groupKey: 'y' }),
        ],
        [group('x', { title: 'Work', color: 'red' }), group('y', { title: 'Read', color: 'blue' })],
      ),
    ];
    const r = compareLayouts(from, to);
    expect(r.moved.map((m) => [m.tab.url, m.reasons])).toEqual([['https://b/', ['group']]]);
    expect(r.moved[0]!.from.group).toEqual({ title: 'Work', color: 'red' });
    expect(r.moved[0]!.to.group).toEqual({ title: 'Read', color: 'blue' });
  });

  it('does not treat renaming or recolouring a group as moving its tabs', () => {
    const before = [
      win(
        [tab('https://a/', { groupKey: 'g' }), tab('https://b/', { groupKey: 'g' })],
        [group('g', { title: 'Work' })],
      ),
    ];
    const after = [
      win(
        [tab('https://a/', { groupKey: 'g' }), tab('https://b/', { groupKey: 'g' })],
        [group('g', { title: 'Job', color: 'green' })],
      ),
    ];
    expect(compareLayouts(before, after).moved).toEqual([]);
  });

  it('marks grouping and ungrouping, and pinning', () => {
    const from = [win([tab('https://a/'), tab('https://b/', { groupKey: 'g' })], [group('g')])];
    const to = [win([tab('https://a/', { pinned: true }), tab('https://b/')])];
    expect(compareLayouts(from, to).moved.map((m) => [m.tab.url, m.reasons])).toEqual([
      ['https://a/', ['pinned']],
      ['https://b/', ['group']],
    ]);
  });

  it('matches through fragments and tracking parameters', () => {
    const r = compareLayouts(
      [win([tab('https://a/p#x')])],
      [win([tab('https://a/p?utm_source=y')])],
    );
    expect(r).toMatchObject({ opened: [], closed: [], unchanged: 1 });
  });

  it('handles new and removed windows', () => {
    const r = compareLayouts([w('a')], [w('a'), w('b', 'c')]);
    expect(urls(r.opened)).toEqual(['b', 'c']);
    expect(r.opened[0]!.at.window).toBe(2);
    expect(compareLayouts([w('a'), w('b')], [w('a')]).closed.map((c) => c.at.window)).toEqual([2]);
  });
});
