import { NEW_TAB_URL } from '@tabsync/shared';
import { group, tab, win } from '@tabsync/shared/testing';
import { describe, expect, it } from 'vitest';
import { openGroup, openOrFocusTab, openTab } from '../src/lib/open';
import { groupByDay, hostOf, windowSections } from '../src/ui/snapshot-view';
import { FakeBrowser } from './fakes';

describe('windowSections', () => {
  it('splits the strip into ungrouped runs and groups, in order', () => {
    const work = group('w', { title: 'Work' });
    const play = group('p', { title: 'Play' });
    const sections = windowSections(
      win(
        [
          tab('https://pin/', { pinned: true }),
          tab('https://a/', { groupKey: 'w' }),
          tab('https://b/', { groupKey: 'w' }),
          tab('https://loose/'),
          tab('https://c/', { groupKey: 'p' }),
        ],
        [work, play],
      ),
    );
    expect(sections.map((s) => [s.group?.title, s.tabs.map((t) => t.url)])).toEqual([
      [undefined, ['https://pin/']],
      ['Work', ['https://a/', 'https://b/']],
      [undefined, ['https://loose/']],
      ['Play', ['https://c/']],
    ]);
  });

  it('treats a tab referencing an unknown group as ungrouped', () => {
    expect(
      windowSections(win([tab('https://a/', { groupKey: 'nope' })]))[0]!.group,
    ).toBeUndefined();
  });
});

describe('groupByDay', () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  const at = (...args: [number, number, number, number]) => ({
    createdAt: new Date(...args).toISOString(),
  });

  it('labels Today, Yesterday, then dates (with the year when different)', () => {
    const items = [
      at(2026, 9, 22, 14),
      at(2026, 9, 22, 9),
      at(2026, 9, 21, 20),
      at(2026, 9, 20, 8),
      at(2025, 11, 1, 8),
    ];
    const days = groupByDay(items, now, 'en-GB');
    expect(days.map((d) => [d.label, d.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Tue 20 Oct', 1],
      ['Mon 1 Dec 2025', 1],
    ]);
  });
});

describe('hostOf', () => {
  it('shows the host, or the URL when there is none', () => {
    expect(hostOf('https://news.example.com/a/b?c')).toBe('news.example.com');
    expect(hostOf('about:blank')).toBe('about:blank');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('opening from a snapshot', () => {
  it('opens one tab, focused', async () => {
    const b = new FakeBrowser();
    const w = b.addWindow(['https://current/']);
    await openTab(b, w.id, tab('https://a/', { pinned: true }));
    expect(b.windows[0]!.tabs.map((t) => [t.url, t.active, t.pinned])).toEqual([
      ['https://current/', false, false],
      ['https://a/', true, false],
    ]);
  });

  it('opens in the background when asked (cmd/ctrl-click)', async () => {
    const b = new FakeBrowser();
    const w = b.addWindow(['https://current/']);
    await openTab(b, w.id, tab('https://a/'), { active: false });
    expect(b.windows[0]!.tabs.find((t) => t.active)!.url).toBe('https://current/');
  });

  describe('openOrFocusTab', () => {
    it('focuses the tab and its window when the URL is already open', async () => {
      const b = new FakeBrowser();
      const here = b.addWindow(['https://current/']);
      const other = b.addWindow(['https://x/', 'https://a/page']);
      const result = await openOrFocusTab(b, here.id, tab('https://a/page'));
      expect(result).toBe('focused');
      expect(b.windows.find((w) => w.focused)!.id).toBe(other.id);
      expect(other.tabs.find((t) => t.active)!.url).toBe('https://a/page');
      expect(b.windows.flatMap((w) => w.tabs)).toHaveLength(3);
    });

    it('matches through fragments and tracking parameters, preferring an exact URL', async () => {
      const b = new FakeBrowser();
      const w = b.addWindow(['https://a/page?utm_source=x', 'https://a/page#top']);
      const [tracked, exact] = [w.tabs[0]!.id, w.tabs[1]!.id];
      await openOrFocusTab(b, w.id, tab('https://a/page#top'));
      expect(b.ops).toEqual([`focus ${exact}`]);
      b.ops = [];
      await openOrFocusTab(b, w.id, tab('https://a/page'));
      expect(b.ops).toEqual([`focus ${tracked}`]);
    });

    it('prefers a match in the current window', async () => {
      const b = new FakeBrowser();
      b.addWindow(['https://a/']);
      const here = b.addWindow(['https://other/', 'https://a/']);
      await openOrFocusTab(b, here.id, tab('https://a/'));
      expect(b.ops).toEqual([`focus ${here.tabs[1]!.id}`]);
    });

    it('opens a new tab when the URL isn’t open, and always for New Tab placeholders', async () => {
      const b = new FakeBrowser();
      const w = b.addWindow(['chrome://newtab/']);
      expect(await openOrFocusTab(b, w.id, tab('https://new/'))).toBe('opened');
      expect(await openOrFocusTab(b, w.id, tab(NEW_TAB_URL))).toBe('opened');
      expect(b.windows[0]!.tabs.map((t) => t.url)).toEqual([
        'chrome://newtab/',
        'https://new/',
        NEW_TAB_URL,
      ]);
    });

    it('ignores private windows', async () => {
      const b = new FakeBrowser();
      const w = b.addWindow(['https://current/']);
      b.addWindow(['https://secret/'], { incognito: true });
      expect(await openOrFocusTab(b, w.id, tab('https://secret/'))).toBe('opened');
    });
  });

  it('reopens a group with its title and colour, expanded', async () => {
    const b = new FakeBrowser();
    const w = b.addWindow(['https://current/']);
    const g = group('w', { title: 'Work', color: 'red', collapsed: true });
    const id = await openGroup(b, w.id, g, [
      tab('https://a/', { groupKey: 'w' }),
      tab(NEW_TAB_URL, { groupKey: 'w' }),
    ]);
    expect(b.groups).toEqual([
      expect.objectContaining({ id, title: 'Work', color: 'red', collapsed: false }),
    ]);
    const tabs = b.windows[0]!.tabs;
    expect(tabs.slice(1).map((t) => [t.url, t.groupId])).toEqual([
      ['https://a/', id],
      [NEW_TAB_URL, id],
    ]);
    expect(tabs.find((t) => t.active)!.url).toBe('https://a/');
  });

  it('skips tabs the browser refuses, and opens nothing if all are refused', async () => {
    const b = new FakeBrowser();
    const w = b.addWindow(['https://current/']);
    b.refusedUrls.add('javascript:x');
    const g = group('w', { title: 'G' });
    await openGroup(b, w.id, g, [tab('javascript:x'), tab('https://ok/')]);
    expect(b.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://current/', 'https://ok/']);
    expect(await openGroup(b, w.id, g, [tab('javascript:x')])).toBeUndefined();
  });
});
