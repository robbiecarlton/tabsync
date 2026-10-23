import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { selectForPruning, type SnapshotReason } from '@tabsync/shared';
import type { Db } from './db/client';
import { profiles, snapshots, type SnapshotRow } from './db/schema';

export type SnapshotMeta = Omit<SnapshotRow, 'blob' | 'profileId'>;

const metaColumns = {
  id: snapshots.id,
  createdAt: snapshots.createdAt,
  receivedAt: snapshots.receivedAt,
  kind: snapshots.kind,
  sizeBytes: snapshots.sizeBytes,
};

export async function findProfile(db: Db, id: string) {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, id));
  return row;
}

/** Inserts the profile unless it exists; returns the stored row and whether it was created. */
export async function registerProfile(db: Db, id: string, tokenHash: string) {
  const inserted = await db
    .insert(profiles)
    .values({ id, tokenHash })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { profile: inserted[0], created: true };
  return { profile: (await findProfile(db, id))!, created: false };
}

/** Newest snapshot by receipt time, ignoring pre-restore snapshots (PLAN.md D2, D3). */
export async function latestSnapshot(db: Db, profileId: string): Promise<SnapshotRow | undefined> {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.profileId, profileId), ne(snapshots.kind, 'pre-restore')))
    .orderBy(desc(snapshots.receivedAt), desc(snapshots.createdAt), desc(snapshots.id))
    .limit(1);
  return row;
}

export async function latestSnapshotId(db: Db, profileId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(and(eq(snapshots.profileId, profileId), ne(snapshots.kind, 'pre-restore')))
    .orderBy(desc(snapshots.receivedAt), desc(snapshots.createdAt), desc(snapshots.id))
    .limit(1);
  return row?.id;
}

/** All snapshot metadata for the profile, newest (by createdAt) first. */
export function listSnapshots(db: Db, profileId: string): Promise<SnapshotMeta[]> {
  return db
    .select(metaColumns)
    .from(snapshots)
    .where(eq(snapshots.profileId, profileId))
    .orderBy(desc(snapshots.createdAt), desc(snapshots.id));
}

export async function getSnapshot(db: Db, profileId: string, id: string) {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.profileId, profileId), eq(snapshots.id, id)));
  return row;
}

export interface NewSnapshot {
  id: string;
  profileId: string;
  createdAt: Date;
  receivedAt: Date;
  kind: SnapshotReason;
  blob: Uint8Array;
}

export type InsertResult =
  | { status: 'created'; row: SnapshotMeta }
  | { status: 'exists'; row: SnapshotMeta }
  | { status: 'conflict' };

/** Inserts a snapshot. Re-uploading an ID already stored for this profile is a no-op. */
export async function insertSnapshot(db: Db, s: NewSnapshot): Promise<InsertResult> {
  const [created] = await db
    .insert(snapshots)
    .values({ ...s, sizeBytes: s.blob.length })
    .onConflictDoNothing()
    .returning(metaColumns);
  if (created) return { status: 'created', row: created };
  const [existing] = await db
    .select({ ...metaColumns, profileId: snapshots.profileId })
    .from(snapshots)
    .where(eq(snapshots.id, s.id));
  if (!existing || existing.profileId !== s.profileId) return { status: 'conflict' };
  const { profileId: _p, ...row } = existing;
  return { status: 'exists', row };
}

/** Applies the retention schedule to one profile. Returns the number of snapshots deleted. */
export async function pruneProfile(db: Db, profileId: string, now: number): Promise<number> {
  return db.transaction(async (tx) => {
    const entries = await tx
      .select({ id: snapshots.id, createdAt: snapshots.createdAt, kind: snapshots.kind })
      .from(snapshots)
      .where(eq(snapshots.profileId, profileId));
    const latest = await latestSnapshotId(tx as unknown as Db, profileId);
    const toDelete = selectForPruning(
      entries.map((e) => ({
        id: e.id,
        createdAt: e.createdAt.getTime(),
        kind: e.kind as SnapshotReason,
      })),
      now,
      { protectedIds: latest ? [latest] : [] },
    );
    if (toDelete.length > 0) {
      await tx.delete(snapshots).where(inArray(snapshots.id, toDelete));
    }
    return toDelete.length;
  });
}

/** Daily sweep: prunes every profile. Returns the total deleted. */
export async function pruneAll(db: Db, now: number): Promise<number> {
  const rows = await db.select({ id: profiles.id }).from(profiles);
  let total = 0;
  for (const { id } of rows) total += await pruneProfile(db, id, now);
  return total;
}
