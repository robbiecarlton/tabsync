import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { StatusView } from '../lib/engine';
import type { LogLine } from '../lib/logger';
import { send } from '../lib/messages';
import { SERVER_HOST_PERMISSIONS } from '../manifest';
import { STATUS_TEXT, timeAgo } from '../ui/format';
import '../ui/styles.css';

/** Asks for host permission for a custom server URL. Must run inside a click handler. */
async function ensureServerPermission(serverUrl: string): Promise<boolean> {
  const origin = `${new URL(serverUrl).origin}/*`;
  if (SERVER_HOST_PERMISSIONS.includes(origin)) return true;
  return chrome.permissions.request({ origins: [origin] });
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function SettingsCard({ view, onSaved }: { view: StatusView; onSaved: () => void }) {
  const [serverUrl, setServerUrl] = useState(view.settings.serverUrl);
  const [deviceName, setDeviceName] = useState(view.settings.deviceName);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const dirty = serverUrl !== view.settings.serverUrl || deviceName !== view.settings.deviceName;

  const save = async () => {
    setMessage(undefined);
    const url = serverUrl.trim().replace(/\/+$/, '');
    if (!validUrl(url)) return setMessage({ text: 'Enter a valid http(s) URL.', error: true });
    if (!deviceName.trim()) return setMessage({ text: 'Device name can’t be empty.', error: true });
    if (!(await ensureServerPermission(url))) {
      return setMessage({ text: 'Permission to reach that server was not granted.', error: true });
    }
    await send<'updateSettings'>({
      type: 'updateSettings',
      patch: { serverUrl: url, deviceName: deviceName.trim() },
    });
    setMessage({ text: 'Saved.' });
    onSaved();
  };

  return (
    <section class="card stack">
      <h2>This device</h2>
      <div>
        <label for="device">Device name</label>
        <input
          id="device"
          value={deviceName}
          onInput={(e) => setDeviceName(e.currentTarget.value)}
        />
        <p class="muted small">Shown on the other machine, e.g. “Laptop has newer tabs”.</p>
      </div>
      <div>
        <label for="server">Server URL</label>
        <input id="server" value={serverUrl} onInput={(e) => setServerUrl(e.currentTarget.value)} />
      </div>
      <div class="row">
        <button class="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
        {message && <span class={message.error ? 'error-text' : 'muted'}>{message.text}</span>}
      </div>
    </section>
  );
}

function SecretDisplay({ secret, onDone }: { secret: string; onDone?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div class="stack">
      <div class="secret">{secret}</div>
      <div class="row">
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {onDone && (
        <>
          <p class="warning">
            Save this secret in your password manager now. It’s the only way to connect another
            machine, and if it’s lost your synced history can’t be recovered.
          </p>
          <label class="row" style={{ fontWeight: 'normal' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={saved}
              onChange={(e) => setSaved(e.currentTarget.checked)}
            />
            I’ve saved it somewhere safe
          </label>
          <button class="primary" disabled={!saved} onClick={onDone}>
            Done
          </button>
        </>
      )}
    </div>
  );
}

function Setup({ onConnected }: { onConnected: (secret?: string) => void }) {
  const [mode, setMode] = useState<'choose' | 'join'>('choose');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const result = await send<'createProfile'>({ type: 'createProfile' });
      onConnected(result.secret);
    });

  const join = () =>
    run(async () => {
      await send<'joinProfile'>({ type: 'joinProfile', secret });
      onConnected();
    });

  return (
    <section class="card stack">
      <h2>Set up sync</h2>
      {mode === 'choose' ? (
        <>
          <p>
            Each Brave profile syncs separately. Create a new sync profile on your first machine,
            then join it from the others with its secret.
          </p>
          <div class="row">
            <button class="primary" disabled={busy} onClick={create}>
              {busy ? 'Creating…' : 'Create new sync profile'}
            </button>
            <button disabled={busy} onClick={() => setMode('join')}>
              I have a secret
            </button>
          </div>
        </>
      ) : (
        <>
          <div>
            <label for="secret">Secret</label>
            <textarea
              id="secret"
              rows={3}
              placeholder="XXXX-XXXX-…"
              value={secret}
              onInput={(e) => setSecret(e.currentTarget.value)}
            />
          </div>
          <div class="row">
            <button class="primary" disabled={busy || !secret.trim()} onClick={join}>
              {busy ? 'Joining…' : 'Join'}
            </button>
            <button disabled={busy} onClick={() => setMode('choose')}>
              Back
            </button>
          </div>
        </>
      )}
      {error && <p class="error-text">{error}</p>}
    </section>
  );
}

function Connected({ view, onDisconnected }: { view: StatusView; onDisconnected: () => void }) {
  const [secret, setSecret] = useState<string>();
  const [confirming, setConfirming] = useState<'reveal' | 'disconnect'>();
  const now = Date.now();

  return (
    <section class="card stack">
      <h2>
        <span class={`dot ${view.status}`} />
        {STATUS_TEXT[view.status]}
      </h2>
      <p class="muted small">
        Last push {timeAgo(view.lastPushAt, now)}
        {view.lastError && view.status !== 'synced' && (
          <>
            {' '}
            · <span class="error-text">{view.lastError.message}</span>
          </>
        )}
      </p>

      {secret ? (
        <SecretDisplay secret={secret} />
      ) : confirming === 'reveal' ? (
        <div class="row">
          <span>Show the secret on screen?</span>
          <button
            onClick={async () => {
              setSecret((await send<'revealSecret'>({ type: 'revealSecret' })) ?? undefined);
              setConfirming(undefined);
            }}
          >
            Show
          </button>
          <button onClick={() => setConfirming(undefined)}>Cancel</button>
        </div>
      ) : confirming === 'disconnect' ? (
        <div class="stack">
          <p>
            Disconnect this device? Its secret and sync state are removed here. Data on the server
            and other machines is untouched; you’ll need the secret to reconnect.
          </p>
          <div class="row">
            <button
              class="danger"
              onClick={async () => {
                await send<'disconnect'>({ type: 'disconnect' });
                onDisconnected();
              }}
            >
              Disconnect
            </button>
            <button onClick={() => setConfirming(undefined)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div class="row">
          <button onClick={() => setConfirming('reveal')}>Reveal secret</button>
          <button class="danger" onClick={() => setConfirming('disconnect')}>
            Disconnect
          </button>
        </div>
      )}
    </section>
  );
}

function DebugLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    const load = () => send<'debugLog'>({ type: 'debugLog' }).then(setLines, () => {});
    load();
    chrome.storage.onChanged.addListener(load);
    return () => chrome.storage.onChanged.removeListener(load);
  }, []);
  return (
    <section class="card stack">
      <h2>Debug log</h2>
      <div class="log">
        {lines.length === 0
          ? 'Nothing logged yet.'
          : [...lines]
              .reverse()
              .map((l) => `${new Date(l.at).toLocaleTimeString()}  ${l.message}`)
              .join('\n')}
      </div>
    </section>
  );
}

