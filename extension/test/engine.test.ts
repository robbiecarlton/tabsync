import {
  decryptSnapshot,
  deriveProfileKeys,
  fromBase64Url,
  parseSecret,
  type Snapshot,
} from '@tabsync/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { SetupError } from '../src/lib/engine';
import { DEBOUNCE_MS, ERROR_AFTER_MS, MAX_WAIT_MS, SETTLE_MS } from '../src/lib/schedule';
import { createHarness, T0, type Harness } from './fakes';

let h: Harness;

beforeEach(async () => {
  h = createHarness();
  h.browser.addWindow(['https://a.example/', 'https://b.example/']);
  await h.engine.wake({ freshSession: false });
});

async function setUp() {
  const { secret } = await h.engine.createProfile();
  return secret;
}

async function decryptAll(secret: string): Promise<Snapshot[]> {
  const keys = await deriveProfileKeys(parseSecret(secret));
  return Promise.all(
    h.server.snapshots.map((s) =>
      decryptSnapshot(fromBase64Url(s.blob), keys, { id: s.id, createdAt: s.createdAt }),
    ),
  );
}

describe('before setup', () => {
  it('shows no badge and ignores tab events', async () => {
    expect(h.browser.badge).toMatchObject({ text: '', title: 'Set up sync' });
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    await h.clock.advance(MAX_WAIT_MS, h.engine);
    expect(h.server.uploads).toBe(0);
    expect((await h.engine.status()).status).toBe('not-setup');
  });
});

describe('createProfile', () => {
  it('registers, stores the secret locally and pushes the current tabs', async () => {
    const secret = await setUp();
    expect(secret).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(await h.repo.credentials()).toEqual({ secret });
    expect(h.server.profiles.size).toBe(1);

    const [snap] = await decryptAll(secret);
    expect(snap!.windows[0]!.tabs.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ]);
    expect(snap!.device.name).toBeTruthy();
    expect(snap!.parentSnapshotId).toBeUndefined();
    expect(h.browser.badge).toMatchObject({ text: '●', color: '#1e8e3e' });
    expect((await h.engine.status()).status).toBe('synced');
  });

  it('stores nothing when registration fails', async () => {
    h.server.offline = true;
    await expect(h.engine.createProfile()).rejects.toThrow(SetupError);
    expect(await h.repo.credentials()).toBeUndefined();
  });
});

describe('joinProfile', () => {
  let secret: string;

  beforeEach(async () => {
    secret = await setUp();
    // Same server, a different device with fresh local storage.
    const server = h.server;
    h = createHarness();
    h.server = server;
    (h.engine as unknown as { deps: { createApi: unknown } }).deps.createApi = (
      _: string,
      c: never,
    ) => server.api(c);
    h.browser.addWindow(['https://other.example/']);
    await h.engine.wake({ freshSession: false });
  });

  it('joins with the right secret without pushing anything', async () => {
    const uploadsBefore = h.server.uploads;
    await h.engine.joinProfile(secret.toLowerCase().replace(/-/g, ' '));
    expect(await h.repo.credentials()).toEqual({ secret });
    expect(h.server.uploads).toBe(uploadsBefore);
    expect((await h.engine.status()).status).toBe('synced');
  });

  it('pushes once the joined device changes its tabs, using its own device identity', async () => {
    await h.engine.joinProfile(secret);
    h.browser.openTab(0, 'https://new.example/');
    await h.engine.layoutChanged();
    await h.clock.advance(DEBOUNCE_MS, h.engine);
    const snaps = await decryptAll(secret);
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.device.id).not.toBe(snaps[0]!.device.id);
  });

  it('rejects a wrong secret clearly and writes nothing', async () => {
    const wrong = (await import('@tabsync/shared')).formatSecret(new Uint8Array(32).fill(7));
    await expect(h.engine.joinProfile(wrong)).rejects.toThrow(
      /No sync profile found for this secret/,
    );
    expect(await h.repo.credentials()).toBeUndefined();
  });

  it('rejects a malformed secret', async () => {
    await expect(h.engine.joinProfile('not a secret')).rejects.toThrow(/not valid/);
    expect(await h.repo.credentials()).toBeUndefined();
  });

  it('reports an unreachable server without storing anything', async () => {
    h.server.offline = true;
    await expect(h.engine.joinProfile(secret)).rejects.toThrow(SetupError);
    expect(await h.repo.credentials()).toBeUndefined();
  });
});

