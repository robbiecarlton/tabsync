import { describe, expect, it } from 'vitest';
import { canonicalLayout, fingerprint } from './fingerprint';
import { group, tab, win } from './testing/fixtures';
import type { SnapWindow } from './types';

const base = (): SnapWindow[] => [
  win(
    [
      tab('https://pinned/', { pinned: true }),
      tab('https://a/', { groupKey: 'g1' }),
      tab('https://b/', { groupKey: 'g1', active: true }),
      tab('https://c/'),
    ],
    [group('g1', { title: 'Work', color: 'red' })],
    { focused: true },
  ),
  win([tab('https://d/')]),
];

const changed = async (mutate: (w: SnapWindow[]) => void) => {
  const w = base();
  mutate(w);
  return (await fingerprint(w)) !== (await fingerprint(base()));
};

describe('fingerprint', () => {
  it('is a 64-char hex digest and deterministic', async () => {
    const fp = await fingerprint(base());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint(base())).toBe(fp);
  });

  it.each<[string, (w: SnapWindow[]) => void]>([
    ['a tab title', (w) => (w[0]!.tabs[1]!.title = 'New title')],
    ['a favicon', (w) => (w[0]!.tabs[1]!.favIconUrl = 'https://x/f.ico')],
    [
      'the active tab',
      (w) => {
        w[0]!.tabs[2]!.active = false;
        w[0]!.tabs[3]!.active = true;
      },
    ],
    [
      'window focus',
      (w) => {
        w[0]!.focused = false;
        w[1]!.focused = true;
      },
    ],
    [
      'window bounds and state',
      (w) => {
        w[0]!.bounds = { left: 1, top: 2, width: 3, height: 4 };
        w[0]!.state = 'maximized';
      },
    ],
    [
      'group keys',
      (w) => {
        w[0]!.groups[0]!.key = 'zz';
        w[0]!.tabs[1]!.groupKey = 'zz';
        w[0]!.tabs[2]!.groupKey = 'zz';
      },
    ],
    ['an unreferenced group', (w) => w[1]!.groups.push(group('unused'))],
  ])('ignores %s', async (_name, mutate) => {
    expect(await changed(mutate)).toBe(false);
  });

  it.each<[string, (w: SnapWindow[]) => void]>([
    ['a URL', (w) => (w[0]!.tabs[3]!.url = 'https://c/other')],
    ['tab order', (w) => w[0]!.tabs.reverse()],
    ['a new tab', (w) => w[1]!.tabs.push(tab('https://e/'))],
    ['a closed tab', (w) => w[0]!.tabs.pop()],
    ['pinned state', (w) => (w[0]!.tabs[3]!.pinned = true)],
    ['group membership', (w) => (w[0]!.tabs[3]!.groupKey = 'g1')],
    ['group title', (w) => (w[0]!.groups[0]!.title = 'Play')],
    ['group colour', (w) => (w[0]!.groups[0]!.color = 'blue')],
    ['group collapsed', (w) => (w[0]!.groups[0]!.collapsed = true)],
    ['window order', (w) => w.reverse()],
    ['moving a tab between windows', (w) => w[1]!.tabs.push(w[0]!.tabs.pop()!)],
  ])('changes with %s', async (_name, mutate) => {
    expect(await changed(mutate)).toBe(true);
  });

  it('distinguishes two adjacent groups from one merged group', () => {
    const two = win(
      [tab('https://a/', { groupKey: 'g1' }), tab('https://b/', { groupKey: 'g2' })],
      [group('g1', { title: 'X' }), group('g2', { title: 'X' })],
    );
    const one = win(
      [tab('https://a/', { groupKey: 'g1' }), tab('https://b/', { groupKey: 'g1' })],
      [group('g1', { title: 'X' })],
    );
    expect(canonicalLayout([two])).not.toBe(canonicalLayout([one]));
  });
});
