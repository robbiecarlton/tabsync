import {
  decryptSnapshot,
  deriveProfileKeys,
  encryptSnapshot,
  fingerprint,
  formatSecret,
  fromBase64Url,
  generateSecret,
  InvalidSecretError,
  parseSecret,
  toBase64Url,
  FORMAT_VERSION,
  type ProfileKeys,
  type Snapshot,
  type SnapshotReason,
  type SnapWindow,
} from '@tabsync/shared';
import { ApiError, NetworkError, type Credentials as ApiCredentials, type SyncApi } from './api';
import type { BrowserApi } from './browser';
import { captureLayout } from './capture';
import type { Log } from './logger';
import { pushDueAt, retryDelay, SETTLE_MS } from './schedule';
import type { ErrorKind, Settings, StateRepo, SyncState } from './state';
import { badgeFor, computeStatus, type SyncStatus } from './status';

export interface EngineDeps {
  repo: StateRepo;
  browser: BrowserApi;
  createApi(serverUrl: string, creds: ApiCredentials): SyncApi;
  now(): number;
  randomId(): string;
  /** Runs `fn` after `ms`; returns a cancel function. In-memory only (lost if the worker sleeps). */
  setTimer(fn: () => void, ms: number): () => void;
  log: Log;
}

export interface StatusView {
  status: SyncStatus;
  settings: Settings;
  lastPushAt?: number;
  lastPullAt?: number;
  lastError?: { kind: ErrorKind; message: string; at: number };
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

interface Session {
  keys: ProfileKeys;
  api: SyncApi;
  settings: Settings;
}

function classify(err: unknown): { kind: ErrorKind; message: string; transient: boolean } {
  if (err instanceof NetworkError)
    return { kind: 'network', message: err.message, transient: true };
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return {
        kind: 'auth',
        message: 'The server rejected this profile’s credentials',
        transient: false,
      };
    }
    return {
      kind: err.transient ? 'network' : 'server',
      message: err.message,
      transient: err.transient,
    };
  }
  return {
    kind: 'server',
    message: err instanceof Error ? err.message : String(err),
    transient: false,
  };
}

/**
 * The background sync logic: capture, debounce, push, retry and status. All persistent state
 * lives in StateRepo so the service worker can be killed at any point and resume.
 */
export class SyncEngine {
  private queue: Promise<unknown> = Promise.resolve();
  private cancelTimer?: () => void;
  private timerAt?: number;
  private keyCache?: { secret: string; keys: ProfileKeys };

  constructor(private readonly deps: EngineDeps) {}

