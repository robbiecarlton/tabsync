import {
  canonicalLayout,
  decryptSnapshot,
  deriveProfileKeys,
  fromBase64Url,
  parseSecret,
  type Snapshot,
} from '@tabsync/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureLayout } from '../src/lib/capture';
import { ApplyError } from '../src/lib/engine';
import { applyLayout } from '../src/lib/reconcile';
import { DEBOUNCE_MS, ECHO_GRACE_MS, PULL_MIN_INTERVAL_MS } from '../src/lib/schedule';
import { createHarness, type Harness } from './fakes';

/** Laptop creates the profile; Desk joins it. Both share one server and clock. */
let laptop: Harness;
let desk: Harness;
let secret: string;

async function layoutOf(h: Harness) {
  return captureLayout(await h.browser.getWindows(), await h.browser.getGroups());
}

async function decryptAll(): Promise<Snapshot[]> {
  const keys = await deriveProfileKeys(parseSecret(secret));
  return Promise.all(
    laptop.server.snapshots.map((s) =>
      decryptSnapshot(fromBase64Url(s.blob), keys, { id: s.id, createdAt: s.createdAt }),
    ),
  );
}

async function settle(h: Harness) {
  await h.clock.advance(Math.max(DEBOUNCE_MS, ECHO_GRACE_MS) + 1, h.engine);
}

beforeEach(async () => {
  laptop = createHarness();
  laptop.browser.addWindow(['https://a.example/', 'https://b.example/']);
  await laptop.engine.wake({ freshSession: false });
  await laptop.engine.updateSettings({ deviceName: 'Laptop' });
  secret = (await laptop.engine.createProfile()).secret;

  desk = createHarness({ server: laptop.server, clock: laptop.clock });
  desk.browser.addWindow(['https://a.example/', 'https://desk-only.example/']);
  await desk.engine.wake({ freshSession: false });
  await desk.engine.updateSettings({ deviceName: 'Desk' });
  await desk.engine.joinProfile(secret);
});

describe('behind detection', () => {
  it('reports the newer snapshot with a summary of what would change', async () => {
    const status = await desk.engine.status();
    expect(status.status).toBe('behind');
    expect(status.behind).toMatchObject({
      deviceName: 'Laptop',
      summary: '1 opened, 1 closed',
      surplusWindows: 0,
    });
    expect(desk.browser.badge?.title).toBe('Tab Sync: Laptop has newer tabs');
  });

  it('notices a later push from the other device on pull', async () => {
    await desk.engine.applyRemote('add-missing');
    await settle(desk);
    expect((await desk.engine.status()).status).toBe('synced');

    laptop.browser.openTab(0, 'https://c.example/');
    await laptop.engine.layoutChanged();
    await settle(laptop);

    await desk.engine.pull();
    const status = await desk.engine.status();
    expect(status.status).toBe('behind');
    expect(status.behind?.summary).toBe('1 opened, 1 closed');
  });

  it('polls cheaply with If-None-Match and does not treat its own push as newer', async () => {
    await laptop.engine.pull();
    await laptop.engine.pull();
    expect((await laptop.engine.status()).status).toBe('synced');
  });

  it('throttles window-focus pulls to one per 30 seconds', async () => {
    const before = laptop.server.latestCalls;
    await desk.engine.pull({ ifOlderThan: PULL_MIN_INTERVAL_MS });
    expect(laptop.server.latestCalls).toBe(before); // join just pulled
    desk.clock.now += PULL_MIN_INTERVAL_MS;
    await desk.engine.pull({ ifOlderThan: PULL_MIN_INTERVAL_MS });
    expect(laptop.server.latestCalls).toBe(before + 1);
  });

  it('adopts a newer snapshot silently when the tabs are already identical', async () => {
    await desk.engine.applyRemote('match-exactly');
    await settle(desk);
    // Both machines independently end up with the same layout; Laptop pushes it.
    laptop.browser.openTab(0, 'https://same.example/');
    desk.browser.openTab(0, 'https://same.example/');
    await laptop.engine.layoutChanged();
    await settle(laptop);
    await desk.engine.layoutChanged();
    await desk.engine.pull();
    await settle(desk);
    expect((await desk.engine.status()).status).toBe('synced');
    expect(laptop.server.snapshots.filter((s) => s.kind === 'auto')).toHaveLength(2);
  });

  it('reports a snapshot that fails to decrypt as an Error', async () => {
    laptop.browser.openTab(0, 'https://c.example/');
    await laptop.engine.syncNow();
    const latest = laptop.server.snapshots.at(-1)!;
    latest.blob = latest.blob.slice(0, -4) + 'AAAA';
    await desk.engine.pull();
    const status = await desk.engine.status();
    expect(status.status).toBe('error');
    expect(status.lastError?.kind).toBe('decrypt');
  });

  it('holds pushes while behind; local edits make it a conflict', async () => {
    desk.browser.openTab(0, 'https://desk-edit.example/');
    await desk.engine.layoutChanged();
    await settle(desk);
    await desk.engine.syncNow();
    expect(laptop.server.snapshots.filter((s) => s.kind === 'auto')).toHaveLength(1);
    expect((await desk.engine.status()).status).toBe('conflict');
  });
});

