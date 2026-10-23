import { describe, expect, it } from 'vitest';
import { captureLayout, type BrowserTab, type BrowserWindow } from '../src/lib/capture';

const tab = (index: number, url: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  index,
  url,
  title: url,
  pinned: false,
  active: false,
  groupId: -1,
  ...extra,
});

const win = (tabs: BrowserTab[], extra: Partial<BrowserWindow> = {}): BrowserWindow => ({
  incognito: false,
  type: 'normal',
  focused: false,
  tabs,
  ...extra,
});

describe('captureLayout', () => {
  it('maps tabs in strip order, dropping browser IDs', () => {
    const [w] = captureLayout(
      [
        win(
          [
            tab(1, 'https://b/'),
            tab(0, 'https://a/', { pinned: true, active: true, favIconUrl: 'https://a/f.ico' }),
          ],
          {
            focused: true,
            state: 'maximized',
            left: 1,
            top: 2,
            width: 300,
            height: 200,
          },
        ),
      ],
      [],
    );
    expect(w).toEqual({
      focused: true,
      state: 'maximized',
      bounds: { left: 1, top: 2, width: 300, height: 200 },
      groups: [],
      tabs: [
        {
          url: 'https://a/',
          title: 'https://a/',
          pinned: true,
          active: true,
          favIconUrl: 'https://a/f.ico',
        },
        { url: 'https://b/', title: 'https://b/', pinned: false, active: false },
      ],
    });
  });

  it('keys groups per window in order of first appearance', () => {
    const [w] = captureLayout(
      [
        win([
          tab(0, 'https://a/', { groupId: 42 }),
          tab(1, 'https://b/', { groupId: 42 }),
          tab(2, 'https://c/', { groupId: 7 }),
          tab(3, 'https://d/'),
        ]),
      ],
      [
        { id: 7, title: 'Later', color: 'green', collapsed: true },
        { id: 42, title: 'Work', color: 'red', collapsed: false },
      ],
    );
    expect(w!.groups).toEqual([
      { key: 'g1', title: 'Work', color: 'red', collapsed: false },
      { key: 'g2', title: 'Later', color: 'green', collapsed: true },
    ]);
    expect(w!.tabs.map((t) => t.groupKey)).toEqual(['g1', 'g1', 'g2', undefined]);
  });

  it('treats an untitled group as an empty title and ignores unknown group IDs', () => {
    const [w] = captureLayout(
      [win([tab(0, 'https://a/', { groupId: 1 }), tab(1, 'https://b/', { groupId: 99 })])],
      [{ id: 1, color: 'blue', collapsed: false }],
    );
    expect(w!.groups[0]!.title).toBe('');
    expect(w!.tabs[1]!.groupKey).toBeUndefined();
  });

  it('uses pendingUrl for a tab still loading', () => {
    const [w] = captureLayout([win([tab(0, '', { pendingUrl: 'https://loading/' })])], []);
    expect(w!.tabs[0]!.url).toBe('https://loading/');
  });

  it('skips private and non-normal windows', () => {
    const result = captureLayout(
      [
        win([tab(0, 'https://private/')], { incognito: true }),
        win([tab(0, 'https://popup/')], { type: 'popup' }),
        win([tab(0, 'https://normal/')]),
      ],
      [],
    );
    expect(result.map((w) => w.tabs[0]!.url)).toEqual(['https://normal/']);
  });

  it('applies the capture rules (exclusions, empty windows)', () => {
    const result = captureLayout(
      [
        win([tab(0, 'brave://settings/')]),
        win([tab(0, 'https://a/'), tab(1, 'chrome://extensions/')]),
      ],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.tabs.map((t) => t.url)).toEqual(['https://a/']);
  });

  it('preserves duplicate URLs', () => {
    const [w] = captureLayout([win([tab(0, 'https://a/'), tab(1, 'https://a/')])], []);
    expect(w!.tabs).toHaveLength(2);
  });
});
