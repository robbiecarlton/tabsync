import { canonicalLayout, NEW_TAB_URL, type SnapWindow } from '@tabsync/shared';
import { group, tab, win } from '@tabsync/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureLayout } from '../src/lib/capture';
import { applyLayout, planApply } from '../src/lib/reconcile';
import { FakeBrowser } from './fakes';

let b: FakeBrowser;
beforeEach(() => {
  b = new FakeBrowser();
});

async function layout() {
  return captureLayout(await b.getWindows(), await b.getGroups());
}

async function expectMatches(target: SnapWindow[]) {
  expect(canonicalLayout(await layout())).toBe(canonicalLayout(target));
}

const urls = (w: { tabs: { url: string }[] } | undefined) => w?.tabs.map((t) => t.url);

describe('planApply', () => {
  it('pairs windows by overlap and tabs as a multiset', async () => {
    const w1 = b.addWindow(['https://x/', 'https://y/']);
    const w2 = b.addWindow(['https://a/', 'https://a/', 'https://b/']);
    const plan = planApply(await b.getWindows(), [
      win([tab('https://a/'), tab('https://c/')]),
      win([tab('https://y/')]),
    ]);
    expect(plan.windows[0]!.windowId).toBe(w2.id);
    expect(plan.windows[0]!.reuse).toEqual([w2.tabs[0]!.id, undefined]);
    expect(plan.windows[0]!.extras).toEqual([w2.tabs[1]!.id, w2.tabs[2]!.id]);
    expect(plan.windows[1]!.windowId).toBe(w1.id);
    expect(plan.surplusWindowIds).toEqual([]);
  });

  it('reuses blank windows before creating new ones, and never calls them surplus', async () => {
    const blank = b.addWindow(['chrome://newtab/']);
    b.addWindow(['brave://settings/']);
    const plan = planApply(await b.getWindows(), [
      win([tab('https://a/')]),
      win([tab('https://b/')]),
    ]);
    expect(plan.windows[0]!.windowId).toBe(blank.id);
    expect(plan.windows[1]!.windowId).toBeUndefined();
    expect(plan.surplusWindowIds).toEqual([]);
  });

  it('reports windows with unrelated content as surplus', async () => {
    const other = b.addWindow(['https://unrelated/']);
    const plan = planApply(await b.getWindows(), [win([tab('https://a/')])]);
    expect(plan.surplusWindowIds).toEqual([other.id]);
  });
});