describe('apply', () => {
  it('adds missing tabs, keeps local ones, and saves an undo point first', async () => {
    await desk.engine.applyRemote('add-missing');
    expect((await layoutOf(desk))[0]!.tabs.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://desk-only.example/',
    ]);
    const snaps = await decryptAll();
    const preRestore = snaps.find((s) => s.reason === 'pre-restore')!;
    expect(preRestore.device.name).toBe('Desk');
    expect(preRestore.windows[0]!.tabs.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://desk-only.example/',
    ]);
  });

  it('makes it match exactly, and remembers the chosen mode', async () => {
    await desk.engine.applyRemote('match-exactly');
    expect(canonicalLayout(await layoutOf(desk))).toBe(canonicalLayout(await layoutOf(laptop)));
    expect((await desk.repo.settings()).applyMode).toBe('match-exactly');
  });

  it('defaults to add missing only on first use', async () => {
    expect((await desk.repo.settings()).applyMode).toBe('add-missing');
  });

  it('closes surplus windows only when asked', async () => {
    desk.browser.addWindow(['https://unrelated.example/']);
    expect((await desk.engine.status()).behind?.surplusWindows).toBe(1);
    await desk.engine.applyRemote('match-exactly');
    expect(desk.browser.windows).toHaveLength(2);
    await desk.engine.applyRemote('match-exactly', { closeSurplusWindows: true });
    expect(desk.browser.windows).toHaveLength(1);
  });

  it('does not push the applied result back (echo suppression)', async () => {
    const uploads = laptop.server.uploads;
    await desk.engine.applyRemote('add-missing');
    // Tab events caused by the apply arrive late.
    await desk.engine.layoutChanged();
    await desk.engine.layoutChanged();
    expect((await desk.engine.status()).status).toBe('synced'); // no Pending flicker
    await settle(desk);
    await desk.clock.advance(60_000, desk.engine);
    await desk.engine.tick();
    expect(laptop.server.uploads).toBe(uploads + 1); // just the pre-restore
    const status = await desk.engine.status();
    expect(status.status).toBe('synced');
    expect((await desk.repo.state()).baseSnapshotId).toBe(laptop.server.snapshots[0]!.id);
  });

  it('still pushes a real edit made during the echo window', async () => {
    await desk.engine.applyRemote('add-missing');
    desk.browser.openTab(0, 'https://quick-edit.example/');
    await desk.engine.layoutChanged();
    await settle(desk);
    const autos = (await decryptAll()).filter((s) => s.reason === 'auto');
    expect(autos).toHaveLength(2);
    expect(autos[1]!.windows[0]!.tabs.map((t) => t.url)).toContain('https://quick-edit.example/');
  });

  it('changes nothing when the undo point cannot be saved', async () => {
    const before = canonicalLayout(await layoutOf(desk));
    laptop.server.offline = true;
    await expect(desk.engine.applyRemote('match-exactly')).rejects.toThrow(ApplyError);
    expect(canonicalLayout(await layoutOf(desk))).toBe(before);
    expect((await desk.engine.status()).status).toBe('behind');
  });

  it('explains a browser failure partway through, after the undo point was saved', async () => {
    laptop.browser.addWindow(['https://laptop-second-window.example/']);
    await laptop.engine.syncNow();
    await desk.engine.pull();
    desk.browser.failCreateWindow = 'Invalid value for state';
    const err = await desk.engine.applyRemote('add-missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplyError);
    expect((err as Error).message).toMatch(
      /Invalid value for state.*previous tabs were saved first/,
    );
    expect((await decryptAll()).some((s) => s.reason === 'pre-restore')).toBe(true);
    // Echo suppression is released, so later edits still count.
    desk.browser.failCreateWindow = undefined;
    await desk.engine.applyRemote('add-missing');
    expect((await desk.engine.status()).status).toBe('synced');
  });

  it('the pre-restore snapshot restores the previous layout', async () => {
    const original = await layoutOf(desk);
    await desk.engine.applyRemote('match-exactly');
    const preRestore = (await decryptAll()).find((s) => s.reason === 'pre-restore')!;
    await applyLayout(desk.browser, preRestore.windows, { mode: 'match-exactly' });
    expect(canonicalLayout(await layoutOf(desk))).toBe(canonicalLayout(original));
  });

  it('pre-restore snapshots never become the server’s latest', async () => {
    await desk.engine.applyRemote('add-missing');
    await laptop.engine.pull();
    expect((await laptop.engine.status()).status).toBe('synced');
  });
});
