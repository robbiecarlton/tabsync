import type { SnapshotReason } from './types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
export const MONTH = 30 * DAY;
export const YEAR = 365 * DAY;

/**
 * Weekly slots run one week past a year so the "1 year ago" restore label can resolve
 * (PLAN.md D6). Snapshots older than this are deleted.
 */
export const MAX_RETENTION_AGE = YEAR + WEEK;

/** `pre-restore` snapshots younger than this are never pruned, so a restore is undoable. */
export const PRE_RESTORE_PROTECTION = 30 * DAY;

export interface RetentionTier {
  /** Exclusive upper bound of the age range this tier covers. */
  maxAge: number;
  slot: number;
}

export const RETENTION_TIERS: readonly RetentionTier[] = [
  { maxAge: HOUR, slot: MINUTE },
  { maxAge: DAY, slot: HOUR },
  { maxAge: MONTH, slot: DAY },
  { maxAge: MAX_RETENTION_AGE, slot: WEEK },
];

/** The epoch was a Thursday; shifting by 3 days makes weekly slots start Monday 00:00 UTC. */
const WEEK_ALIGNMENT = 3 * DAY;

export interface RetentionEntry {
  id: string;
  /** Epoch milliseconds. */
  createdAt: number;
  kind: SnapshotReason;
}

/** Tier covering a snapshot of the given age (future timestamps count as age 0), or null. */
export function tierForAge(age: number): RetentionTier | null {
  return RETENTION_TIERS.find((t) => Math.max(0, age) < t.maxAge) ?? null;
}

/**
 * Identifies the slot a snapshot falls in at time `now`, or null once it is past retention.
 * Slots are aligned to UTC clock boundaries (minute, hour, day, Monday-start week) so they
 * don't drift as `now` advances.
 */
export function slotKey(createdAt: number, now: number): string | null {
  const tierIndex = RETENTION_TIERS.findIndex((t) => Math.max(0, now - createdAt) < t.maxAge);
  if (tierIndex < 0) return null;
  const { slot } = RETENTION_TIERS[tierIndex]!;
  const offset = slot === WEEK ? WEEK_ALIGNMENT : 0;
  return `${tierIndex}:${Math.floor((createdAt + offset) / slot)}`;
}

function newestFirst<T extends { createdAt: number; id?: string }>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) => b.createdAt - a.createdAt || String(b.id ?? '').localeCompare(String(a.id ?? '')),
  );
}

export interface PruneOptions {
  /** Extra IDs never to delete, e.g. the server's latest by receipt time. */
  protectedIds?: Iterable<string>;
}

/**
 * Returns the IDs to delete. In each slot the newest snapshot is kept and the rest deleted;
 * snapshots past retention are deleted. Never deleted: the newest snapshot, `pre-restore`
 * snapshots younger than PRE_RESTORE_PROTECTION, and `protectedIds`. A protected snapshot
 * still occupies its slot if it is the newest there.
 */
export function selectForPruning(
  entries: readonly RetentionEntry[],
  now: number,
  options: PruneOptions = {},
): string[] {
  const sorted = newestFirst(entries);
  const protectedIds = new Set(options.protectedIds);
  if (sorted[0]) protectedIds.add(sorted[0].id);

  const seenSlots = new Set<string>();
  const toDelete: string[] = [];
  for (const e of sorted) {
    const isProtected =
      protectedIds.has(e.id) ||
      (e.kind === 'pre-restore' && now - e.createdAt < PRE_RESTORE_PROTECTION);
    const key = slotKey(e.createdAt, now);
    const keepsSlot = key !== null && !seenSlots.has(key);
    if (key !== null) seenSlots.add(key);
    if (!keepsSlot && !isProtected) toDelete.push(e.id);
  }
  return toDelete;
}

export interface RestoreLabel {
  key: string;
  text: string;
  age: number;
}

export const RESTORE_LABELS: readonly RestoreLabel[] = [
  { key: '1m', text: '1 minute ago', age: MINUTE },
  { key: '10m', text: '10 minutes ago', age: 10 * MINUTE },
  { key: '1h', text: '1 hour ago', age: HOUR },
  { key: '1d', text: '1 day ago', age: DAY },
  { key: '3d', text: '3 days ago', age: 3 * DAY },
  { key: '1w', text: '1 week ago', age: WEEK },
  { key: '1mo', text: '1 month ago', age: MONTH },
  { key: '1y', text: '1 year ago', age: YEAR },
];

export interface RestorePoint<T> {
  label: RestoreLabel;
  entry: T;
}

/**
 * For each label, the newest snapshot at least that old. Labels with no qualifying snapshot
 * are omitted, as are labels resolving to a snapshot an earlier (younger) label already shows.
 */
export function resolveRestorePoints<T extends { createdAt: number; id: string }>(
  entries: readonly T[],
  now: number,
  labels: readonly RestoreLabel[] = RESTORE_LABELS,
): RestorePoint<T>[] {
  const sorted = newestFirst(entries);
  const used = new Set<string>();
  const points: RestorePoint<T>[] = [];
  for (const label of labels) {
    const entry = sorted.find((e) => e.createdAt <= now - label.age);
    if (!entry || used.has(entry.id)) continue;
    used.add(entry.id);
    points.push({ label, entry });
  }
  return points;
}
