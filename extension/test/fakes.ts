import { NEW_TAB_URL, type GroupColor, type SnapshotReason } from '@tabsync/shared';
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
import type { BrowserGroup, BrowserWindow } from '../src/lib/capture';
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

export interface SimTab {
  id: number;
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  groupId: number;
  discarded: boolean;
  favIconUrl?: string;
}

export interface SimWindow {
  id: number;
  incognito: boolean;
  type: string;
  focused: boolean;
  state: string;
  tabs: SimTab[];
}

export interface SimGroup {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

/**
 * A simulated tab strip enforcing the browser rules reconcile depends on: pinned tabs come
 * first, groups are contiguous and never contain pinned tabs, empty groups disappear, and a
 * window closes with its last tab. Mutating `windows` directly is allowed in tests.
 */
export class FakeBrowser implements BrowserApi {
  windows: SimWindow[] = [];
  groups: SimGroup[] = [];
  badge?: Badge;
  /** Operation log, e.g. "discard 7". */
  ops: string[] = [];
  private nextId = 1;

  private id(): number {
    return this.nextId++;
  }

  private newTab(url: string, extra: Partial<SimTab> = {}): SimTab {
    return {
      id: this.id(),
      url,
      title: `Title ${url}`,
      pinned: false,
      active: false,
      groupId: -1,
      discarded: false,
      ...extra,
    };
  }

  addWindow(urls: string[], extra: Partial<SimWindow> = {}): SimWindow {
    const w: SimWindow = {
      id: this.id(),
      incognito: false,
      type: 'normal',
      focused: this.windows.length === 0,
      state: 'normal',
      tabs: urls.map((url, i) => this.newTab(url, { active: i === 0 })),
      ...extra,
    };
    this.windows.push(w);
    return w;
  }

  openTab(windowIndex: number, url: string, extra: Partial<SimTab> = {}): SimTab {
    const tab = this.newTab(url, extra);
    this.windows[windowIndex]!.tabs.push(tab);
    this.normalize();
    return tab;
  }

  /** Creates a group from existing tabs (test setup helper). */
  addGroup(tabIds: number[], props: Partial<Omit<SimGroup, 'id' | 'windowId'>> = {}): SimGroup {
    const w = this.windowOf(tabIds[0]!);
    const g: SimGroup = {
      id: this.id(),
      windowId: w.id,
      title: '',
      color: 'grey',
      collapsed: false,
      ...props,
    };
    this.groups.push(g);
    this.placeGroup(w, tabIds, g.id);
    return g;
  }

  private windowOf(tabId: number): SimWindow {
    const w = this.windows.find((x) => x.tabs.some((t) => t.id === tabId));
    if (!w) throw new Error(`No tab ${tabId}`);
    return w;
  }

  private tab(tabId: number): SimTab {
    return this.windowOf(tabId).tabs.find((t) => t.id === tabId)!;
  }

  private window(windowId: number): SimWindow {
    const w = this.windows.find((x) => x.id === windowId);
    if (!w) throw new Error(`No window ${windowId}`);
    return w;
  }

  private placeGroup(w: SimWindow, tabIds: number[], groupId: number): void {
    const members = tabIds.map((id) => w.tabs.find((t) => t.id === id)!);
    const at = Math.min(...members.map((m) => w.tabs.indexOf(m)));
    const before = w.tabs.slice(0, at).filter((t) => !members.includes(t));
    const after = w.tabs.slice(at).filter((t) => !members.includes(t));
    for (const m of members) {
      m.groupId = groupId;
      m.pinned = false;
    }
    w.tabs = [...before, ...members, ...after];
    this.normalize();
  }

