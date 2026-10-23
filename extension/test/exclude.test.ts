import {
  decryptSnapshot,
  deriveProfileKeys,
  fromBase64Url,
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

const urlsOf = async (h: Harness) =>
  captureLayout(await h.browser.getWindows(), await h.browser.getGroups()).flatMap((w) =>
    w.tabs.map((t) => t.url),
  );

async function snapshots(): Promise<Snapshot[]> {
  const keys = await deriveProfileKeys(parseSecret(secret));
  return Promise.all(
    laptop.server.snapshots.map((s) =>
      decryptSnapshot(fromBase64Url(s.blob), keys, { id: s.id, createdAt: s.createdAt }),
    ),
  );
}
const latestUrls = async () =>
  (await snapshots())
    .filter((s) => s.reason !== 'pre-restore')
    .at(-1)!
    .windows.flatMap((w) => w.tabs.map((t) => t.url));

async function settle(h: Harness) {
  await h.clock.advance(Math.max(DEBOUNCE_MS, ECHO_GRACE_MS) + 1, h.engine);
}

beforeEach(async () => {
  laptop = createHarness();
  laptop.browser.addWindow(['https://a.example/', 'https://www.bank.com/accounts']);
  await laptop.engine.wake({ freshSession: false });
  secret = (await laptop.engine.createProfile()).secret;

  desk = createHarness({ server: laptop.server, clock: laptop.clock });
  desk.browser.addWindow(['https://a.example/', 'https://bank.com/', 'https://desk.example/']);
  await desk.engine.wake({ freshSession: false });
  await desk.engine.updateSettings({ excludeList: '# never sync banking\nbank.com' });
  await desk.engine.joinProfile(secret);
});

describe('exclude list', () => {
  it('keeps excluded sites out of snapshots, and syncs promptly when the list changes', async () => {
    expect(await latestUrls()).toContain('https://www.bank.com/accounts');
    await laptop.engine.updateSettings({ excludeList: 'bank.com' });
    expect((await laptop.engine.status()).status).toBe('pending');
    await settle(laptop);
    expect(await latestUrls()).toEqual(['https://a.example/']);
    expect(await urlsOf(laptop)).toContain('https://www.bank.com/accounts'); // the tab itself stays open
  });

  it('a list change before setup does nothing until there is a profile', async () => {
    const fresh = createHarness();
    fresh.browser.addWindow(['https://x/']);
    await fresh.engine.updateSettings({ excludeList: 'x' });
    expect((await fresh.engine.status()).status).toBe('not-setup');
  });

  it('ignores excluded tabs in the Behind summary', async () => {
    // Laptop has [a, bank]; Desk excludes bank, so it sees only [a] vs its own [a, desk].
    expect((await desk.engine.status()).behind?.summary).toBe('1 closed');
  });

  it('never opens an excluded site from another device, and never closes one here', async () => {
    await desk.engine.applyRemote('match-exactly');
    expect(await urlsOf(desk)).toEqual(['https://a.example/', 'https://bank.com/']);
  });

  it('pushes snapshots without excluded sites after applying', async () => {
    await desk.engine.applyRemote('add-missing');
    await settle(desk);
    desk.browser.openTab(0, 'https://new.example/');
    await desk.engine.layoutChanged();
    await settle(desk);
    const latest = await latestUrls();
    expect(latest).toContain('https://new.example/');
    expect(latest.some((u) => u.includes('bank.com'))).toBe(false);
  });

  it('adopts a newer snapshot silently when it differs only by excluded tabs', async () => {
    desk.browser.windows[0]!.tabs = desk.browser.windows[0]!.tabs.filter(
      (t) => t.url !== 'https://desk.example/',
    );
    await desk.engine.layoutChanged();
    await settle(desk);
    expect((await desk.engine.status()).status).toBe('synced');
  });
});

describe('captureLayout with an exclude list', () => {
  it('drops matching tabs', async () => {
    const { parseExcludeList } = await import('@tabsync/shared');
    const layout = captureLayout(
      await desk.browser.getWindows(),
      [],
      parseExcludeList('bank.com').rules,
    );
    expect(layout[0]!.tabs.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://desk.example/',
    ]);
  });
});