describe('applyLayout', () => {
  const target = (): SnapWindow[] => [
    win(
      [
        tab('https://pinned1/', { pinned: true }),
        tab('https://pinned2/', { pinned: true }),
        tab('https://g1a/', { groupKey: 'g1' }),
        tab('https://g1b/', { groupKey: 'g1', active: true }),
        tab('https://loose/'),
        tab('https://loose/'),
        tab('https://g2/', { groupKey: 'g2' }),
      ],
      [
        group('g1', { title: 'Work', color: 'red' }),
        group('g2', { title: 'Later', color: 'green', collapsed: true }),
      ],
    ),
    win([tab('https://second/')]),
  ];

  it('builds the full layout into a blank browser', async () => {
    b.addWindow(['chrome://newtab/']);
    await applyLayout(b, target(), { mode: 'match-exactly' });
    await expectMatches(target());
    expect(b.groups.map((g) => [g.title, g.color, g.collapsed])).toEqual([
      ['Work', 'red', false],
      ['Later', 'green', true],
    ]);
  });

  it('drops the blank New Tab page even when only adding missing tabs', async () => {
    b.addWindow(['chrome://newtab/']);
    await applyLayout(b, target(), { mode: 'add-missing' });
    await expectMatches(target());
  });

  it('opens new tabs unloaded, except the active tab of new windows', async () => {
    b.addWindow(['chrome://newtab/']);
    await applyLayout(b, target(), { mode: 'match-exactly' });
    const tabs = b.windows.flatMap((w) => w.tabs);
    expect(
      tabs
        .filter((t) => !t.discarded)
        .map((t) => t.url)
        .sort(),
    ).toEqual(['https://g1b/', 'https://second/']);
    expect(b.windows[0]!.tabs.find((t) => t.active)!.url).toBe('https://g1b/');
  });

  it('reorders existing tabs: pinned first and in order, groups contiguous', async () => {
    const w = b.addWindow([
      'https://g2/',
      'https://loose/',
      'https://pinned2/',
      'https://g1b/',
      'https://pinned1/',
    ]);
    b.addGroup([w.tabs[0]!.id, w.tabs[1]!.id], { title: 'Old', color: 'blue' });
    await applyLayout(b, target(), { mode: 'match-exactly' });
    await expectMatches(target());
  });

  it('turns a pinned tab into a grouped one and vice versa', async () => {
    const w = b.addWindow(['https://g1a/', 'https://pinned1/']);
    w.tabs[0]!.pinned = true;
    b.addGroup([w.tabs[1]!.id], { title: 'X' });
    const t = [
      win(
        [tab('https://pinned1/', { pinned: true }), tab('https://g1a/', { groupKey: 'g' })],
        [group('g')],
      ),
    ];
    await applyLayout(b, t, { mode: 'match-exactly' });
    await expectMatches(t);
  });

  it('preserves duplicate URLs as separate tabs', async () => {
    b.addWindow(['https://loose/']);
    const t = [win([tab('https://loose/'), tab('https://loose/'), tab('https://loose/')])];
    await applyLayout(b, t, { mode: 'match-exactly' });
    expect(urls(b.windows[0])).toEqual(['https://loose/', 'https://loose/', 'https://loose/']);
  });

  it('can create and move tabs into a group that ends up collapsed', async () => {
    const w = b.addWindow(['https://x/', 'https://b/']);
    b.addGroup([w.tabs[1]!.id], { title: 'Folded', collapsed: true });
    const t = [
      win(
        [
          tab('https://a/', { groupKey: 'f' }),
          tab('https://b/', { groupKey: 'f' }),
          tab('https://c/', { groupKey: 'f' }),
        ],
        [group('f', { title: 'Folded', collapsed: true })],
      ),
    ];
    await applyLayout(b, t, { mode: 'match-exactly' });
    await expectMatches(t);
  });

  describe('add missing only', () => {
    it('keeps unmatched tabs after the target tabs', async () => {
      b.addWindow(['https://mine1/', 'https://second-window-tab/', 'https://a/', 'https://mine2/']);
      const t = [win([tab('https://a/'), tab('https://b/')])];
      await applyLayout(b, t, { mode: 'add-missing' });
      expect(urls(b.windows[0])).toEqual([
        'https://a/',
        'https://b/',
        'https://mine1/',
        'https://second-window-tab/',
        'https://mine2/',
      ]);
    });

    it('does not let target tabs fall into a leftover group', async () => {
      const w = b.addWindow(['https://mine1/', 'https://mine2/', 'https://a/']);
      b.addGroup([w.tabs[0]!.id, w.tabs[1]!.id], { title: 'Mine' });
      const t = [win([tab('https://a/'), tab('https://b/'), tab('https://c/')])];
      await applyLayout(b, t, { mode: 'add-missing' });
      const layoutNow = await layout();
      expect(layoutNow[0]!.tabs.slice(0, 3).map((x) => x.groupKey)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(layoutNow[0]!.tabs.slice(3).map((x) => x.groupKey)).toEqual(['g1', 'g1']);
      expect(layoutNow[0]!.groups[0]!.title).toBe('Mine');
    });

    it('keeps the user’s active tab', async () => {
      const w = b.addWindow(['https://a/', 'https://mine/']);
      w.tabs[0]!.active = false;
      w.tabs[1]!.active = true;
      await applyLayout(b, [win([tab('https://a/'), tab('https://b/', { active: true })])], {
        mode: 'add-missing',
      });
      expect(b.windows[0]!.tabs.find((t) => t.active)!.url).toBe('https://mine/');
    });

    it('leaves surplus windows alone', async () => {
      b.addWindow(['https://a/']);
      b.addWindow(['https://unrelated/']);
      await applyLayout(b, [win([tab('https://a/')])], {
        mode: 'add-missing',
        closeSurplusWindows: true,
      });
      expect(b.windows).toHaveLength(2);
    });
  });

  describe('match exactly', () => {
    it('closes unmatched tabs but never internal pages', async () => {
      b.addWindow([
        'https://a/',
        'https://extra/',
        'brave://settings/',
        'chrome-extension://x/page.html',
      ]);
      const t = [win([tab('https://a/')])];
      await applyLayout(b, t, { mode: 'match-exactly' });
      expect(urls(b.windows[0])).toEqual([
        'https://a/',
        'brave://settings/',
        'chrome-extension://x/page.html',
      ]);
    });

    it('closes surplus windows only when asked', async () => {
      b.addWindow(['https://a/']);
      b.addWindow(['https://unrelated/']);
      await applyLayout(b, [win([tab('https://a/')])], { mode: 'match-exactly' });
      expect(b.windows).toHaveLength(2);
      await applyLayout(b, [win([tab('https://a/')])], {
        mode: 'match-exactly',
        closeSurplusWindows: true,
      });
      expect(b.windows).toHaveLength(1);
    });

    it('never closes a window’s last tab before its replacement exists', async () => {
      b.addWindow(['https://old/']);
      const t = [win([tab('https://new/')])];
      await applyLayout(b, t, { mode: 'match-exactly' });
      // The old window had no overlap, so the new tab got a new window and the old one is surplus.
      expect(b.windows.map(urls)).toEqual([['https://old/'], ['https://new/']]);
      expect(b.ops.indexOf('removeTab')).toBe(-1);
    });

    it('activates the snapshot’s active tab when the user’s active tab was closed', async () => {
      b.addWindow(['https://extra/', 'https://a/']);
      await applyLayout(b, [win([tab('https://a/'), tab('https://b/', { active: true })])], {
        mode: 'match-exactly',
      });
      expect(b.windows[0]!.tabs.find((t) => t.active)!.url).toBe('https://b/');
    });
  });

  it('matches windows by content, creating extra target windows', async () => {
    b.addWindow(['https://w2a/', 'https://w2b/']);
    b.addWindow(['https://w1a/']);
    const t = [
      win([tab('https://w1a/'), tab('https://w1b/')]),
      win([tab('https://w2a/')]),
      win([tab('https://w3/')]),
    ];
    await applyLayout(b, t, { mode: 'match-exactly' });
    expect(b.windows.map(urls)).toEqual([
      ['https://w2a/'],
      ['https://w1a/', 'https://w1b/'],
      ['https://w3/'],
    ]);
  });

  it('opens a New Tab placeholder as the browser’s New Tab page', async () => {
    b.addWindow(['https://a/']);
    await applyLayout(b, [win([tab('https://a/')]), win([tab(NEW_TAB_URL, { active: true })])], {
      mode: 'add-missing',
    });
    expect(urls(b.windows[1])).toEqual([NEW_TAB_URL]);
  });

  it('leaves an already-matching window untouched', async () => {
    const w = b.addWindow(['https://a/', 'https://b/']);
    b.addGroup([w.tabs[1]!.id], { title: 'G', color: 'red' });
    await applyLayout(b, await layout(), { mode: 'match-exactly' });
    expect(b.ops).toEqual([]);
  });

  it('leaves out a tab the browser refuses to open and applies the rest', async () => {
    b.addWindow(['https://a/']);
    b.refusedUrls.add('javascript:void(0)');
    const t = [
      win(
        [
          tab('https://a/'),
          tab('javascript:void(0)', { groupKey: 'g' }),
          tab('https://c/', { groupKey: 'g' }),
        ],
        [group('g', { title: 'G' })],
      ),
      win([tab('javascript:void(0)', { active: true }), tab('https://second/')]),
    ];
    const { skipped } = await applyLayout(b, t, { mode: 'match-exactly' });
    expect(skipped).toEqual(['javascript:void(0)', 'javascript:void(0)']);
    expect(b.windows.map(urls)).toEqual([['https://a/', 'https://c/'], ['https://second/']]);
    expect(b.groups.map((g) => g.title)).toEqual(['G']);
    expect(b.windows[1]!.tabs[0]!.active).toBe(true);
  });

  it('handles 200+ tabs, all unloaded except the active one', async () => {
    b.addWindow(['chrome://newtab/']);
    const many = Array.from({ length: 220 }, (_, i) =>
      tab(`https://site.example/${i}`, { active: i === 100 }),
    );
    const t = [win(many)];
    const started = performance.now();
    await applyLayout(b, t, { mode: 'add-missing' });
    expect(performance.now() - started).toBeLessThan(2_000);
    await expectMatches(t);
    expect(b.windows[0]!.tabs.filter((x) => !x.discarded)).toHaveLength(1);
  });
});
