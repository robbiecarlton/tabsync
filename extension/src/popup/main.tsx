import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { StatusView } from '../lib/engine';
import { send } from '../lib/messages';
import { STATUS_TEXT, timeAgo } from '../ui/format';
import '../ui/styles.css';

function Popup() {
  const [view, setView] = useState<StatusView>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const refresh = useCallback(() => {
    send<'status'>({ type: 'status' }).then(setView, (e: Error) => setProblem(e.message));
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    chrome.storage.onChanged.addListener(onChange);
    const timer = setInterval(refresh, 15_000); // keep "x min ago" fresh
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(timer);
    };
  }, [refresh]);

  const syncNow = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      setView(await send<'syncNow'>({ type: 'syncNow' }));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view)
    return (
      <main class="popup">
        {problem ? <p class="error-text">{problem}</p> : <p class="muted">Loading…</p>}
      </main>
    );

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
          {view.settings.deviceName} · last push {timeAgo(view.lastPushAt, now)}
        </p>
      </div>

      {view.lastError && view.status !== 'synced' && (
        <div class="card">
          <p class="error-text">{view.lastError.message}</p>
          <p class="muted small">since {timeAgo(view.lastError.at, now)}</p>
        </div>
      )}
      {problem && <p class="error-text">{problem}</p>}

      <div class="row">
        <button class="primary" disabled={busy} onClick={syncNow}>
          {busy ? 'Syncing…' : view.lastError ? 'Retry' : 'Sync now'}
        </button>
        <button onClick={() => chrome.runtime.openOptionsPage()}>Options</button>
      </div>
    </main>
  );
}

render(<Popup />, document.getElementById('app')!);
