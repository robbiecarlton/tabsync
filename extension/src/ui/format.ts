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
  error: 'Sync error',
} as const;
