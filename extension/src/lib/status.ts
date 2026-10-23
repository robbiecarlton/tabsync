import { ERROR_AFTER_MS } from './schedule';
import type { SyncState } from './state';

export type SyncStatus = 'not-setup' | 'synced' | 'pending' | 'error';

export function computeStatus(setUp: boolean, state: SyncState, now: number): SyncStatus {
  if (!setUp) return 'not-setup';
  const err = state.lastError;
  if (err) {
    const persistent = err.kind === 'auth' || err.kind === 'decrypt' || err.kind === 'server';
    const longFailing =
      state.failingSince !== undefined && now - state.failingSince >= ERROR_AFTER_MS;
    if (persistent || longFailing) return 'error';
  }
  if (state.pending || state.dirtySince !== undefined) return 'pending';
  return 'synced';
}

export interface Badge {
  text: string;
  color: string;
  title: string;
}

/** Toolbar badge per SPEC.md "Toolbar badge". */
export function badgeFor(status: SyncStatus, errorMessage?: string): Badge {
  switch (status) {
    case 'not-setup':
      return { text: '', color: '#000000', title: 'Set up sync' };
    case 'synced':
      return { text: '●', color: '#1e8e3e', title: 'Tab Sync: synced' };
    case 'pending':
      return { text: '●', color: '#80868b', title: 'Tab Sync: changes waiting to sync' };
    case 'error':
      return {
        text: 'x',
        color: '#d93025',
        title: `Tab Sync: error${errorMessage ? ` – ${errorMessage}` : ''}`,
      };
  }
}
