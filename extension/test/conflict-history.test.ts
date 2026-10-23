import {
  canonicalLayout,
  DAY,
  decryptSnapshot,
  deriveProfileKeys,
  fromBase64Url,
  HOUR,
  MINUTE,
  parseSecret,
  type Snapshot,
} from '@tabsync/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureLayout } from '../src/lib/capture';
import { DEBOUNCE_MS, ECHO_GRACE_MS } from '../src/lib/schedule';
import { createHarness, type Harness } from './fakes';

let laptop: Harness;
let desk: Harness;
let secret: string;

const layoutOf = async (h: Harness) =>
  captureLayout(await h.browser.getWindows(), await h.browser.getGroups());
const urlsOf = async (h: Harness) => (await layoutOf(h)).flatMap((w) => w.tabs.map((t) => t.url));

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

async function edit(h: Harness, url: string, extra: { favIconUrl?: string } = {}) {
  h.browser.openTab(0, url, extra);
  await h.engine.layoutChanged();
  await settle(h);
}

/** Both devices synced on the laptop's layout [a, b]. */
beforeEach(async () => {
  laptop = createHarness();
  laptop.browser.addWindow(['https://a.example/', 'https://b.example/']);
  await laptop.engine.wake({ freshSession: false });
  await laptop.engine.updateSettings({ deviceName: 'Laptop' });
  secret = (await laptop.engine.createProfile()).secret;

  desk = createHarness({ server: laptop.server, clock: laptop.clock });
  desk.browser.addWindow(['chrome://newtab/']);
  await desk.engine.wake({ freshSession: false });
  await desk.engine.updateSettings({ deviceName: 'Desk' });
  await desk.engine.joinProfile(secret);
  await desk.engine.applyRemote('add-missing');
  await settle(desk);
});

describe('conflicts', () => {
  beforeEach(async () => {
    // Laptop pushes [a, b, laptop]; Desk, not having pulled yet, edits to [a, b, desk].
    await edit(laptop, 'https://laptop.example/');
    await edit(desk, 'https://desk.example/', { favIconUrl: 'https://desk.example/favicon.ico' });
  });

  it('detects the conflict before pushing instead of overwriting the other device', async () => {
    const autos = (await decryptAll()).filter((s) => s.reason === 'auto');
    expect(autos.map((s) => s.device.name)).toEqual(['Laptop', 'Laptop']);
    const status = await desk.engine.status();
    expect(status.status).toBe('conflict');
    expect(desk.browser.badge).toMatchObject({ text: '!', color: '#f9ab00' });
    expect(status.conflict).toMatchObject({
      deviceName: 'Laptop',
      onlyHere: [{ url: 'https://desk.example/', favIconUrl: 'https://desk.example/favicon.ico' }],
      onlyHereCount: 1,
      onlyThere: [{ url: 'https://laptop.example/' }],
      onlyThereCount: 1,
    });
    expect(status.behind).toBeUndefined();
  });

  it('becomes plain Behind if the local edit is undone', async () => {
    desk.browser.windows[0]!.tabs.pop();
    await desk.engine.layoutChanged();
    await settle(desk);
    expect((await desk.engine.status()).status).toBe('behind');
  });

  it('Keep mine pushes this layout on top of theirs', async () => {
    const theirs = laptop.server.snapshots.at(-1)!.id;
    await desk.engine.resolveConflict('keep-mine');
    const latest = (await decryptAll()).at(-1)!;
    expect(latest).toMatchObject({ reason: 'manual', parentSnapshotId: theirs });
    expect(latest.device.name).toBe('Desk');
    expect(latest.windows[0]!.tabs.map((t) => t.url)).toContain('https://desk.example/');
    expect((await desk.engine.status()).status).toBe('synced');

    await laptop.engine.pull();
    const laptopStatus = await laptop.engine.status();
    expect(laptopStatus.status).toBe('behind');
    expect(laptopStatus.behind?.summary).toBe('1 opened, 1 closed');
  });

  it('Take theirs makes this device match theirs, with an undo point, and pushes nothing', async () => {
    const uploads = laptop.server.uploads;
    await desk.engine.resolveConflict('take-theirs');
    await settle(desk);
    expect(canonicalLayout(await layoutOf(desk))).toBe(canonicalLayout(await layoutOf(laptop)));
    expect(laptop.server.uploads).toBe(uploads + 1);
    const preRestore = (await decryptAll()).at(-1)!;
    expect(preRestore.reason).toBe('pre-restore');
    expect(preRestore.windows[0]!.tabs.map((t) => t.url)).toContain('https://desk.example/');
    expect((await desk.engine.status()).status).toBe('synced');
  });

  it('Merge adds their tabs to mine and pushes the union', async () => {
    const theirs = laptop.server.snapshots.at(-1)!.id;
    await desk.engine.resolveConflict('merge');
    await settle(desk);
    expect(await urlsOf(desk)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://laptop.example/',
      'https://desk.example/',
    ]);
    const latest = (await decryptAll()).at(-1)!;
    expect(latest).toMatchObject({ reason: 'manual', parentSnapshotId: theirs });
    expect((await desk.engine.status()).status).toBe('synced');

    await laptop.engine.pull();
    expect((await laptop.engine.status()).behind?.summary).toBe('1 opened');
  });

  it('a conflict found by a pull (with nothing pushed yet) resolves the same way', async () => {
    // Desk's edit was held; a later pull still reports the conflict.
    await desk.engine.pull();
    expect((await desk.engine.status()).status).toBe('conflict');
  });
});

