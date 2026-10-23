import {
  resolveRestorePoints,
  type GroupColor,
  type Snapshot,
  type SnapTab,
} from '@tabsync/shared';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SnapshotMeta } from '../lib/api';
import { chromeBrowser } from '../lib/browser';
import { send } from '../lib/messages';
import { openGroup, openTab } from '../lib/open';
import { Favicon } from '../ui/Favicon';
import { formatWhen } from '../ui/format';
import { groupByDay, hostOf, KIND_LABEL, windowSections, type Section } from '../ui/snapshot-view';
import '../ui/styles.css';

/** Chrome's tab group palette. */
const GROUP_COLORS: Record<GroupColor, string> = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};

const currentWindowId = () => chrome.windows.getCurrent().then((w) => w.id!);
const idFromHash = () => decodeURIComponent(location.hash.slice(1)) || undefined;

function TabRow({ tab }: { tab: SnapTab }) {
  const open = async (e: MouseEvent) => {
    await openTab(chromeBrowser, await currentWindowId(), tab, {
      active: !(e.metaKey || e.ctrlKey),
    });
  };
  return (
    <li class="snap-tab">
      <Favicon key={tab.url} pageUrl={tab.url} stored={tab.favIconUrl} />
      <button class="link" title={tab.url} onClick={open}>
        {tab.title || tab.url}
      </button>
      <span class="muted small host">{hostOf(tab.url)}</span>
      {tab.pinned && <span class="tag">Pinned</span>}
    </li>
  );
}

function GroupSection({ section }: { section: Section }) {
  const [opened, setOpened] = useState(false);
  const g = section.group!;
  return (
    <li class="snap-group" style={{ borderColor: GROUP_COLORS[g.color] }}>
      <div class="row spread">
        <span class="group-chip" style={{ background: GROUP_COLORS[g.color] }}>
          {g.title || 'Untitled group'}
        </span>
        <span class="muted small">
          {section.tabs.length} {section.tabs.length === 1 ? 'tab' : 'tabs'}
          {g.collapsed && ' · collapsed'}
        </span>
        <button
          onClick={async () => {
            await openGroup(chromeBrowser, await currentWindowId(), g, section.tabs);
            setOpened(true);
          }}
        >
          {opened ? 'Opened' : 'Open group'}
        </button>
      </div>
      <ul class="snap-tabs">
        {section.tabs.map((t, i) => (
          <TabRow key={`${t.url}-${i}`} tab={t} />
        ))}
      </ul>
    </li>
  );
}

function SnapshotDetail({ snapshot, label }: { snapshot: Snapshot; label?: string }) {
  const tabCount = snapshot.windows.reduce((n, w) => n + w.tabs.length, 0);
  return (
    <div class="stack">
      <div>
        <h2>
          {formatWhen(Date.parse(snapshot.createdAt), Date.now())} · {snapshot.device.name}
        </h2>
        <p class="muted small">
          {KIND_LABEL[snapshot.reason]}
          {label && ` · ${label}`} · {snapshot.windows.length}{' '}
          {snapshot.windows.length === 1 ? 'window' : 'windows'} · {tabCount}{' '}
          {tabCount === 1 ? 'tab' : 'tabs'} · click a tab to open it (⌘/Ctrl-click: in the
          background)
        </p>
      </div>
      {snapshot.windows.map((w, i) => (
        <section class="card" key={i}>
          <h3>
            Window {i + 1}
            {w.focused && <span class="muted small"> · focused</span>}
          </h3>
          <ul class="snap-sections">
            {windowSections(w).map((s, j) =>
              s.group ? (
                <GroupSection key={j} section={s} />
              ) : (
                <li key={j}>
                  <ul class="snap-tabs">
                    {s.tabs.map((t, k) => (
                      <TabRow key={`${t.url}-${k}`} tab={t} />
                    ))}
                  </ul>
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SnapshotsPage() {
  const [metas, setMetas] = useState<SnapshotMeta[]>();
  const [selected, setSelected] = useState<string | undefined>(idFromHash);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [devices, setDevices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const now = Date.now();

  useEffect(() => {
    send<'listSnapshots'>({ type: 'listSnapshots' }).then(
      (list) => {
        setMetas(list);
        setSelected((s) => (s && list.some((m) => m.id === s) ? s : list[0]?.id));
      },
      (e: Error) => setError(e.message),
    );
    const onHash = () => setSelected(idFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!selected) return;
    if (location.hash.slice(1) !== selected) history.replaceState(null, '', `#${selected}`);
    setSnapshot(undefined);
    send<'getSnapshot'>({ type: 'getSnapshot', id: selected }).then(
      (s) => {
        setSnapshot(s);
        setDevices((d) => ({ ...d, [s.snapshotId]: s.device.name }));
      },
      (e: Error) => setError(e.message),
    );
  }, [selected]);

  const labels = useMemo(() => {
    const entries = (metas ?? []).map((m) => ({ id: m.id, createdAt: Date.parse(m.createdAt) }));
    return new Map(resolveRestorePoints(entries, now).map((p) => [p.entry.id, p.label.text]));
  }, [metas]);

  return (
    <main class="snapshots">
      <h1>Snapshots</h1>
      {error && <p class="error-text">{error}</p>}
      {!metas && !error && <p class="muted">Loading…</p>}
      {metas && metas.length === 0 && <p class="muted">No snapshots yet.</p>}
      {metas && metas.length > 0 && (
        <div class="snapshots-layout">
          <nav class="snap-list">
            {groupByDay(metas, now).map((day) => (
              <div key={day.label}>
                <h3 class="day">{day.label}</h3>
                <ul>
                  {day.items.map((m) => (
                    <li key={m.id}>
                      <button
                        class={`snap-item ${m.id === selected ? 'selected' : ''}`}
                        onClick={() => setSelected(m.id)}
                      >
                        <span>
                          {new Date(Date.parse(m.createdAt)).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <span class="muted small">
                          {devices[m.id] ?? KIND_LABEL[m.kind]}
                          {devices[m.id] && m.kind !== 'auto' && ` · ${KIND_LABEL[m.kind]}`}
                        </span>
                        {labels.get(m.id) && <span class="tag">{labels.get(m.id)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div class="snap-detail">
            {snapshot ? (
              <SnapshotDetail snapshot={snapshot} label={labels.get(snapshot.snapshotId)} />
            ) : (
              <p class="muted">Loading…</p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

render(<SnapshotsPage />, document.getElementById('app')!);
