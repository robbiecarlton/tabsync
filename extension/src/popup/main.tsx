import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type {
  BehindInfo,
  TabSummary,
  ConflictChoice,
  ConflictInfo,
  HistoryEntry,
  HistoryView,
  StatusView,
} from '../lib/engine';
import { send } from '../lib/messages';
import type { ApplyMode } from '../lib/reconcile';
import { Favicon } from '../ui/Favicon';
import { formatWhen, STATUS_TEXT, timeAgo } from '../ui/format';
import '../ui/styles.css';

function ModeChoice({
  mode,
  onChange,
  name = 'mode',
}: {
  mode: ApplyMode;
  onChange: (m: ApplyMode) => void;
  name?: string;
}) {
  return (
    <div class="choices">
      <label class="choice">
        <input
          type="radio"
          name={name}
          checked={mode === 'add-missing'}
          onChange={() => onChange('add-missing')}
        />
        <span>
          <strong>Add missing only</strong>
          <span class="muted small"> · keep tabs that are only here</span>
        </span>
      </label>
      <label class="choice">
        <input
          type="radio"
          name={name}
          checked={mode === 'match-exactly'}
          onChange={() => onChange('match-exactly')}
        />
        <span>
          <strong>Make it match exactly</strong>
          <span class="muted small"> · close tabs that aren’t in theirs</span>
        </span>
      </label>
    </div>
  );
}

