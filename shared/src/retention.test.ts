import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MAX_RETENTION_AGE,
  MINUTE,
  MONTH,
  RESTORE_LABELS,
  resolveRestorePoints,
  selectForPruning,
  slotKey,
  tierForAge,
  WEEK,
  YEAR,
  type RetentionEntry,
} from './retention';

const NOW = Date.UTC(2026, 9, 21, 15, 0, 0); // Wednesday 2026-10-21 15:00 UTC

let seq = 0;
const entry = (createdAt: number, kind: RetentionEntry['kind'] = 'auto'): RetentionEntry => ({
  id: `s${++seq}`,
  createdAt,
  kind,
});

describe('slotKey', () => {
  it('aligns minute slots to UTC minute boundaries', () => {
    const a = slotKey(Date.UTC(2026, 9, 21, 14, 30, 0), NOW);
    expect(slotKey(Date.UTC(2026, 9, 21, 14, 30, 59, 999), NOW)).toBe(a);
    expect(slotKey(Date.UTC(2026, 9, 21, 14, 31, 0), NOW)).not.toBe(a);
  });

  it('aligns hour and day slots to UTC boundaries', () => {
    expect(slotKey(Date.UTC(2026, 9, 21, 9, 0), NOW)).toBe(
      slotKey(Date.UTC(2026, 9, 21, 9, 59), NOW),
    );
    expect(slotKey(Date.UTC(2026, 9, 21, 9, 59), NOW)).not.toBe(
      slotKey(Date.UTC(2026, 9, 21, 10, 0), NOW),
    );
    expect(slotKey(Date.UTC(2026, 9, 10, 0, 0), NOW)).toBe(
      slotKey(Date.UTC(2026, 9, 10, 23, 59), NOW),
    );
    expect(slotKey(Date.UTC(2026, 9, 10, 23, 59), NOW)).not.toBe(
      slotKey(Date.UTC(2026, 9, 11, 0, 0), NOW),
    );
  });

  it('starts weekly slots on Monday 00:00 UTC', () => {
    const monday = Date.UTC(2026, 5, 1); // 2026-06-01 is a Monday
    expect(slotKey(monday, NOW)).toBe(slotKey(monday + WEEK - 1, NOW));
    expect(slotKey(monday - 1, NOW)).not.toBe(slotKey(monday, NOW));
  });

  it('is stable as now advances within a tier', () => {
    const t = Date.UTC(2026, 9, 21, 14, 30, 10);
    expect(slotKey(t, NOW)).toBe(slotKey(t, NOW + 10 * MINUTE));
  });

  it('returns null past retention, and treats future timestamps as age 0', () => {
    expect(slotKey(NOW - MAX_RETENTION_AGE, NOW)).toBeNull();
    expect(slotKey(NOW + 5 * MINUTE, NOW)).not.toBeNull();
  });

  it('maps ages to tiers', () => {
    expect(tierForAge(30 * MINUTE)!.slot).toBe(MINUTE);
    expect(tierForAge(5 * HOUR)!.slot).toBe(HOUR);
    expect(tierForAge(10 * DAY)!.slot).toBe(DAY);
    expect(tierForAge(200 * DAY)!.slot).toBe(WEEK);
    expect(tierForAge(YEAR + 2 * WEEK)).toBeNull();
  });
});

describe('selectForPruning', () => {
  it('keeps the newest snapshot in each slot', () => {
    const older = entry(Date.UTC(2026, 9, 21, 14, 30, 5));
    const newer = entry(Date.UTC(2026, 9, 21, 14, 30, 50));
    const other = entry(Date.UTC(2026, 9, 21, 14, 31, 0));
    expect(selectForPruning([older, newer, other], NOW)).toEqual([older.id]);
  });

  it('thins older snapshots by their tier', () => {
    const a = entry(Date.UTC(2026, 9, 21, 9, 10));
    const b = entry(Date.UTC(2026, 9, 21, 9, 40));
    const c = entry(Date.UTC(2026, 9, 5, 8, 0));
    const d = entry(Date.UTC(2026, 9, 5, 20, 0));
    expect(selectForPruning([a, b, c, d], NOW).sort()).toEqual([a.id, c.id].sort());
  });

  it('deletes snapshots past retention', () => {
    const recent = entry(NOW - MINUTE);
    const ancient = entry(NOW - MAX_RETENTION_AGE - DAY);
    expect(selectForPruning([recent, ancient], NOW)).toEqual([ancient.id]);
  });

  it('never deletes the newest snapshot, however old', () => {
    const only = entry(NOW - 2 * YEAR);
    expect(selectForPruning([only], NOW)).toEqual([]);
  });

  it('protects pre-restore snapshots for 30 days', () => {
    const keeper = entry(Date.UTC(2026, 9, 10, 20, 0));
    const preRestore = entry(Date.UTC(2026, 9, 10, 8, 0), 'pre-restore');
    const oldPreRestore = entry(NOW - MONTH - 2 * WEEK, 'pre-restore');
    const oldKeeper = entry(oldPreRestore.createdAt + 1);
    const newest = entry(NOW);
    expect(selectForPruning([keeper, preRestore, oldPreRestore, oldKeeper, newest], NOW)).toEqual([
      oldPreRestore.id,
    ]);
  });

  it('lets a protected snapshot occupy its slot', () => {
    const preRestore = entry(Date.UTC(2026, 9, 10, 20, 0), 'pre-restore');
    const auto = entry(Date.UTC(2026, 9, 10, 8, 0));
    expect(selectForPruning([preRestore, auto, entry(NOW)], NOW)).toEqual([auto.id]);
  });

  it('honours extra protected IDs', () => {
    const a = entry(Date.UTC(2026, 9, 10, 8, 0));
    const b = entry(Date.UTC(2026, 9, 10, 20, 0));
    expect(selectForPruning([a, b], NOW, { protectedIds: [a.id] })).toEqual([]);
  });
});

