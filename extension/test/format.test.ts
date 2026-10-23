import { describe, expect, it } from 'vitest';
import { formatWhen, timeAgo } from '../src/ui/format';

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

describe('formatWhen', () => {
  // Local-time dates so the test is independent of the machine's time zone.
  const now = new Date(2026, 9, 22, 15, 0).getTime(); // Thu 22 Oct 2026

  it('shows just the time for today', () => {
    expect(formatWhen(new Date(2026, 9, 22, 9, 5).getTime(), now, 'en-GB')).toBe('09:05');
  });

  it('shows the weekday within the last week', () => {
    expect(formatWhen(new Date(2026, 9, 20, 14, 32).getTime(), now, 'en-GB')).toBe('Tue 14:32');
  });

  it('shows the date for older snapshots, with the year if different', () => {
    expect(formatWhen(new Date(2026, 9, 1, 8, 0).getTime(), now, 'en-GB')).toBe('1 Oct 08:00');
    expect(formatWhen(new Date(2025, 11, 24, 8, 0).getTime(), now, 'en-GB')).toBe(
      '24 Dec 2025 08:00',
    );
  });
});
