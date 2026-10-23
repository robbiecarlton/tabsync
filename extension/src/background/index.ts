import { HttpSyncApi } from '../lib/api';
import { chromeBrowser } from '../lib/browser';
import { SyncEngine } from '../lib/engine';
import { createLogger, LOG_KEY, type LogLine } from '../lib/logger';
import type { Reply, Request } from '../lib/messages';
import { ALARM_NAME, ALARM_PERIOD_MINUTES, PULL_MIN_INTERVAL_MS } from '../lib/schedule';
import { StateRepo } from '../lib/state';
import { ChromeStore } from '../lib/store';

const store = new ChromeStore();
const repo = new StateRepo(store);
const log = createLogger(store);

const engine = new SyncEngine({
  repo,
  browser: chromeBrowser,
  createApi: (serverUrl, creds) => new HttpSyncApi(serverUrl, creds),
  now: Date.now,
  randomId: () => crypto.randomUUID(),
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  log,
});

// MV3: listeners must be registered synchronously at the top level so events that wake the
// worker are delivered.
const changed = () => void engine.layoutChanged();

chrome.tabs.onCreated.addListener(changed);
chrome.tabs.onRemoved.addListener(changed);
chrome.tabs.onMoved.addListener(changed);
chrome.tabs.onAttached.addListener(changed);
chrome.tabs.onDetached.addListener(changed);
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  // Only URL, pinned and group changes alter the fingerprint; ignore title/favicon/loading noise.
  if (info.url !== undefined || info.pinned !== undefined || info.groupId !== undefined) changed();
});
chrome.tabGroups.onCreated.addListener(changed);
chrome.tabGroups.onUpdated.addListener(changed);
chrome.tabGroups.onRemoved.addListener(changed);
chrome.tabGroups.onMoved.addListener(changed);
chrome.windows.onCreated.addListener(changed);
chrome.windows.onRemoved.addListener(changed);

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE)
    void engine.pull({ ifOlderThan: PULL_MIN_INTERVAL_MS });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void engine.tick();
});

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'status':
      return engine.status();
    case 'syncNow':
      await engine.syncNow();
      return engine.status();
    case 'pull':
      await engine.pull();
      return engine.status();
    case 'apply':
      await engine.applyRemote(request.mode, { closeSurplusWindows: request.closeSurplusWindows });
      return engine.status();
    case 'resolve':
      await engine.resolveConflict(request.choice);
      return engine.status();
    case 'history':
      return engine.history();
    case 'listSnapshots':
      return engine.listSnapshots();
    case 'getSnapshot':
      return engine.getSnapshot(request.id);
    case 'restore':
      await engine.restore(request.snapshotId, request.mode, {
        closeSurplusWindows: request.closeSurplusWindows,
      });
      return engine.status();
    case 'createProfile':
      return engine.createProfile();
    case 'joinProfile':
      await engine.joinProfile(request.secret);
      return null;
    case 'revealSecret':
      return (await engine.revealSecret()) ?? null;
    case 'disconnect':
      await engine.disconnect();
      return null;
    case 'updateSettings':
      return engine.updateSettings(request.patch);
    case 'debugLog':
      return (await store.get<LogLine[]>(LOG_KEY)) ?? [];
  }
}

chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(request).then(
    (value) => sendResponse({ ok: true, value } satisfies Reply),
    (err: unknown) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies Reply),
  );
  return true; // respond asynchronously
});

async function start() {
  if (!(await chrome.alarms.get(ALARM_NAME))) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  }
  // storage.session is cleared when the browser restarts (and on extension reload), so an empty
  // session means session restore may still be opening tabs.
  const { awake } = await chrome.storage.session.get('awake');
  await chrome.storage.session.set({ awake: true });
  await engine.wake({ freshSession: !awake });
}

void start();