describe('pushing changes', () => {
  beforeEach(async () => {
    await setUp();
  });

  it('pushes 5 seconds after the last change, chaining parentSnapshotId', async () => {
    const first = h.server.snapshots[0]!.id;
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    expect((await h.engine.status()).status).toBe('pending');
    expect(h.browser.badge?.color).toBe('#80868b');

    await h.clock.advance(DEBOUNCE_MS - 1, h.engine);
    expect(h.server.snapshots).toHaveLength(1);
    await h.clock.advance(1, h.engine);
    expect(h.server.snapshots).toHaveLength(2);
    expect((await h.engine.status()).status).toBe('synced');

    const state = await h.repo.state();
    expect(state.baseSnapshotId).toBe(h.server.snapshots[1]!.id);
    const secret = (await h.repo.credentials())!.secret;
    expect((await decryptAll(secret))[1]!.parentSnapshotId).toBe(first);
  });

  it('pushes within 30 seconds during continuous activity', async () => {
    for (let i = 0; i < 20; i++) {
      h.browser.openTab(0, `https://busy.example/${i}`);
      await h.engine.layoutChanged();
      await h.clock.advance(2_000, h.engine);
      if (h.server.snapshots.length > 1) break;
    }
    expect(h.server.snapshots).toHaveLength(2);
    expect(h.clock.now - T0).toBeLessThanOrEqual(MAX_WAIT_MS + 2_000);
  });

  it('does not push when only titles, favicons or the active tab changed', async () => {
    const w = h.browser.windows[0]!;
    w.tabs![0]!.title = 'Something else';
    w.tabs![0]!.favIconUrl = 'https://a.example/new.ico';
    w.tabs![0]!.active = false;
    w.tabs![1]!.active = true;
    await h.engine.layoutChanged();
    await h.clock.advance(MAX_WAIT_MS, h.engine);
    expect(h.server.snapshots).toHaveLength(1);
    expect((await h.engine.status()).status).toBe('synced');
  });

  it('does not push when a change is reverted before the debounce fires', async () => {
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    h.browser.windows[0]!.tabs!.pop();
    await h.engine.layoutChanged();
    await h.clock.advance(DEBOUNCE_MS, h.engine);
    expect(h.server.snapshots).toHaveLength(1);
  });

  it('Sync now pushes immediately', async () => {
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    await h.engine.syncNow();
    expect(h.server.snapshots).toHaveLength(2);
  });

  it('never pushes an empty layout (last window closed, browser quitting)', async () => {
    h.browser.windows = [];
    await h.engine.layoutChanged();
    await h.clock.advance(MAX_WAIT_MS, h.engine);
    expect(h.server.snapshots).toHaveLength(1);
    expect((await h.engine.status()).status).toBe('synced');
  });

  it('does not count a window with only internal pages as content', async () => {
    h.browser.windows = [];
    h.browser.addWindow(['brave://settings/']);
    await h.engine.syncNow();
    expect(h.server.snapshots).toHaveLength(1);
  });

  it('skips private windows', async () => {
    h.browser.addWindow(['https://secret.example/'], { incognito: true });
    await h.engine.syncNow();
    expect(h.server.snapshots).toHaveLength(1);
  });

  it('logs pushes', () => {
    expect(h.logs.some((l) => l.startsWith('Pushed snapshot'))).toBe(true);
  });
});

describe('failures and recovery', () => {
  beforeEach(async () => {
    await setUp();
  });

  it('stays Pending while offline, becomes Error after 5 minutes, then recovers', async () => {
    h.server.offline = true;
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    await h.clock.advance(DEBOUNCE_MS, h.engine);
    expect((await h.engine.status()).status).toBe('pending');
    expect((await h.repo.state()).pending).toBeDefined();

    await h.clock.advance(ERROR_AFTER_MS, h.engine);
    await h.engine.tick(); // the 1-minute alarm refreshes the badge
    expect((await h.engine.status()).status).toBe('error');
    expect(h.browser.badge).toMatchObject({ text: 'x' });

    h.server.offline = false;
    await h.clock.advance(60_000, h.engine);
    expect((await h.engine.status()).status).toBe('synced');
    expect(h.server.snapshots).toHaveLength(2);
    expect((await h.repo.state()).lastError).toBeUndefined();
  });

  it('retries with backoff using the same snapshot ID', async () => {
    h.server.offline = true;
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    await h.clock.advance(DEBOUNCE_MS, h.engine);
    const pendingId = (await h.repo.state()).pending!.snapshotId;
    await h.clock.advance(4_000, h.engine);
    expect((await h.repo.state()).retryAttempt).toBe(1);
    await h.clock.advance(1_000, h.engine);
    expect((await h.repo.state()).retryAttempt).toBe(2);
    h.server.offline = false;
    await h.clock.advance(10_000, h.engine);
    expect(h.server.snapshots.at(-1)!.id).toBe(pendingId);
  });

  it('shows Error immediately when credentials are rejected', async () => {
    h.server.profiles.clear();
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.syncNow();
    const status = await h.engine.status();
    expect(status.status).toBe('error');
    expect(status.lastError?.kind).toBe('auth');
  });

  it('treats server overload as transient', async () => {
    h.server.failWith = new ApiError(503, 'unavailable', 'Service unavailable');
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.syncNow();
    expect((await h.engine.status()).status).toBe('pending');
  });
});

