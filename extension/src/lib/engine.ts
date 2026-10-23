import {
  decryptSnapshot,
  DecryptError,
  deriveProfileKeys,
  describeDiff,
  diffLayouts,
  encryptSnapshot,
  fingerprint,
  formatSecret,
  fromBase64Url,
  generateSecret,
  InvalidSecretError,
  parseSecret,
  resolveRestorePoints,
  toBase64Url,
  FORMAT_VERSION,
  type ProfileKeys,
  type Snapshot,
  type SnapshotReason,
  type SnapWindow,
} from '@tabsync/shared';
import {
  ApiError,
  NetworkError,
  type Credentials as ApiCredentials,
  type SnapshotRecord,
  type SyncApi,
} from './api';
import type { BrowserApi } from './browser';
import { captureLayout } from './capture';
import type { Log } from './logger';
import { applyLayout, planApply, type ApplyMode } from './reconcile';
import { ECHO_GRACE_MS, PULL_MIN_INTERVAL_MS, pushDueAt, retryDelay, SETTLE_MS } from './schedule';
import type { ErrorKind, Settings, StateRepo, SyncState } from './state';
import { badgeFor, computeStatus, isBehind, isConflict, type SyncStatus } from './status';

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

export interface BehindInfo {
  deviceName: string;
  createdAt: string;
  /** e.g. "3 opened, 1 closed, 1 group changed" (current tabs → theirs). */
  summary: string;
  opened: number;
  closed: number;
  groupsChanged: number;
  /** Windows "match exactly" would offer to close. */
  surplusWindows: number;
}

export interface TabSummary {
  title: string;
  url: string;
}

export interface ConflictInfo {
  deviceName: string;
  createdAt: string;
  /** Tabs open here but not in theirs (first few), and the total. */
  onlyHere: TabSummary[];
  onlyHereCount: number;
  /** Tabs in theirs but not open here (first few), and the total. */
  onlyThere: TabSummary[];
  onlyThereCount: number;
  groupsChanged: number;
}

export type ConflictChoice = 'keep-mine' | 'take-theirs' | 'merge';

export interface HistoryEntry {
  snapshotId: string;
  createdAt: string;
  kind: SnapshotReason;
  deviceName: string;
  /** Whether this device made it. */
  mine: boolean;
  tabCount: number;
  windowCount: number;
  /** Windows "match exactly" would offer to close if this were restored. */
  surplusWindows: number;
}

export interface HistoryView {
  /** One entry per restore label that resolves (SPEC.md "Restore menu"). */
  points: (HistoryEntry & { label: string })[];
  /** This device's most recent undo point (taken before an apply or restore). */
  undo?: HistoryEntry;
}