function Options() {
  const [view, setView] = useState<StatusView>();
  const [newSecret, setNewSecret] = useState<string>();
  const [problem, setProblem] = useState<string>();

  const refresh = useCallback(() => {
    send<'status'>({ type: 'status' }).then(setView, (e: Error) => setProblem(e.message));
  }, []);

  useEffect(() => {
    refresh();
    chrome.storage.onChanged.addListener(refresh);
    return () => chrome.storage.onChanged.removeListener(refresh);
  }, [refresh]);

  return (
    <main class="options stack">
      <h1>Tab Sync</h1>
      {problem && <p class="error-text">{problem}</p>}
      {view &&
        (newSecret ? (
          <section class="card stack">
            <h2>Your sync secret</h2>
            <SecretDisplay secret={newSecret} onDone={() => setNewSecret(undefined)} />
          </section>
        ) : view.status === 'not-setup' ? (
          <Setup
            onConnected={(secret) => {
              setNewSecret(secret);
              refresh();
            }}
          />
        ) : (
          <Connected view={view} onDisconnected={refresh} />
        ))}
      {view && <SettingsCard key={JSON.stringify(view.settings)} view={view} onSaved={refresh} />}
      <DebugLog />
    </main>
  );
}

render(<Options />, document.getElementById('app')!);