describe('history', () => {
  beforeEach(async () => {
    // Laptop edits at irregular times, ending up ~36 h, 2 h, 20 min, 3 min and 0 min old.
    for (const [i, gap] of [
      MINUTE,
      DAY + 10 * HOUR,
      100 * MINUTE,
      17 * MINUTE,
      3 * MINUTE,
    ].entries()) {
      await laptop.clock.advance(gap, laptop.engine);
      await edit(laptop, `https://step${i}.example/`);
    }
    await desk.engine.pull();
  });

  it('lists a restore point per label with real time and device, skipping repeats', async () => {
    const { points } = await desk.engine.history();
    expect(points.map((p) => p.label)).toEqual([
      '1 minute ago',
      '10 minutes ago',
      '1 hour ago',
      '1 day ago',
    ]);
    expect(points.every((p) => p.deviceName === 'Laptop' || p.deviceName === 'Desk')).toBe(true);
    expect(new Set(points.map((p) => p.snapshotId)).size).toBe(points.length);
    const oneDay = points.find((p) => p.label === '1 day ago')!;
    expect(desk.clock.now - Date.parse(oneDay.createdAt)).toBeGreaterThanOrEqual(DAY);
  });

  it('offers this device’s latest undo point', async () => {
    const { undo } = await desk.engine.history();
    expect(undo).toMatchObject({ kind: 'pre-restore', deviceName: 'Desk', mine: true });
    expect((await laptop.engine.history()).undo).toBeUndefined();
  });

  it('restores an older snapshot, saving an undo point and pushing the result', async () => {
    const { points } = await desk.engine.history();
    const target = points.find((p) => p.label === '1 day ago')!;
    await desk.engine.applyRemote('match-exactly');
    await settle(desk);

    await desk.engine.restore(target.snapshotId, 'match-exactly');
    await settle(desk);
    const restored = (await decryptAll()).find((s) => s.snapshotId === target.snapshotId)!;
    expect(canonicalLayout(await layoutOf(desk))).toBe(canonicalLayout(restored.windows));

    const snaps = await decryptAll();
    const latest = snaps.at(-1)!;
    expect(latest).toMatchObject({ reason: 'manual' });
    expect(latest.device.name).toBe('Desk');
    expect(snaps.at(-2)!.reason).toBe('pre-restore');
    expect((await desk.engine.status()).status).toBe('synced');

    await laptop.engine.pull();
    expect((await laptop.engine.status()).status).toBe('behind');
  });

  it('undo returns to the layout from before the last apply', async () => {
    const before = await layoutOf(desk);
    await desk.engine.applyRemote('match-exactly');
    await settle(desk);
    const { undo } = await desk.engine.history();
    await desk.engine.restore(undo!.snapshotId, 'match-exactly');
    expect(canonicalLayout(await layoutOf(desk))).toBe(canonicalLayout(before));
  });

  it('does not push when the restored layout already equals the server’s latest', async () => {
    await desk.engine.applyRemote('match-exactly');
    await settle(desk);
    const latestId = laptop.server.snapshots.filter((s) => s.kind !== 'pre-restore').at(-1)!.id;
    await desk.engine.restore(latestId, 'match-exactly');
    await settle(desk);
    expect(laptop.server.snapshots.filter((s) => s.kind === 'manual')).toHaveLength(0);
  });

  it('remembers the restore mode as the device’s choice', async () => {
    const { points } = await desk.engine.history();
    await desk.engine.restore(points[0]!.snapshotId, 'match-exactly');
    expect((await desk.repo.settings()).applyMode).toBe('match-exactly');
  });
});