describe('service worker and browser lifecycle', () => {
  beforeEach(async () => {
    await setUp();
  });

  it('flushes via the alarm when the worker died between debounce and push', async () => {
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    h.clock.clearTimers(); // worker killed: in-memory timer gone
    h.engine = (await createFreshEngine()).engine;
    h.clock.now += DEBOUNCE_MS + 1;
    await h.engine.tick();
    expect(h.server.snapshots).toHaveLength(2);
  });

  it('re-arms the debounce timer when the worker restarts', async () => {
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    await h.restartWorker();
    await h.clock.advance(DEBOUNCE_MS, h.engine);
    expect(h.server.snapshots).toHaveLength(2);
  });

  it('pushes a snapshot left pending when the browser closed mid-push', async () => {
    h.server.offline = true;
    h.browser.openTab(0, 'https://c.example/');
    await h.engine.syncNow();
    const pendingId = (await h.repo.state()).pending!.snapshotId;

    h.server.offline = false;
    await h.restartWorker({ freshSession: true });
    await h.clock.advance(SETTLE_MS, h.engine);
    expect(h.server.snapshots.at(-1)!.id).toBe(pendingId);
    expect((await h.engine.status()).status).toBe('synced');
  });

  it('ignores session-restore tab events, then pushes only if the restored layout differs', async () => {
    await h.restartWorker({ freshSession: true });
    // Restore churn: tabs appear one by one.
    h.browser.windows[0]!.tabs = [];
    await h.engine.layoutChanged();
    h.browser.openTab(0, 'https://a.example/');
    await h.engine.layoutChanged();
    await h.clock.advance(SETTLE_MS - 1_000, h.engine);
    h.browser.openTab(0, 'https://b.example/');
    await h.engine.layoutChanged();
    expect(h.server.snapshots).toHaveLength(1);
    // Restore churn is ignored, so the badge doesn't flicker to Pending.
    expect((await h.engine.status()).status).toBe('synced');

    await h.clock.advance(1_000, h.engine);
    expect(h.server.snapshots).toHaveLength(1); // restored to the same layout: nothing to push
    expect((await h.engine.status()).status).toBe('synced');

    h.browser.openTab(0, 'https://c.example/');
    await h.engine.layoutChanged();
    await h.clock.advance(DEBOUNCE_MS, h.engine);
    expect(h.server.snapshots).toHaveLength(2);
  });
});

describe('disconnect', () => {
  it('clears the secret and state but keeps settings and server data', async () => {
    await setUp();
    await h.engine.updateSettings({ deviceName: 'Desk iMac' });
    await h.engine.disconnect();
    expect(await h.repo.credentials()).toBeUndefined();
    expect(await h.repo.state()).toEqual({});
    expect((await h.repo.settings()).deviceName).toBe('Desk iMac');
    expect(h.server.snapshots).toHaveLength(1);
    expect(h.browser.badge?.text).toBe('');
  });

  it('reveals the stored secret', async () => {
    const secret = await setUp();
    expect(await h.engine.revealSecret()).toBe(secret);
  });
});

describe('two profiles on one machine', () => {
  it('use different secrets and never see each other’s data', async () => {
    const secretA = await setUp();
    const server = h.server;
    const other = createHarness();
    (other.engine as unknown as { deps: { createApi: unknown } }).deps.createApi = (
      _: string,
      c: never,
    ) => server.api(c);
    other.browser.addWindow(['https://profile-b.example/']);
    const { secret: secretB } = await other.engine.createProfile();
    expect(secretB).not.toBe(secretA);

    const keysA = await deriveProfileKeys(parseSecret(secretA));
    const keysB = await deriveProfileKeys(parseSecret(secretB));
    expect(server.snapshots.filter((s) => s.profileId === keysA.profileId)).toHaveLength(1);
    expect(server.snapshots.filter((s) => s.profileId === keysB.profileId)).toHaveLength(1);
    const latestForA = await server.api(keysA).latest();
    expect(latestForA.status === 'ok' && latestForA.snapshot.id).toBe(server.snapshots[0]!.id);
  });
});

async function createFreshEngine() {
  // A new engine instance over the same storage, without wake() (as if woken by the alarm).
  const { SyncEngine } = await import('../src/lib/engine');
  const engine = new SyncEngine({
    ...(h.engine as unknown as { deps: ConstructorParameters<typeof SyncEngine>[0] }).deps,
  });
  return { engine };
}