  /** Serializes all state-mutating work. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Resolves once all queued work has finished. */
  async idle(): Promise<void> {
    let current;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  private async session(): Promise<Session | undefined> {
    const creds = await this.deps.repo.credentials();
    if (!creds) return undefined;
    if (this.keyCache?.secret !== creds.secret) {
      this.keyCache = {
        secret: creds.secret,
        keys: await deriveProfileKeys(parseSecret(creds.secret)),
      };
    }
    const settings = await this.deps.repo.settings();
    const { keys } = this.keyCache;
    return { keys, settings, api: this.deps.createApi(settings.serverUrl, keys) };
  }

  private async capture(): Promise<SnapWindow[]> {
    const [windows, groups] = await Promise.all([
      this.deps.browser.getWindows(),
      this.deps.browser.getGroups(),
    ]);
    return captureLayout(windows, groups);
  }

  private buildSnapshot(
    windows: SnapWindow[],
    settings: Settings,
    state: SyncState,
    reason: SnapshotReason,
  ): Snapshot {
    const snapshot: Snapshot = {
      formatVersion: FORMAT_VERSION,
      snapshotId: this.deps.randomId(),
      createdAt: new Date(this.deps.now()).toISOString(),
      device: { id: settings.deviceId, name: settings.deviceName },
      reason,
      windows,
    };
    if (state.baseSnapshotId) snapshot.parentSnapshotId = state.baseSnapshotId;
    return snapshot;
  }

  /** Schedules a flush at `at` unless one is already scheduled sooner. */
  private schedule(at: number): void {
    if (this.timerAt !== undefined && this.timerAt <= at) return;
    this.cancelTimer?.();
    this.timerAt = at;
    this.cancelTimer = this.deps.setTimer(
      () => {
        this.timerAt = undefined;
        this.cancelTimer = undefined;
        void this.flush();
      },
      Math.max(0, at - this.deps.now()),
    );
  }

  private async updateBadge(): Promise<void> {
    const [creds, state] = await Promise.all([
      this.deps.repo.credentials(),
      this.deps.repo.state(),
    ]);
    const status = computeStatus(!!creds, state, this.deps.now());
    await this.deps.browser.setBadge(badgeFor(status, state.lastError?.message));
  }

  /**
   * Call whenever the service worker starts. Re-arms timers from persisted state. On a fresh
   * browser session (or extension reload), session restore fires many tab events, so tab events
   * are ignored until the layout settles.
   */
  wake({ freshSession }: { freshSession: boolean }): Promise<void> {
    return this.run(async () => {
      let state = await this.deps.repo.state();
      if (freshSession && (await this.deps.repo.credentials())) {
        state = await this.deps.repo.patchState({ settleUntil: this.deps.now() + SETTLE_MS });
        this.deps.log('Browser session started; waiting for tabs to settle');
      }
      const due = this.nextDue(state);
      if (due !== undefined) this.schedule(due);
      await this.updateBadge();
    });
  }

  private nextDue(state: SyncState): number | undefined {
    const candidates: number[] = [];
    if (state.settleUntil !== undefined) candidates.push(state.settleUntil);
    if (state.dirtySince !== undefined && state.lastChangeAt !== undefined) {
      candidates.push(pushDueAt(state.dirtySince, state.lastChangeAt));
    }
    if (state.pending) candidates.push(state.nextRetryAt ?? this.deps.now());
    return candidates.length
      ? Math.max(Math.min(...candidates), state.settleUntil ?? 0)
      : undefined;
  }

  /** A tab, group or window changed in a way that may alter the fingerprint. */
  layoutChanged(): Promise<void> {
    return this.run(async () => {
      if (!(await this.deps.repo.credentials())) return;
      const now = this.deps.now();
      const state = await this.deps.repo.state();
      if (state.settleUntil !== undefined && now < state.settleUntil) return;
      const next = await this.deps.repo.patchState({
        dirtySince: state.dirtySince ?? now,
        lastChangeAt: now,
      });
      this.schedule(pushDueAt(next.dirtySince!, next.lastChangeAt!));
      await this.updateBadge();
    });
  }

  /** Safety net (1-minute alarm): flush anything due that a lost timer would have handled. */
  tick(): Promise<void> {
    return this.run(async () => {
      const state = await this.deps.repo.state();
      const due = this.nextDue(state);
      if (due !== undefined && due <= this.deps.now()) await this.flushNow({ force: false });
      else await this.updateBadge();
    });
  }

  /** Pushes if anything is due. */
  flush(): Promise<void> {
    return this.run(() => this.flushNow({ force: false }));
  }

  /** "Sync now": push immediately if the layout changed, ignoring debounce and backoff. */
  syncNow(): Promise<void> {
    return this.run(() => this.flushNow({ force: true }));
  }

  private async flushNow({ force }: { force: boolean }): Promise<void> {
    const session = await this.session();
    if (!session) return;
    const { repo, now } = this.deps;
    let state = await repo.state();
    const t = now();

    if (!force) {
      const due = this.nextDue(state);
      if (due === undefined) return this.updateBadge();
      if (due > t) {
        this.schedule(due);
        return this.updateBadge();
      }
    }

    const windows = await this.capture();
    state = { ...state, settleUntil: undefined, dirtySince: undefined, lastChangeAt: undefined };
    if (windows.length === 0) {
      // No windows (e.g. last window closed on macOS, or the browser quitting): never publish
      // an empty layout (PLAN.md D10). Keep any pending snapshot for later.
      await repo.saveState(state);
      return this.updateBadge();
    }
    const fp = await fingerprint(windows);

    let snapshot = state.pending;
    if (snapshot && (await fingerprint(snapshot.windows)) !== fp) snapshot = undefined;
    if (!snapshot) {
      if (fp === state.lastFingerprint) {
        await repo.saveState({ ...state, pending: undefined });
        return this.updateBadge();
      }
      snapshot = this.buildSnapshot(windows, session.settings, state, 'auto');
    }
    state = { ...state, pending: snapshot };
    await repo.saveState(state);
    await this.updateBadge();

    try {
      const blob = await encryptSnapshot(snapshot, session.keys);
      await session.api.upload({
        id: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        kind: snapshot.reason,
        blob: toBase64Url(blob),
      });
      await repo.saveState({
        ...state,
        pending: undefined,
        baseSnapshotId: snapshot.snapshotId,
        lastFingerprint: fp,
        lastPushAt: now(),
        lastError: undefined,
        failingSince: undefined,
        retryAttempt: undefined,
        nextRetryAt: undefined,
      });
      this.deps.log(`Pushed snapshot ${snapshot.snapshotId.slice(0, 8)} (${blob.length} bytes)`);
    } catch (err) {
      const { kind, message, transient } = classify(err);
      const attempt = (state.retryAttempt ?? 0) + 1;
      const nextRetryAt = transient ? now() + retryDelay(attempt) : undefined;
      await repo.saveState({
        ...state,
        lastError: { kind, message, at: now() },
        failingSince: state.failingSince ?? t,
        retryAttempt: attempt,
        nextRetryAt,
      });
      this.deps.log(`Push failed (${kind}): ${message}`);
      if (nextRetryAt !== undefined) this.schedule(nextRetryAt);
    }
    await this.updateBadge();
  }

  /** Generates a secret, registers it, and pushes this device's tabs as the first snapshot. */
  createProfile(): Promise<{ secret: string }> {
    return this.run(async () => {
      const secret = formatSecret(generateSecret());
      const keys = await deriveProfileKeys(parseSecret(secret));
      const settings = await this.deps.repo.settings();
      try {
        await this.deps.createApi(settings.serverUrl, keys).register();
      } catch (err) {
        throw new SetupError(classify(err).message);
      }
      await this.deps.repo.connect({ secret }, {});
      this.deps.log(`Created sync profile ${keys.profileId.slice(0, 6)}…`);
      await this.flushNow({ force: true });
      return { secret };
    });
  }

  /**
   * Joins an existing profile. Never registers (PLAN.md D4): an unknown profile means the
   * secret is wrong, and nothing is stored. Nothing is pushed until the layout changes.
   */
  joinProfile(secretText: string): Promise<void> {
    return this.run(async () => {
      let secretBytes: Uint8Array<ArrayBuffer>;
      try {
        secretBytes = parseSecret(secretText);
      } catch (err) {
        throw new SetupError(
          err instanceof InvalidSecretError ? err.message : 'That secret is not valid.',
        );
      }
      const secret = formatSecret(secretBytes);
      const keys = await deriveProfileKeys(secretBytes);
      const settings = await this.deps.repo.settings();
      const api = this.deps.createApi(settings.serverUrl, keys);

      let latest;
      try {
        latest = await api.latest();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          throw new SetupError(
            'No sync profile found for this secret. Check it was copied completely.',
          );
        }
        throw new SetupError(classify(err).message);
      }
      if (latest.status === 'ok') {
        const { snapshot } = latest;
        try {
          await decryptSnapshot(fromBase64Url(snapshot.blob), keys, snapshot);
        } catch {
          throw new SetupError('Found the profile but could not decrypt its data.');
        }
      }

      const lastFingerprint = await fingerprint(await this.capture());
      await this.deps.repo.connect({ secret }, { lastFingerprint, lastPullAt: this.deps.now() });
      this.deps.log(`Joined sync profile ${keys.profileId.slice(0, 6)}…`);
      await this.updateBadge();
    });
  }

  revealSecret(): Promise<string | undefined> {
    return this.deps.repo.credentials().then((c) => c?.secret);
  }

  /** Clears the secret and sync state on this device. Server data is left alone. */
  disconnect(): Promise<void> {
    return this.run(async () => {
      this.cancelTimer?.();
      this.cancelTimer = undefined;
      this.timerAt = undefined;
      this.keyCache = undefined;
      await this.deps.repo.disconnect();
      this.deps.log('Disconnected from sync profile');
      await this.updateBadge();
    });
  }

  updateSettings(patch: Partial<Pick<Settings, 'serverUrl' | 'deviceName'>>): Promise<Settings> {
    return this.run(() => this.deps.repo.updateSettings(patch));
  }

  async status(): Promise<StatusView> {
    const [creds, state, settings] = await Promise.all([
      this.deps.repo.credentials(),
      this.deps.repo.state(),
      this.deps.repo.settings(),
    ]);
    return {
      status: computeStatus(!!creds, state, this.deps.now()),
      settings,
      lastPushAt: state.lastPushAt,
      lastPullAt: state.lastPullAt,
      lastError: state.lastError,
    };
  }
}