  /** Re-establishes the invariants after any change. */
  private normalize(): void {
    for (const w of this.windows) {
      w.tabs = [...w.tabs.filter((t) => t.pinned), ...w.tabs.filter((t) => !t.pinned)];
      for (const t of w.tabs) if (t.pinned) t.groupId = -1;
      // A group split by a move keeps its first run; stragglers leave the group.
      const seen = new Set<number>();
      let prev = -1;
      for (const t of w.tabs) {
        if (t.groupId !== -1 && t.groupId !== prev && seen.has(t.groupId)) t.groupId = -1;
        if (t.groupId !== -1) seen.add(t.groupId);
        prev = t.groupId;
      }
      if (w.tabs.length > 0 && !w.tabs.some((t) => t.active)) w.tabs[0]!.active = true;
    }
    this.windows = this.windows.filter((w) => w.tabs.length > 0);
    const used = new Set(this.windows.flatMap((w) => w.tabs.map((t) => t.groupId)));
    this.groups = this.groups.filter((g) => used.has(g.id));
  }

  async getWindows(): Promise<BrowserWindow[]> {
    return this.windows.map((w) => ({
      ...structuredClone(w),
      tabs: w.tabs.map((t, index) => ({ ...structuredClone(t), index })),
    }));
  }

  async getGroups(): Promise<BrowserGroup[]> {
    return structuredClone(this.groups);
  }

  async setBadge(badge: Badge) {
    this.badge = badge;
  }

  /** Makes the next createWindow call fail, as a browser error would. */
  failCreateWindow?: string;

  async createWindow({ url, focused }: { url?: string; focused: boolean }) {
    if (this.failCreateWindow) throw new Error(this.failCreateWindow);
    if (url && this.refusedUrls.has(url)) throw new Error(`Cannot open ${url}`);
    const w = this.addWindow([url ?? NEW_TAB_URL], { focused });
    this.ops.push(`createWindow ${w.id}`);
    return { windowId: w.id, tabId: w.tabs[0]!.id };
  }

  /** URLs createTab/createWindow refuse to open, as the browser does for some schemes. */
  refusedUrls = new Set<string>();

  async createTab({
    windowId,
    url,
    pinned,
    active,
  }: {
    windowId: number;
    url?: string;
    pinned: boolean;
    active: boolean;
  }) {
    if (url && this.refusedUrls.has(url)) throw new Error(`Cannot open ${url}`);
    const w = this.window(windowId);
    const tab = this.newTab(url ?? NEW_TAB_URL, { pinned });
    if (active) for (const t of w.tabs) t.active = false;
    tab.active = active;
    w.tabs.push(tab);
    this.normalize();
    this.ops.push(`createTab ${tab.id}`);
    return tab.id;
  }

  async moveTab(tabId: number, windowId: number, index: number) {
    const from = this.windowOf(tabId);
    const tab = this.tab(tabId);
    from.tabs = from.tabs.filter((t) => t !== tab);
    const to = this.window(windowId);
    const pinnedCount = to.tabs.filter((t) => t.pinned).length;
    const i = tab.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
    to.tabs.splice(Math.min(i, to.tabs.length), 0, tab);
    // Dropped strictly inside another group: the browser adds it to that group.
    const prev = to.tabs[i - 1];
    const next = to.tabs[i + 1];
    if (prev && next && prev.groupId !== -1 && prev.groupId === next.groupId)
      tab.groupId = prev.groupId;
    this.normalize();
    this.ops.push(`move ${tabId}`);
  }

  async updateTab(tabId: number, props: { pinned?: boolean; active?: boolean }) {
    const w = this.windowOf(tabId);
    const tab = this.tab(tabId);
    if (props.active) for (const t of w.tabs) t.active = t === tab;
    if (props.pinned !== undefined && props.pinned !== tab.pinned) {
      w.tabs = w.tabs.filter((t) => t !== tab);
      tab.pinned = props.pinned;
      const pinnedCount = w.tabs.filter((t) => t.pinned).length;
      w.tabs.splice(pinnedCount, 0, tab); // end of pinned zone / start of unpinned zone
    }
    this.normalize();
  }