function BehindCard({
  behind,
  initialMode,
  onApply,
  busy,
}: {
  behind: BehindInfo;
  initialMode: ApplyMode;
  onApply: (mode: ApplyMode, closeSurplusWindows: boolean) => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState(initialMode);
  const [closeWindows, setCloseWindows] = useState(false);
  const surplus = behind.surplusWindows;
  return (
    <div class="card stack">
      <p>
        <strong>{behind.deviceName}</strong> has newer tabs ({behind.summary}).
      </p>
      <p class="muted small">Snapshot from {timeAgo(Date.parse(behind.createdAt), Date.now())}.</p>
      <ModeChoice mode={mode} onChange={setMode} />
      {behind.opened + behind.closed + behind.groupsChanged > 0 && (
        <details class="behind-diff">
          <summary>Show changes</summary>
          <div class="stack">
            <div>
              <p class="small">
                <strong>Will open ({behind.opened})</strong>
              </p>
              <TabList tabs={behind.openedTabs} total={behind.opened} />
            </div>
            <div>
              <p class="small">
                <strong>
                  {mode === 'match-exactly' ? 'Will close' : 'Only here, kept'} ({behind.closed})
                </strong>
              </p>
              <TabList tabs={behind.closedTabs} total={behind.closed} />
            </div>
            {behind.groupsChanged > 0 && (
              <p class="muted small">
                {behind.groupsChanged}{' '}
                {behind.groupsChanged === 1 ? 'group changes' : 'groups change'}
              </p>
            )}
          </div>
        </details>
      )}
      <button class="link-button" onClick={() => openSnapshots(`now/vs/${behind.snapshotId}`)}>
        See what changed in detail →
      </button>
      {mode === 'match-exactly' && surplus > 0 && (
        <label class="choice">
          <input
            type="checkbox"
            checked={closeWindows}
            onChange={(e) => setCloseWindows(e.currentTarget.checked)}
          />
          <span>
            Also close {surplus} other {surplus === 1 ? 'window' : 'windows'} not in theirs
          </span>
        </label>
      )}
      <div class="row">
        <button
          class="primary"
          disabled={busy}
          onClick={() => onApply(mode, mode === 'match-exactly' && closeWindows)}
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
        <span class="muted small">Your current tabs are saved first, so this can be undone.</span>
      </div>
    </div>
  );
}

/** Opens the snapshot browser, optionally on one snapshot. */
function openSnapshots(route?: string) {
  void chrome.tabs.create({
    url: chrome.runtime.getURL(`snapshots.html${route ? `#${route}` : ''}`),
  });
}

function TabList({ tabs, total }: { tabs: TabSummary[]; total: number }) {
  if (total === 0) return <p class="muted small">None</p>;
  return (
    <ul class="tab-list">
      {tabs.map((t) => (
        <li key={t.url} title={t.url}>
          <Favicon key={t.url} pageUrl={t.url} stored={t.favIconUrl} />
          <span>{t.title}</span>
        </li>
      ))}
      {total > tabs.length && <li class="muted">+{total - tabs.length} more</li>}
    </ul>
  );
}

function ConflictCard({
  conflict,
  onResolve,
  busy,
}: {
  conflict: ConflictInfo;
  onResolve: (choice: ConflictChoice) => void;
  busy: boolean;
}) {
  const other = conflict.deviceName;
  return (
    <div class="card stack">
      <p>
        Tabs changed here and on <strong>{other}</strong> (snapshot from{' '}
        {timeAgo(Date.parse(conflict.createdAt), Date.now())}).
      </p>
      <div>
        <p class="small">
          <strong>Only here</strong>
        </p>
        <TabList tabs={conflict.onlyHere} total={conflict.onlyHereCount} />
      </div>
      <div>
        <p class="small">
          <strong>Only on {other}</strong>
        </p>
        <TabList tabs={conflict.onlyThere} total={conflict.onlyThereCount} />
      </div>
      {conflict.groupsChanged > 0 && (
        <p class="muted small">
          {conflict.groupsChanged}{' '}
          {conflict.groupsChanged === 1 ? 'group differs' : 'groups differ'}
        </p>
      )}
      <button class="link-button" onClick={() => openSnapshots(`now/vs/${conflict.snapshotId}`)}>
        Compare in detail →
      </button>
      <div class="resolve">
        <button class="primary" disabled={busy} onClick={() => onResolve('merge')}>
          Merge
        </button>
        <span class="muted small">Add {other}’s tabs here, then sync the result</span>
        <button disabled={busy} onClick={() => onResolve('keep-mine')}>
          Keep mine
        </button>
        <span class="muted small">Sync this device’s tabs; {other}’s stay in history</span>
        <button disabled={busy} onClick={() => onResolve('take-theirs')}>
          Take theirs
        </button>
        <span class="muted small">Make this device match {other} (your tabs are saved first)</span>
      </div>
    </div>
  );
}

function HistoryRow({
  entry,
  label,
  initialMode,
  onRestore,
  busy,
}: {
  entry: HistoryEntry;
  label: string;
  initialMode: ApplyMode;
  onRestore: (mode: ApplyMode, closeSurplusWindows: boolean) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(initialMode);
  const [closeWindows, setCloseWindows] = useState(false);
  const now = Date.now();
  return (
    <li class="history-row">
      <div class="row spread">
        <div>
          <div>{label}</div>
          <div class="muted small">
            {formatWhen(Date.parse(entry.createdAt), now)} ·{' '}
            {entry.mine ? 'this device' : entry.deviceName} · {entry.tabCount}{' '}
            {entry.tabCount === 1 ? 'tab' : 'tabs'}
            {entry.kind === 'pre-restore' && ' · before a restore'}
          </div>
        </div>
        {!open && (
          <div class="row" style={{ flexWrap: 'nowrap' }}>
            <button onClick={() => openSnapshots(entry.snapshotId)}>View</button>
            <button disabled={busy} onClick={() => setOpen(true)}>
              Restore
            </button>
          </div>
        )}
      </div>
      {open && (
        <div class="stack restore-options">
          <ModeChoice mode={mode} onChange={setMode} name={`mode-${entry.snapshotId}`} />
          {mode === 'match-exactly' && entry.surplusWindows > 0 && (
            <label class="choice">
              <input
                type="checkbox"
                checked={closeWindows}
                onChange={(e) => setCloseWindows(e.currentTarget.checked)}
              />
              <span>
                Also close {entry.surplusWindows} other{' '}
                {entry.surplusWindows === 1 ? 'window' : 'windows'}
              </span>
            </label>
          )}
          <div class="row">
            <button
              class="primary"
              disabled={busy}
              onClick={() => onRestore(mode, mode === 'match-exactly' && closeWindows)}
            >
              {busy ? 'Restoring…' : 'Restore'}
            </button>
            <button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function History({
  initialMode,
  busy,
  onRestore,
}: {
  initialMode: ApplyMode;
  busy: boolean;
  onRestore: (snapshotId: string, mode: ApplyMode, closeSurplusWindows: boolean) => void;
}) {
  const [history, setHistory] = useState<HistoryView>();
  const [error, setError] = useState<string>();
  const load = () => {
    setError(undefined);
    send<'history'>({ type: 'history' }).then(setHistory, (e: Error) => setError(e.message));
  };
  return (
    <details
      class="card"
      onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !history && load()}
    >
      <summary>History</summary>
      <div class="stack" style={{ marginTop: '10px' }}>
        {error && <p class="error-text">{error}</p>}
        {!history && !error && <p class="muted small">Loading…</p>}
        {history && (
          <ul class="history">
            {history.undo && (
              <HistoryRow
                entry={history.undo}
                label="Undo last apply or restore"
                initialMode="match-exactly"
                busy={busy}
                onRestore={(mode, close) => onRestore(history.undo!.snapshotId, mode, close)}
              />
            )}
            {history.points.map((p) => (
              <HistoryRow
                key={p.snapshotId}
                entry={p}
                label={p.label}
                initialMode={initialMode}
                busy={busy}
                onRestore={(mode, close) => onRestore(p.snapshotId, mode, close)}
              />
            ))}
            {history.points.length === 0 && !history.undo && (
              <li class="muted small">No history yet.</li>
            )}
          </ul>
        )}
        <p class="muted small">
          Restoring saves your current tabs first and syncs the result to your other devices.
        </p>
        <button class="link-button" onClick={() => openSnapshots()}>
          Browse all snapshots →
        </button>
      </div>
    </details>
  );
}

function Popup() {
  const [view, setView] = useState<StatusView>();
  const [busy, setBusy] = useState<'sync' | 'apply' | 'resolve' | 'restore'>();
  const [problem, setProblem] = useState<string>();

  const refresh = useCallback(() => {
    send<'status'>({ type: 'status' }).then(setView, (e: Error) => setProblem(e.message));
  }, []);

  useEffect(() => {
    // Opening the popup checks the server for newer tabs.
    send<'pull'>({ type: 'pull' }).then(setView, () => refresh());
    const onChange = () => refresh();
    chrome.storage.onChanged.addListener(onChange);
    const timer = setInterval(refresh, 15_000); // keep "x min ago" fresh
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(timer);
    };
  }, [refresh]);

  const act = async (kind: NonNullable<typeof busy>, task: () => Promise<StatusView>) => {
    setBusy(kind);
    setProblem(undefined);
    try {
      setView(await task());
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (!view) {
    return (
      <main class="popup">
        {problem ? <p class="error-text">{problem}</p> : <p class="muted">Loading…</p>}
      </main>
    );
  }

  if (view.status === 'not-setup') {
    return (
      <main class="popup stack">
        <h1>Tab Sync</h1>
        <p>Sync isn’t set up on this profile yet.</p>
        <button class="primary" onClick={() => chrome.runtime.openOptionsPage()}>
          Set up sync
        </button>
      </main>
    );
  }

  const now = Date.now();
  return (
    <main class="popup stack">
      <div>
        <h1>
          <span class={`dot ${view.status}`} />
          {STATUS_TEXT[view.status]}
        </h1>
        <p class="muted small">
          {view.settings.deviceName} · pushed {timeAgo(view.lastPushAt, now)} · checked{' '}
          {timeAgo(view.lastPullAt, now)}
          {view.latestDevice && view.status === 'synced' && <> · latest from {view.latestDevice}</>}
        </p>
      </div>

      {view.behind && (
        <BehindCard
          behind={view.behind}
          initialMode={view.settings.applyMode}
          busy={busy === 'apply'}
          onApply={(mode, closeSurplusWindows) =>
            act('apply', () => send<'apply'>({ type: 'apply', mode, closeSurplusWindows }))
          }
        />
      )}

      {view.conflict && (
        <ConflictCard
          conflict={view.conflict}
          busy={busy === 'resolve'}
          onResolve={(choice) => act('resolve', () => send<'resolve'>({ type: 'resolve', choice }))}
        />
      )}

      {view.lastError && view.status === 'error' && (
        <div class="card">
          <p class="error-text">{view.lastError.message}</p>
          <p class="muted small">since {timeAgo(view.lastError.at, now)}</p>
        </div>
      )}
      {problem && <p class="error-text">{problem}</p>}

      <div class="row">
        <button
          disabled={!!busy}
          onClick={() => act('sync', () => send<'syncNow'>({ type: 'syncNow' }))}
        >
          {busy === 'sync' ? 'Syncing…' : view.status === 'error' ? 'Retry' : 'Sync now'}
        </button>
        <button onClick={() => chrome.runtime.openOptionsPage()}>Options</button>
      </div>

      <History
        initialMode={view.settings.applyMode}
        busy={busy === 'restore'}
        onRestore={(snapshotId, mode, closeSurplusWindows) =>
          act('restore', () =>
            send<'restore'>({ type: 'restore', snapshotId, mode, closeSurplusWindows }),
          )
        }
      />
    </main>
  );
}

render(<Popup />, document.getElementById('app')!);
