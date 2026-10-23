import { describe, expect, it } from 'vitest';
import { matchTabs, matchWindows } from './matching';

const tabs = (...urls: string[]) => urls.map((url) => ({ url }));

describe('matchTabs', () => {
  it('pairs identical URLs', () => {
    expect(matchTabs(tabs('a', 'b', 'c'), tabs('c', 'a'))).toEqual({
      matches: [
        { current: 2, target: 0 },
        { current: 0, target: 1 },
      ],
      unmatchedCurrent: [1],
      unmatchedTarget: [],
    });
  });

  it('counts duplicates separately, pairing in strip order', () => {
    const result = matchTabs(
      tabs('https://x/', 'https://y/', 'https://x/'),
      tabs('https://x/', 'https://x/', 'https://x/'),
    );
    expect(result.matches).toEqual([
      { current: 0, target: 0 },
      { current: 2, target: 1 },
    ]);
    expect(result.unmatchedTarget).toEqual([2]);
    expect(result.unmatchedCurrent).toEqual([1]);
  });

  it('matches through normalization (fragment, tracking params)', () => {
    const result = matchTabs(tabs('https://a/p#one'), tabs('https://a/p?utm_source=x'));
    expect(result.matches).toEqual([{ current: 0, target: 0 }]);
  });

  it('prefers exact matches before normalized ones', () => {
    const result = matchTabs(
      tabs('https://a/#x', 'https://a/#y'),
      tabs('https://a/#y', 'https://a/#x'),
    );
    expect(result.matches).toEqual([
      { current: 1, target: 0 },
      { current: 0, target: 1 },
    ]);
  });

  it('handles empty inputs', () => {
    expect(matchTabs([], tabs('a'))).toEqual({
      matches: [],
      unmatchedCurrent: [],
      unmatchedTarget: [0],
    });
  });
});

describe('matchWindows', () => {
  const w = (...urls: string[]) => ({ tabs: tabs(...urls) });

  it('pairs windows by greatest overlap regardless of order', () => {
    const current = [w('a', 'b'), w('x', 'y', 'z')];
    const target = [w('x', 'y'), w('a', 'b', 'c')];
    expect(matchWindows(current, target)).toEqual({
      matches: [
        { current: 1, target: 0, overlap: 2 },
        { current: 0, target: 1, overlap: 2 },
      ],
      unmatchedTarget: [],
      unmatchedCurrent: [],
    });
  });

  it('gives a contested window to the strongest overlap', () => {
    const current = [w('a', 'b', 'c')];
    const target = [w('a'), w('a', 'b', 'c')];
    const result = matchWindows(current, target);
    expect(result.matches).toEqual([{ current: 0, target: 1, overlap: 3 }]);
    expect(result.unmatchedTarget).toEqual([0]);
  });

  it('never pairs windows with no shared tabs', () => {
    const result = matchWindows([w('chrome://newtab/')], [w('a', 'b')]);
    expect(result.matches).toEqual([]);
    expect(result.unmatchedTarget).toEqual([0]);
    expect(result.unmatchedCurrent).toEqual([0]);
  });

  it('reports extra target windows and surplus current windows', () => {
    const result = matchWindows([w('a'), w('q')], [w('a'), w('b'), w('c')]);
    expect(result.matches).toEqual([{ current: 0, target: 0, overlap: 1 }]);
    expect(result.unmatchedTarget).toEqual([1, 2]);
    expect(result.unmatchedCurrent).toEqual([1]);
  });
});
