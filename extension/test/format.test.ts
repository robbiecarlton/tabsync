import { describe, expect, it } from 'vitest';
import { timeAgo } from '../src/ui/format';

describe('timeAgo', () => {
  const now = 10_000_000_000;
  it.each([
    [undefined, 'never'],
    [now - 10_000, 'just now'],
    [now + 5_000, 'just now'],
    [now - 5 * 60_000, '5 min ago'],
    [now - 3 * 3_600_000, '3 h ago'],
    [now - 26 * 3_600_000, '1 day ago'],
    [now - 5 * 86_400_000, '5 days ago'],
  ])('%s → %s', (at, text) => {
    expect(timeAgo(at, now)).toBe(text);
  });
});
