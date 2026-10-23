import type { SnapshotReason } from '@tabsync/shared';
import {
  ApiError,
  NetworkError,
  type Credentials,
  type LatestResult,
  type SnapshotMeta,
  type SnapshotRecord,
  type SyncApi,
  type UploadRequest,
} from '../src/lib/api';
import type { BrowserApi } from '../src/lib/browser';
import type { BrowserGroup, BrowserTab, BrowserWindow } from '../src/lib/capture';
import { SyncEngine } from '../src/lib/engine';
import type { LogLine } from '../src/lib/logger';
import { StateRepo } from '../src/lib/state';
import type { Badge } from '../src/lib/status';
import { MemoryStore } from '../src/lib/store';

export const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

/** A clock plus timers that only fire when the test advances time. */
export class FakeClock {
  now = T0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 0;

  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.now + ms, fn, id });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  };

  /** Advances time, firing due timers in order and letting the engine finish after each. */
  async advance(ms: number, engine: SyncEngine): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await engine.idle();
      const next = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
    this.now = end;
    await engine.idle();
  }

  /** Drops all timers, as killing the service worker does. */
  clearTimers(): void {
    this.timers = [];
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

export class FakeBrowser implements BrowserApi {
  windows: BrowserWindow[] = [];
  groups: BrowserGroup[] = [];
  badge?: Badge;

  addWindow(urls: string[], extra: Partial<BrowserWindow> = {}): BrowserWindow {
    const w: BrowserWindow = {
      incognito: false,
      type: 'normal',
      focused: this.windows.length === 0,
      state: 'normal',
      tabs: urls.map((url, index) => this.makeTab(url, index)),
      ...extra,
    };
    this.windows.push(w);
    return w;
  }

  makeTab(url: string, index: number, extra: Partial<BrowserTab> = {}): BrowserTab {
    return {
      index,
      url,
      title: `Title ${url}`,
      pinned: false,
      active: index === 0,
      groupId: -1,
      ...extra,
    };
  }

  openTab(windowIndex: number, url: string): void {
    const w = this.windows[windowIndex]!;
    w.tabs!.push(this.makeTab(url, w.tabs!.length));
  }

  async getWindows() {
    return structuredClone(this.windows);
  }

  async getGroups() {
    return structuredClone(this.groups);
  }

  async setBadge(badge: Badge) {
    this.badge = badge;
  }
}

interface StoredSnapshot extends SnapshotRecord {
  profileId: string;
}

/** In-memory stand-in for the sync server, with failure switches. */
export class FakeServer {
  profiles = new Map<string, string>();
  snapshots: StoredSnapshot[] = [];
  offline = false;
  failWith?: ApiError;
  uploads = 0;
  constructor(private readonly clock: FakeClock) {}

  api(creds: Credentials): SyncApi {
    const guard = (auth = true) => {
      if (this.offline) throw new NetworkError('offline');
      if (this.failWith) throw this.failWith;
      if (auth && this.profiles.get(creds.profileId) !== creds.authToken) {
        throw new ApiError(401, 'unauthorized', 'Unknown profile or wrong token');
      }
    };
    const meta = ({
      id,
      createdAt,
      receivedAt,
      kind,
      sizeBytes,
    }: StoredSnapshot): SnapshotMeta => ({
      id,
      createdAt,
      receivedAt,
      kind,
      sizeBytes,
    });
    const record = (s: StoredSnapshot): SnapshotRecord => ({ ...meta(s), blob: s.blob });
    const mine = () => this.snapshots.filter((s) => s.profileId === creds.profileId);

    return {
      register: async () => {
        guard(false);
        const existing = this.profiles.get(creds.profileId);
        if (existing && existing !== creds.authToken)
          throw new ApiError(409, 'profile_exists', 'exists');
        this.profiles.set(creds.profileId, creds.authToken);
      },
      latest: async (ifNoneMatch?: string): Promise<LatestResult> => {
        guard();
        const latest = mine()
          .filter((s) => s.kind !== 'pre-restore')
          .at(-1);
        if (!latest) return { status: 'empty' };
        if (ifNoneMatch === latest.id) return { status: 'not-modified' };
        return { status: 'ok', snapshot: record(latest) };
      },
      list: async () => {
        guard();
        return mine().map(meta).reverse();
      },
      get: async (id: string) => {
        guard();
        const s = mine().find((x) => x.id === id);
        if (!s) throw new ApiError(404, 'not_found', 'Snapshot not found');
        return record(s);
      },
      upload: async (req: UploadRequest) => {
        guard();
        this.uploads++;
        const existing = this.snapshots.find((s) => s.id === req.id);
        if (existing && existing.profileId !== creds.profileId) {
          throw new ApiError(409, 'id_conflict', 'Snapshot ID already in use');
        }
        if (existing) return meta(existing);
        const stored: StoredSnapshot = {
          ...req,
          kind: req.kind as SnapshotReason,
          profileId: creds.profileId,
          receivedAt: new Date(this.clock.now).toISOString(),
          sizeBytes: req.blob.length,
        };
        this.snapshots.push(stored);
        return meta(stored);
      },
    };
  }
}

export interface Harness {
  clock: FakeClock;
  browser: FakeBrowser;
  server: FakeServer;
  store: MemoryStore;
  repo: StateRepo;
  engine: SyncEngine;
  logs: string[];
  /** Simulates the service worker being killed and restarted (memory lost, storage kept). */
  restartWorker(opts?: { freshSession?: boolean }): Promise<SyncEngine>;
}

export function createHarness(): Harness {
  const clock = new FakeClock();
  const browser = new FakeBrowser();
  const server = new FakeServer(clock);
  const store = new MemoryStore();
  const repo = new StateRepo(store, () => crypto.randomUUID());
  const logs: string[] = [];
  const make = () =>
    new SyncEngine({
      repo,
      browser,
      createApi: (_url, creds) => server.api(creds),
      now: () => clock.now,
      randomId: () => crypto.randomUUID(),
      setTimer: clock.setTimer,
      log: (m) => logs.push(m),
    });
  const harness: Harness = {
    clock,
    browser,
    server,
    store,
    repo,
    engine: make(),
    logs,
    async restartWorker({ freshSession = false } = {}) {
      clock.clearTimers();
      harness.engine = make();
      await harness.engine.wake({ freshSession });
      return harness.engine;
    },
  };
  return harness;
}

export type { LogLine };