describe('resolveRestorePoints', () => {
  it('picks the newest snapshot at least as old as each label', () => {
    const entries = [
      entry(NOW - 30 * 1000),
      entry(NOW - 2 * MINUTE),
      entry(NOW - 15 * MINUTE),
      entry(NOW - 2 * HOUR),
      entry(NOW - 26 * HOUR),
    ];
    const points = resolveRestorePoints(entries, NOW);
    expect(points.map((p) => [p.label.key, p.entry.id])).toEqual([
      ['1m', entries[1]!.id],
      ['10m', entries[2]!.id],
      ['1h', entries[3]!.id],
      ['1d', entries[4]!.id],
    ]);
  });

  it('hides labels with no qualifying snapshot and labels repeating an earlier pick', () => {
    const entries = [entry(NOW - 5 * DAY)];
    const points = resolveRestorePoints(entries, NOW);
    expect(points.map((p) => p.label.key)).toEqual(['1m']);
  });

  it('returns nothing for no history', () => {
    expect(resolveRestorePoints([], NOW)).toEqual([]);
  });
});

/** Deterministic PRNG (mulberry32) so the simulation is reproducible. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Irregular use: most weekdays, some weekends, sessions of varying length, bursts of edits. */
function simulateUsage(start: number, days: number, random: () => number): RetentionEntry[] {
  const out: RetentionEntry[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    const dayStart = start + d * DAY;
    const weekday = new Date(dayStart).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    if (random() > (weekend ? 0.3 : 0.85)) continue;
    let t = dayStart + (7 + random() * 4) * HOUR;
    const end = dayStart + (16 + random() * 7) * HOUR;
    while (t < end) {
      const kind = random() < 0.005 ? 'pre-restore' : 'auto';
      out.push({ id: `sim${++n}`, createdAt: Math.round(t), kind });
      t += (0.5 + random() * random() * 40) * MINUTE;
    }
  }
  return out;
}

describe('a simulated year of snapshots', () => {
  const start = Date.UTC(2025, 8, 1);
  const all = simulateUsage(start, 420, prng(42));

  // Run the server's behaviour: prune after every insert.
  const stored = new Map<string, RetentionEntry>();
  const checkpoints: { now: number; kept: RetentionEntry[] }[] = [];
  let nextCheckpoint = start + 60 * DAY;
  for (const e of all) {
    stored.set(e.id, e);
    for (const id of selectForPruning([...stored.values()], e.createdAt)) stored.delete(id);
    if (e.createdAt >= nextCheckpoint) {
      checkpoints.push({ now: e.createdAt + 30 * 1000, kept: [...stored.values()] });
      nextCheckpoint += 23 * DAY + 7 * HOUR;
    }
  }
  const finalNow = all.at(-1)!.createdAt + 30 * 1000;
  checkpoints.push({ now: finalNow, kept: [...stored.values()] });

  it('generates a realistic volume of history', () => {
    expect(all.length).toBeGreaterThan(5000);
  });

  it('prunes to roughly 170 snapshots', () => {
    const recentPreRestores = [...stored.values()].filter(
      (e) => e.kind === 'pre-restore' && finalNow - e.createdAt < 30 * DAY,
    ).length;
    // At most 60 minute + 24 hour + 30 day + 53 week slots, plus protected pre-restores.
    // Irregular use leaves many slots empty, so the real count is lower.
    expect(stored.size).toBeGreaterThan(60);
    expect(stored.size).toBeLessThanOrEqual(167 + recentPreRestores);
  });

  it('keeps nothing past retention except possibly the newest', () => {
    for (const e of stored.values()) {
      expect(finalNow - e.createdAt).toBeLessThan(MAX_RETENTION_AGE);
    }
  });

  // "Close" is measured in browsing activity, not wall-clock time: the label may land before an
  // idle gap (e.g. a weekend) when the first minutes after the gap shared a slot with a newer
  // snapshot that is now too young. What must hold is that all history skipped between the
  // answer and the ideal answer fits within one retention slot.
  it.each(checkpoints.map((c, i) => [i, c] as const))(
    'resolves every label to within one slot of activity of the ideal (checkpoint %i)',
    (_i, { now, kept }) => {
      const history = all.filter((e) => e.createdAt <= now);
      let resolved = 0;
      for (const label of RESTORE_LABELS) {
        const cutoff = now - label.age;
        const idealEntry = history.filter((e) => e.createdAt <= cutoff).at(-1);
        if (!idealEntry || now - idealEntry.createdAt >= MAX_RETENTION_AGE) continue;
        const [point] = resolveRestorePoints(kept, now, [label]);
        expect(point, `label ${label.key}`).toBeDefined();
        const got = point!.entry;
        expect(got.createdAt).toBeLessThanOrEqual(cutoff);
        resolved++;
        const firstSkipped = history.find((e) => e.createdAt > got.createdAt);
        if (!firstSkipped || firstSkipped.createdAt > idealEntry.createdAt) continue;
        const tolerance = tierForAge(now - firstSkipped.createdAt)!.slot;
        expect(
          idealEntry.createdAt - firstSkipped.createdAt,
          `label ${label.key}: skipped activity`,
        ).toBeLessThan(tolerance);
      }
      expect(resolved).toBeGreaterThan(0);
    },
  );

  it('offers the 1 year label once history is old enough', () => {
    const points = resolveRestorePoints([...stored.values()], finalNow);
    expect(points.map((p) => p.label.key)).toContain('1y');
  });
});