export interface StatusView {
  status: SyncStatus;
  settings: Settings;
  lastPushAt?: number;
  lastPullAt?: number;
  lastError?: { kind: ErrorKind; message: string; at: number };
  /** Device that made the newest snapshot on the server, if known. */
  latestDevice?: string;
  behind?: BehindInfo;
  conflict?: ConflictInfo;
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

interface Session {
  keys: ProfileKeys;
  api: SyncApi;
  settings: Settings;
}

interface Failure {
  kind: ErrorKind;
  message: string;
  transient: boolean;
}

function classify(err: unknown): Failure {
  if (err instanceof NetworkError)
    return { kind: 'network', message: err.message, transient: true };
  if (err instanceof DecryptError) {
    return {
      kind: 'decrypt',
      message: `Couldn’t decrypt the latest snapshot: ${err.message}`,
      transient: false,
    };
  }
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
 * The background sync logic: capture, debounce, push, pull, apply, retry and status. All
 * persistent state lives in StateRepo so the service worker can be killed at any point.
 */
export class SyncEngine {
  private queue: Promise<unknown> = Promise.resolve();
  private cancelTimer?: () => void;
  private timerAt?: number;
  private keyCache?: { secret: string; keys: ProfileKeys };
  /** True while applying a snapshot: our own tab operations must not count as changes. */
  private applying = false;
  /** Decrypted snapshots fetched for history/restore, by ID (small; snapshots are immutable). */
  private snapshotCache = new Map<string, Snapshot>();

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

  private async upload(session: Session, snapshot: Snapshot): Promise<number> {
    const blob = await encryptSnapshot(snapshot, session.keys);
    await session.api.upload({
      id: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
      kind: snapshot.reason,
      blob: toBase64Url(blob),
    });
    return blob.length;
  }

  private decrypt(session: Session, record: SnapshotRecord): Promise<Snapshot> {
    return decryptSnapshot(fromBase64Url(record.blob), session.keys, record);
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
        void this.flush().then(() => this.pull({ ifOlderThan: PULL_MIN_INTERVAL_MS }));
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
    const detail =
      status === 'behind' || status === 'conflict'
        ? state.remote?.device.name
        : state.lastError?.message;
    await this.deps.browser.setBadge(badgeFor(status, detail));
  }

  private failureState(state: SyncState, f: Failure, attemptsSoFar: number): Partial<SyncState> {
    const t = this.deps.now();
    const attempt = attemptsSoFar + 1;
    return {
      lastError: { kind: f.kind, message: f.message, at: t },
      failingSince: state.failingSince ?? t,
      retryAttempt: attempt,
      nextRetryAt: f.transient ? t + retryDelay(attempt) : undefined,
    };
  }

  private static readonly CLEAR_ERRORS = {
    lastError: undefined,
    failingSince: undefined,
    retryAttempt: undefined,
    nextRetryAt: undefined,
  } satisfies Partial<SyncState>;

  /**
   * Call whenever the service worker starts. Re-arms timers from persisted state. On a fresh
   * browser session (or extension reload), session restore fires many tab events, so tab events
   * are ignored until the layout settles.
   */
  wake({ freshSession }: { freshSession: boolean }): Promise<void> {
    return this.run(async () => {
      let state = await this.deps.repo.state();
      const patch: Partial<SyncState> = {};
      if (freshSession && (await this.deps.repo.credentials())) {
        patch.settleUntil = this.deps.now() + SETTLE_MS;
        this.deps.log('Browser session started; waiting for tabs to settle');
      }
      if (Object.keys(patch).length) state = await this.deps.repo.patchState(patch);
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
    if (this.applying) return Promise.resolve();
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

  /** Safety net (1-minute alarm): flush anything a lost timer would have handled, then pull. */
  tick(): Promise<void> {
    return this.run(async () => {
      const state = await this.deps.repo.state();
      const due = this.nextDue(state);
      if (due !== undefined && due <= this.deps.now()) await this.flushNow({ force: false });
      await this.pullNow();
    });
  }

  /** Pushes if anything is due. */
  flush(): Promise<void> {
    return this.run(() => this.flushNow({ force: false }));
  }

  /** "Sync now": push immediately if the layout changed (ignoring debounce), then pull. */
  syncNow(): Promise<void> {
    return this.run(async () => {
      await this.flushNow({ force: true });
      await this.pullNow();
    });
  }

  /** Checks the server for a newer snapshot. `ifOlderThan` throttles (window focus). */
  pull({ ifOlderThan }: { ifOlderThan?: number } = {}): Promise<void> {
    return this.run(async () => {
      if (ifOlderThan !== undefined) {
        const { lastPullAt } = await this.deps.repo.state();
        if (lastPullAt !== undefined && this.deps.now() - lastPullAt < ifOlderThan) return;
      }
      await this.pullNow();
    });
  }

  /**
   * If the server's latest snapshot has exactly the layout this device has open, adopt it as the
   * base instead of reporting Behind.
   */
  private adoptIfIdentical(state: SyncState, fp: string): SyncState {
    if (!isBehind(state) || state.remoteFingerprint !== fp) return state;
    this.deps.log(`Already matches ${state.remote!.device.name}'s latest snapshot`);
    return {
      ...state,
      baseSnapshotId: state.remote!.snapshotId,
      lastFingerprint: fp,
      pending: undefined,
    };
  }

  private async pullNow(): Promise<void> {
    const session = await this.session();
    if (!session) return;
    const { repo, now } = this.deps;
    let state = await repo.state();

    let record: SnapshotRecord | undefined;
    try {
      const result = await session.api.latest(state.remote?.snapshotId);
      if (result.status === 'ok') record = result.snapshot;
    } catch (err) {
      // Record the error for status, but leave the push retry schedule alone.
      const f = classify(err);
      const { lastError, failingSince } = this.failureState(state, f, 0);
      await repo.saveState({ ...state, lastError, failingSince });
      this.deps.log(`Pull failed (${f.kind}): ${f.message}`);
      return this.updateBadge();
    }

    // Reaching the server clears a network error unless a push is still failing.
    state = { ...state, lastPullAt: now(), ...(state.pending ? {} : SyncEngine.CLEAR_ERRORS) };
    if (record) {
      let remote: Snapshot;
      try {
        remote = await this.decrypt(session, record);
      } catch (err) {
        const f = classify(err);
        const { lastError, failingSince } = this.failureState(state, f, 0);
        await repo.saveState({ ...state, lastError, failingSince });
        this.deps.log(`Pull failed (${f.kind}): ${f.message}`);
        return this.updateBadge();
      }
      state = { ...state, remote, remoteFingerprint: await fingerprint(remote.windows) };
      if (isBehind(state)) {
        const fp = await fingerprint(await this.capture());
        state = this.adoptIfIdentical({ ...state, localFingerprint: fp }, fp);
        if (isConflict(state))
          this.deps.log(`${remote.device.name} has newer tabs, and tabs changed here too`);
        else if (isBehind(state)) this.deps.log(`${remote.device.name} has newer tabs`);
      }
    }
    await repo.saveState(state);
    await this.updateBadge();
  }

  /**
   * The latest snapshot on the server if it's newer than this device's base (another device
   * pushed meanwhile), else undefined. Cheap thanks to If-None-Match.
   */
  private async fetchNewer(
    session: Session,
    state: SyncState,
    ownId: string,
  ): Promise<Snapshot | undefined> {
    const result = await session.api.latest(state.remote?.snapshotId);
    if (result.status !== 'ok') return undefined;
    const { id } = result.snapshot;
    if (id === state.baseSnapshotId || id === ownId) return undefined;
    return this.decrypt(session, result.snapshot);
  }

  private async flushNow({
    force,
    reason = 'auto',
  }: {
    force: boolean;
    reason?: SnapshotReason;
  }): Promise<void> {
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
    // A forced flush inside a settle window (e.g. right after applying) keeps the window.
    const settleUntil =
      state.settleUntil !== undefined && state.settleUntil > t ? state.settleUntil : undefined;
    state = { ...state, settleUntil, dirtySince: undefined, lastChangeAt: undefined };
    if (windows.length === 0) {
      // No windows (e.g. last window closed on macOS, or the browser quitting): never publish
      // an empty layout (PLAN.md D10). Keep any pending snapshot for later.
      await repo.saveState(state);
      return this.updateBadge();
    }
    const fp = await fingerprint(windows);

    state = this.adoptIfIdentical({ ...state, localFingerprint: fp }, fp);
    if (isBehind(state)) {
      // Never overwrite a newer snapshot from another device: with local edits this is a
      // conflict, which the user resolves in the popup (resolving builds a fresh snapshot).
      await repo.saveState({ ...state, pending: undefined });
      return this.updateBadge();
    }

    let snapshot = state.pending;
    if (snapshot && (await fingerprint(snapshot.windows)) !== fp) snapshot = undefined;
    if (!snapshot) {
      if (fp === state.lastFingerprint) {
        await repo.saveState({ ...state, pending: undefined });
        return this.updateBadge();
      }
      snapshot = this.buildSnapshot(windows, session.settings, state, reason);
    }
    state = { ...state, pending: snapshot };
    await repo.saveState(state);
    await this.updateBadge();

    try {
      // Re-check right before pushing, so a device that edits before its next pull can't blindly
      // overwrite a snapshot another device just pushed (PLAN.md D14).
      const newer = await this.fetchNewer(session, state, snapshot.snapshotId);
      if (newer) {
        state = {
          ...state,
          remote: newer,
          remoteFingerprint: await fingerprint(newer.windows),
          lastPullAt: now(),
        };
        state = this.adoptIfIdentical(state, fp);
        await repo.saveState({ ...state, ...SyncEngine.CLEAR_ERRORS, pending: undefined });
        if (isBehind(state))
          this.deps.log(`${newer.device.name} pushed newer tabs first; not overwriting them`);
        return this.updateBadge();
      }
      const size = await this.upload(session, snapshot);
      await repo.saveState({
        ...state,
        ...SyncEngine.CLEAR_ERRORS,
        pending: undefined,
        baseSnapshotId: snapshot.snapshotId,
        lastFingerprint: fp,
        remote: snapshot,
        remoteFingerprint: fp,
        lastPushAt: now(),
      });
      this.deps.log(`Pushed snapshot ${snapshot.snapshotId.slice(0, 8)} (${size} bytes)`);
    } catch (err) {
      const f = classify(err);
      const failed = { ...state, ...this.failureState(state, f, state.retryAttempt ?? 0) };
      await repo.saveState(failed);
      this.deps.log(`Push failed (${f.kind}): ${f.message}`);
      if (failed.nextRetryAt !== undefined) this.schedule(failed.nextRetryAt);
    }
    await this.updateBadge();
  }

  /**
   * Applies the server's latest snapshot (the Behind prompt). Saves a `pre-restore` snapshot
   * first, then reconciles, then records the applied snapshot as this device's base so the
   * result isn't pushed back.
   */
  applyRemote(mode: ApplyMode, { closeSurplusWindows = false } = {}): Promise<void> {
    return this.run(async () => {
      const session = await this.session();
      if (!session) throw new ApplyError('Sync is not set up');
      const state = await this.deps.repo.state();
      if (!state.remote) throw new ApplyError('There is no snapshot to apply');
      await this.applySnapshot(session, state.remote, mode, closeSurplusWindows, 'adopt');
      await this.deps.repo.updateSettings({ applyMode: mode });
    });
  }

  /**
   * Saves an undo point, reconciles the tabs to `target`, then either adopts `target` as the base
   * (applying the server's latest) or pushes the result as a new `manual` snapshot (restoring
   * from history, merging a conflict) so other devices see it.
   */
  private async applySnapshot(
    session: Session,
    target: Snapshot,
    mode: ApplyMode,
    closeSurplusWindows: boolean,
    after: 'adopt' | 'push',
  ) {
    const { repo, now, log } = this.deps;
    let state = await repo.state();

    // 1. Undo point. If it can't be saved, don't touch the tabs.
    const current = await this.capture();
    if (current.length > 0) {
      const preRestore = this.buildSnapshot(current, session.settings, state, 'pre-restore');
      try {
        await this.upload(session, preRestore);
      } catch (err) {
        throw new ApplyError(
          `Couldn’t save an undo point, so nothing was changed: ${classify(err).message}`,
        );
      }
      log(`Saved pre-restore snapshot ${preRestore.snapshotId.slice(0, 8)}`);
    }

    // 2. Reconcile, ignoring the tab events it causes.
    this.applying = true;
    try {
      const { skipped } = await applyLayout(this.deps.browser, target.windows, {
        mode,
        closeSurplusWindows,
      });
      for (const url of skipped) log(`Couldn’t open ${url}; left it out`);
    } catch (err) {
      log(`Apply failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ApplyError(
        `Couldn’t finish applying (${err instanceof Error ? err.message : String(err)}). ` +
          'Some tabs may have changed; your previous tabs were saved first.',
      );
    } finally {
      this.applying = false;
    }

    // 3. Record the applied snapshot as the base and the resulting layout as already synced.
    // Late events from our own operations are ignored for a moment, after which the layout is
    // fingerprinted once more, so a real edit made meanwhile is still pushed.
    const fp = await fingerprint(await this.capture());
    state = await repo.state();
    const common = {
      pending: undefined,
      dirtySince: undefined,
      lastChangeAt: undefined,
      localFingerprint: fp,
      settleUntil: now() + ECHO_GRACE_MS,
    };
    if (after === 'adopt') {
      await repo.saveState({
        ...state,
        ...common,
        baseSnapshotId: target.snapshotId,
        lastFingerprint: fp,
      });
      log(`Applied ${target.device.name}'s snapshot ${target.snapshotId.slice(0, 8)} (${mode})`);
    } else {
      // Build on the server's latest (we've seen it), and push only if the result differs from it.
      await repo.saveState({
        ...state,
        ...common,
        baseSnapshotId: state.remote?.snapshotId ?? state.baseSnapshotId,
        lastFingerprint: state.remoteFingerprint ?? state.lastFingerprint,
      });
      log(
        `Restored snapshot ${target.snapshotId.slice(0, 8)} from ${target.device.name} (${mode})`,
      );
      await this.flushNow({ force: true, reason: 'manual' });
    }
    this.schedule(now() + ECHO_GRACE_MS);
    await this.updateBadge();
  }

  /** Resolves a conflict (SPEC.md decision 5). */
  resolveConflict(choice: ConflictChoice): Promise<void> {
    return this.run(async () => {
      const session = await this.session();
      if (!session) throw new ApplyError('Sync is not set up');
      const state = await this.deps.repo.state();
      if (!state.remote) throw new ApplyError('There is nothing to resolve');
      if (choice === 'take-theirs') {
        await this.applySnapshot(session, state.remote, 'match-exactly', false, 'adopt');
      } else if (choice === 'merge') {
        await this.applySnapshot(session, state.remote, 'add-missing', false, 'push');
      } else {
        // Keep mine: push this layout on top of theirs; their snapshot stays in history.
        await this.deps.repo.saveState({
          ...state,
          pending: undefined,
          baseSnapshotId: state.remote.snapshotId,
          lastFingerprint: state.remoteFingerprint,
        });
        this.deps.log(`Keeping this device's tabs over ${state.remote.device.name}'s`);
        await this.flushNow({ force: true, reason: 'manual' });
      }
    });
  }

  private async fetchSnapshot(session: Session, id: string): Promise<Snapshot> {
    const cached = this.snapshotCache.get(id);
    if (cached) return cached;
    const snapshot = await this.decrypt(session, await session.api.get(id));
    if (this.snapshotCache.size >= 32)
      this.snapshotCache.delete(this.snapshotCache.keys().next().value!);
    this.snapshotCache.set(id, snapshot);
    return snapshot;
  }

  /** Restores a snapshot from history; the result is pushed so other devices see it (D2). */
  restore(
    snapshotId: string,
    mode: ApplyMode,
    { closeSurplusWindows = false } = {},
  ): Promise<void> {
    return this.run(async () => {
      const session = await this.session();
      if (!session) throw new ApplyError('Sync is not set up');
      let target: Snapshot;
      try {
        target = await this.fetchSnapshot(session, snapshotId);
      } catch (err) {
        throw new ApplyError(`Couldn’t load that snapshot: ${classify(err).message}`);
      }
      await this.applySnapshot(session, target, mode, closeSurplusWindows, 'push');
      await this.deps.repo.updateSettings({ applyMode: mode });
    });
  }

  /**
   * The restore menu: for each label (1 minute … 1 year) the newest snapshot at least that old,
   * plus this device's latest undo point. Device names are encrypted, so the chosen snapshots
   * are fetched and decrypted (PLAN.md D5).
   */
  async history(): Promise<HistoryView> {
    const session = await this.session();
    if (!session) throw new Error('Sync is not set up');
    const now = this.deps.now();
    const metas = await session.api.list();
    const entries = metas.map((m) => ({
      id: m.id,
      createdAt: Date.parse(m.createdAt),
      kind: m.kind,
    }));
    const windows = await this.deps.browser.getWindows();

    const describe = async (id: string): Promise<HistoryEntry | undefined> => {
      try {
        const s = await this.fetchSnapshot(session, id);
        return {
          snapshotId: s.snapshotId,
          createdAt: s.createdAt,
          kind: s.reason,
          deviceName: s.device.name,
          mine: s.device.id === session.settings.deviceId,
          tabCount: s.windows.reduce((n, w) => n + w.tabs.length, 0),
          windowCount: s.windows.length,
          surplusWindows: planApply(windows, s.windows).surplusWindowIds.length,
        };
      } catch (err) {
        this.deps.log(`Couldn’t read snapshot ${id.slice(0, 8)}: ${classify(err).message}`);
        return undefined;
      }
    };

    const points: HistoryView['points'] = [];
    for (const p of resolveRestorePoints(entries, now)) {
      const entry = await describe(p.entry.id);
      if (entry) points.push({ ...entry, label: p.label.text });
    }

    // Newest pre-restore snapshot made by this device (they're kept 30 days).
    let undo: HistoryEntry | undefined;
    for (const e of [...entries]
      .filter((x) => x.kind === 'pre-restore')
      .sort((a, b) => b.createdAt - a.createdAt)) {
      const entry = await describe(e.id);
      if (entry?.mine) {
        undo = entry;
        break;
      }
    }
    return { points, undo };
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
   * secret is wrong, and nothing is stored. Nothing is pushed; the server's latest shows as
   * Behind unless this device already has the same tabs (PLAN.md D11).
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
      let remote: Snapshot | undefined;
      if (latest.status === 'ok') {
        try {
          remote = await decryptSnapshot(
            fromBase64Url(latest.snapshot.blob),
            keys,
            latest.snapshot,
          );
        } catch {
          throw new SetupError('Found the profile but could not decrypt its data.');
        }
      }

      const lastFingerprint = await fingerprint(await this.capture());
      let state: SyncState = { lastFingerprint, lastPullAt: this.deps.now() };
      if (remote) {
        state = { ...state, remote, remoteFingerprint: await fingerprint(remote.windows) };
        state = this.adoptIfIdentical(state, lastFingerprint);
      }
      await this.deps.repo.connect({ secret }, state);
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

  updateSettings(
    patch: Partial<Pick<Settings, 'serverUrl' | 'deviceName' | 'applyMode'>>,
  ): Promise<Settings> {
    return this.run(() => this.deps.repo.updateSettings(patch));
  }

  async status(): Promise<StatusView> {
    const [creds, state, settings] = await Promise.all([
      this.deps.repo.credentials(),
      this.deps.repo.state(),
      this.deps.repo.settings(),
    ]);
    const view: StatusView = {
      status: computeStatus(!!creds, state, this.deps.now()),
      settings,
      lastPushAt: state.lastPushAt,
      lastPullAt: state.lastPullAt,
      lastError: state.lastError,
      latestDevice: state.remote?.device.name,
    };
    if (creds && state.remote && isConflict(state)) {
      const current = await this.capture();
      const diff = diffLayouts(state.remote.windows, current);
      const summarize = (tabs: { title: string; url: string }[]) =>
        tabs.slice(0, 5).map((t) => ({ title: t.title || t.url, url: t.url }));
      view.conflict = {
        deviceName: state.remote.device.name,
        createdAt: state.remote.createdAt,
        onlyHere: summarize(diff.opened),
        onlyHereCount: diff.opened.length,
        onlyThere: summarize(diff.closed),
        onlyThereCount: diff.closed.length,
        groupsChanged: diff.groupsChanged,
      };
    } else if (creds && state.remote && isBehind(state)) {
      const [windows, groups] = await Promise.all([
        this.deps.browser.getWindows(),
        this.deps.browser.getGroups(),
      ]);
      const diff = diffLayouts(captureLayout(windows, groups), state.remote.windows);
      view.behind = {
        deviceName: state.remote.device.name,
        createdAt: state.remote.createdAt,
        summary: describeDiff(diff),
        opened: diff.opened.length,
        closed: diff.closed.length,
        groupsChanged: diff.groupsChanged,
        surplusWindows: planApply(windows, state.remote.windows).surplusWindowIds.length,
      };
    }
    return view;
  }
}
