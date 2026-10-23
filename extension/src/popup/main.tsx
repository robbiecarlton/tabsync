import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { BehindInfo, StatusView } from '../lib/engine';
import { send } from '../lib/messages';
import type { ApplyMode } from '../lib/reconcile';
import { STATUS_TEXT, timeAgo } from '../ui/format';
import '../ui/styles.css';

function ModeChoice({ mode, onChange }: { mode: ApplyMode; onChange: (m: ApplyMode) => void }) {
  return (
    <div class="choices">
      <label class="choice">
        <input
          type="radio"
          name="mode"
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
          name="mode"
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

function Popup() {
  const [view, setView] = useState<StatusView>();
  const [busy, setBusy] = useState<'sync' | 'apply'>();
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

  const act = async (kind: 'sync' | 'apply', task: () => Promise<StatusView>) => {
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
    </main>
  );
}

render(<Popup />, document.getElementById('app')!);
