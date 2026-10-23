import { ERROR_AFTER_MS } from './schedule';
import type { SyncState } from './state';

export type SyncStatus = 'not-setup' | 'synced' | 'pending' | 'behind' | 'conflict' | 'error';

/** A newer snapshot than this device's base is on the server. */
export function isBehind(state: SyncState): boolean {
  return state.remote !== undefined && state.remote.snapshotId !== state.baseSnapshotId;
}

/**
 * Both sides changed (SPEC.md decision 5): this device has edits it hasn't pushed since its base
 * snapshot, and the server has a newer snapshot it hasn't applied.
 */
export function isConflict(state: SyncState): boolean {
  const localEdits =
    state.localFingerprint !== undefined && state.localFingerprint !== state.lastFingerprint;
  return isBehind(state) && localEdits;
}

export function computeStatus(setUp: boolean, state: SyncState, now: number): SyncStatus {
  if (!setUp) return 'not-setup';
  const err = state.lastError;
  if (err) {
    const persistent = err.kind === 'auth' || err.kind === 'decrypt' || err.kind === 'server';
    const longFailing =
      state.failingSince !== undefined && now - state.failingSince >= ERROR_AFTER_MS;
    if (persistent || longFailing) return 'error';
  }
  if (isConflict(state)) return 'conflict';
  if (isBehind(state)) return 'behind';
  // Unsent changes, or a server that's currently unreachable (Error after ERROR_AFTER_MS).
  if (state.pending || state.dirtySince !== undefined || err?.kind === 'network') return 'pending';
  return 'synced';
}

export interface Badge {
  text: string;
  color: string;
  title: string;
}

/** Toolbar badge per SPEC.md "Toolbar badge". */
export function badgeFor(status: SyncStatus, detail?: string): Badge {
  switch (status) {
    case 'not-setup':
      return { text: '', color: '#000000', title: 'Set up sync' };
    case 'synced':
      return { text: '●', color: '#1e8e3e', title: 'Tab Sync: synced' };
    case 'pending':
      return { text: '●', color: '#80868b', title: 'Tab Sync: changes waiting to sync' };
    case 'conflict':
      return {
        text: '!',
        color: '#f9ab00',
        title: `Tab Sync: tabs changed here and on ${detail ?? 'another device'}`,
      };
    case 'behind':
      return {
        text: '!',
        color: '#1a73e8',
        title: `Tab Sync: ${detail ?? 'another device'} has newer tabs`,
      };
    case 'error':
      return {
        text: 'x',
        color: '#d93025',
        title: `Tab Sync: error${detail ? ` – ${detail}` : ''}`,
      };
  }
}