  async groupTabs(tabIds: number[], windowId: number, groupId?: number) {
    const w = this.window(windowId);
    if (groupId !== undefined) {
      // Adding to an existing group: the tabs join at the group's end.
      const members = w.tabs.filter((t) => t.groupId === groupId);
      if (members.length === 0) throw new Error(`No group ${groupId}`);
      const added = tabIds.map((id) => this.tab(id));
      const rest = w.tabs.filter((t) => !added.includes(t));
      const after = rest.indexOf(members.at(-1)!) + 1;
      for (const t of added) {
        t.groupId = groupId;
        t.pinned = false;
      }
      w.tabs = [...rest.slice(0, after), ...added, ...rest.slice(after)];
      this.normalize();
      this.ops.push(`groupAdd ${groupId} ${tabIds.join(',')}`);
      return groupId;
    }
    const g: SimGroup = { id: this.id(), windowId, title: '', color: 'grey', collapsed: false };
    this.groups.push(g);
    this.placeGroup(w, tabIds, g.id);
    this.ops.push(`group ${tabIds.join(',')}`);
    return g.id;
  }

  async ungroupTabs(tabIds: number[]) {
    for (const id of tabIds) {
      const w = this.windowOf(id);
      const tab = this.tab(id);
      const members = w.tabs.filter((t) => t.groupId === tab.groupId);
      tab.groupId = -1;
      // A tab ungrouped from the middle of a group moves to just after it.
      const last = members.at(-1)!;
      if (last !== tab && members[0] !== tab) {
        w.tabs = w.tabs.filter((t) => t !== tab);
        w.tabs.splice(w.tabs.indexOf(last) + 1, 0, tab);
      }
    }
    this.normalize();
    if (tabIds.length) this.ops.push(`ungroup ${tabIds.join(',')}`);
  }

  async moveGroup(groupId: number, index: number) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) throw new Error(`No group ${groupId}`);
    const w = this.window(g.windowId);
    const members = w.tabs.filter((t) => t.groupId === groupId);
    const rest = w.tabs.filter((t) => t.groupId !== groupId);
    const before = rest[index - 1];
    const after = rest[index];
    if (before && after && before.groupId !== -1 && before.groupId === after.groupId) {
      throw new Error('Cannot move the group to an index that is in the middle of another group');
    }
    if (rest.slice(index).some((t) => t.pinned))
      throw new Error('Cannot move a group among pinned tabs');
    w.tabs = [...rest.slice(0, index), ...members, ...rest.slice(index)];
    this.normalize();
    this.ops.push(`moveGroup ${groupId}`);
  }

  async updateGroup(
    groupId: number,
    props: { title?: string; color?: GroupColor; collapsed?: boolean },
  ) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) throw new Error(`No group ${groupId}`);
    Object.assign(g, props);
    this.ops.push(`updateGroup ${groupId} ${Object.keys(props).join(',')}`);
  }

  async discardTab(tabId: number) {
    const tab = this.tab(tabId);
    if (tab.active) throw new Error('Cannot discard the active tab');
    tab.discarded = true;
    this.ops.push(`discard ${tabId}`);
  }

  async removeTabs(tabIds: number[]) {
    for (const w of this.windows) w.tabs = w.tabs.filter((t) => !tabIds.includes(t.id));
    this.ops.push(...tabIds.map((id) => `removeTab ${id}`));
    this.normalize();
  }

  async removeWindow(windowId: number) {
    this.windows = this.windows.filter((w) => w.id !== windowId);
    this.ops.push(`removeWindow ${windowId}`);
    this.normalize();
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
  latestCalls = 0;
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
        this.latestCalls++;
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

/** One device. Pass another harness's `server` and `clock` to model a second machine. */
export function createHarness(shared: { server?: FakeServer; clock?: FakeClock } = {}): Harness {
  const clock = shared.clock ?? new FakeClock();
  const browser = new FakeBrowser();
  const server = shared.server ?? new FakeServer(clock);
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
