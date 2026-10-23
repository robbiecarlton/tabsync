/** "just now", "5 min ago", "3 h ago", "2 days ago"; "never" when undefined. */
export function timeAgo(at: number | undefined, now: number): string {
  if (at === undefined) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

export const STATUS_TEXT = {
  'not-setup': 'Not set up',
  synced: 'Synced',
  pending: 'Changes waiting to sync',
  behind: 'Newer tabs available',
  conflict: 'Tabs changed on both devices',
  error: 'Sync error',
} as const;

/**
 * A snapshot's real time for the history list: "14:32" today, "Tue 14:32" within a week,
 * otherwise "12 Oct 14:32" (with the year if it differs).
 */
export function formatWhen(at: number, now: number, locale?: string): string {
  const d = new Date(at);
  const n = new Date(now);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return time;
  if (now - at < 6 * 86_400_000)
    return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  const date = d.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date} ${time}`;
}
