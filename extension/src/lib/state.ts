import type { Snapshot } from '@tabsync/shared';
import type { ApplyMode } from './reconcile';
import type { KeyValueStore } from './store';

export const DEFAULT_SERVER_URL = 'http://localhost:8787';

/** Per-device preferences. Kept on Disconnect. */
export interface Settings {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  /** Last choice for applying remote tabs; "add missing only" until changed. */
  applyMode: ApplyMode;
}

/** The profile secret, formatted. chrome.storage.local only, never sync. Cleared on Disconnect. */
export interface Credentials {
  secret: string;
}

export type ErrorKind = 'network' | 'auth' | 'server' | 'decrypt';

export interface SyncError {
  kind: ErrorKind;
  message: string;
  at: number;
}

/** Everything the background worker must remember across service-worker restarts. */
export interface SyncState {
  /** Snapshot this device last pushed or adopted (becomes parentSnapshotId). */
  baseSnapshotId?: string;
  /** Fingerprint of the layout last pushed or adopted; equal means nothing to push. */
  lastFingerprint?: string;
  /** Captured but not yet confirmed by the server; survives browser restarts. */
  pending?: Snapshot;
  /** Debounce markers: first and latest layout change since the last capture. */
  dirtySince?: number;
  lastChangeAt?: number;
  /**
   * Ignore tab events until this time, then fingerprint once: browser session restore, and
   * just after applying a snapshot (echo suppression).
   */
  settleUntil?: number;
  /** Latest snapshot seen on the server (decrypted), and its fingerprint. */
  remote?: Snapshot;
  remoteFingerprint?: string;
  lastPushAt?: number;
  lastPullAt?: number;
  lastError?: SyncError;
  /** When the current run of transient failures began. */
  failingSince?: number;
  retryAttempt?: number;
  nextRetryAt?: number;
}

const KEYS = { settings: 'settings', credentials: 'credentials', state: 'syncState' } as const;

export function defaultDeviceName(platform = (globalThis.navigator?.platform ?? '').toLowerCase()) {
  if (platform.includes('mac')) return 'Brave on Mac';
  if (platform.includes('win')) return 'Brave on Windows';
  if (platform.includes('linux')) return 'Brave on Linux';
  return 'Brave';
}

export class StateRepo {
  constructor(
    private readonly store: KeyValueStore,
    private readonly randomId: () => string = () => crypto.randomUUID(),
  ) {}

  async settings(): Promise<Settings> {
    const stored = await this.store.get<Partial<Settings>>(KEYS.settings);
    const settings: Settings = {
      serverUrl: stored?.serverUrl ?? DEFAULT_SERVER_URL,
      deviceId: stored?.deviceId ?? this.randomId(),
      deviceName: stored?.deviceName ?? defaultDeviceName(),
      applyMode: stored?.applyMode ?? 'add-missing',
    };
    if (!stored || Object.keys(settings).some((k) => stored[k as keyof Settings] === undefined)) {
      await this.store.set({ [KEYS.settings]: settings });
    }
    return settings;
  }

  async updateSettings(patch: Partial<Omit<Settings, 'deviceId'>>): Promise<Settings> {
    const next = { ...(await this.settings()), ...patch };
    await this.store.set({ [KEYS.settings]: next });
    return next;
  }

  credentials(): Promise<Credentials | undefined> {
    return this.store.get<Credentials>(KEYS.credentials);
  }

  async state(): Promise<SyncState> {
    return (await this.store.get<SyncState>(KEYS.state)) ?? {};
  }

  /** Writes a whole new state; `undefined` fields are dropped. */
  saveState(state: SyncState): Promise<void> {
    return this.store.set({ [KEYS.state]: state });
  }

  async patchState(patch: Partial<SyncState>): Promise<SyncState> {
    const next = { ...(await this.state()), ...patch };
    await this.saveState(next);
    return next;
  }

  async connect(credentials: Credentials, state: SyncState): Promise<void> {
    await this.store.set({ [KEYS.credentials]: credentials, [KEYS.state]: state });
  }

  disconnect(): Promise<void> {
    return this.store.remove([KEYS.credentials, KEYS.state]);
  }
}
