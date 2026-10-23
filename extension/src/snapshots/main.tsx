import {
  compareLayouts,
  resolveRestorePoints,
  type GroupColor,
  type Snapshot,
  type SnapTab,
  type SnapWindow,
  type TabLocation,
} from '@tabsync/shared';
import { render, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SnapshotMeta } from '../lib/api';
import { chromeBrowser } from '../lib/browser';
import { captureLayout } from '../lib/capture';
import { send } from '../lib/messages';
import { openGroup, openOrFocusTab, openTab } from '../lib/open';
import { Favicon } from '../ui/Favicon';
import { formatWhen } from '../ui/format';
import {
  describeMove,
  groupByDay,
  hostOf,
  KIND_LABEL,
  parseRoute,
  routeHash,
  windowSections,
  type CompareRef,
  type PageRoute,
  type Section,
} from '../ui/snapshot-view';
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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A tab title that goes to the tab: focus it if open, else open it; cmd/ctrl-click opens a new background tab. */
function TabLink({ tab }: { tab: SnapTab }) {
  const open = async (e: MouseEvent) => {
    const windowId = await currentWindowId();
    if (e.metaKey || e.ctrlKey) await openTab(chromeBrowser, windowId, tab, { active: false });
    else await openOrFocusTab(chromeBrowser, windowId, tab);
  };
  return (
    <>
      <Favicon key={tab.url} pageUrl={tab.url} stored={tab.favIconUrl} />
      <button class="link" title={tab.url} onClick={open}>
        {tab.title || tab.url}
      </button>
    </>
  );
}

function TabRow({ tab, note }: { tab: SnapTab; note?: string }) {
  return (
    <li class="snap-tab">
      <TabLink tab={tab} />
      <span class="muted small host">{note ?? hostOf(tab.url)}</span>
      {tab.pinned && !note && <span class="tag">Pinned</span>}
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
          {plural(section.tabs.length, 'tab')}
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

function SnapshotDetail({
  snapshot,
  label,
  actions,
}: {
  snapshot: Snapshot;
  label?: string;
  actions: ComponentChildren;
}) {
  const tabCount = snapshot.windows.reduce((n, w) => n + w.tabs.length, 0);
  return (
    <div class="stack">
      <div>
        <h2>
          {formatWhen(Date.parse(snapshot.createdAt), Date.now())} · {snapshot.device.name}
        </h2>
        <p class="muted small">
          {KIND_LABEL[snapshot.reason]}
          {label && ` · ${label}`} · {plural(snapshot.windows.length, 'window')} ·{' '}
          {plural(tabCount, 'tab')} · click a tab to go to it (⌘/Ctrl-click: open a new background
          tab)
        </p>
      </div>
      {actions}
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

const timeOf = (iso: string) =>
  new Date(Date.parse(iso)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function CompareControls({
  id,
  metas,
  onCompare,
}: {
  id: string;
  metas: SnapshotMeta[];
  onCompare: (a: CompareRef, b: CompareRef) => void;
}) {
  const self = metas.find((m) => m.id === id);
  return (
    <div class="row">
      <button class="primary" onClick={() => onCompare(id, 'now')}>
        Compare with what’s open now
      </button>
      <select
        aria-label="Compare with another snapshot"
        value=""
        onChange={(e) => {
          const other = metas.find((m) => m.id === e.currentTarget.value);
          if (!other || !self) return;
          // Older on the left, so "opened" means opened since then.
          const otherIsOlder = Date.parse(other.createdAt) < Date.parse(self.createdAt);
          onCompare(otherIsOlder ? other.id : id, otherIsOlder ? id : other.id);
        }}
      >
        <option value="">…or compare with another snapshot</option>
        {metas
          .filter((m) => m.id !== id)
          .map((m) => (
            <option key={m.id} value={m.id}>
              {formatWhen(Date.parse(m.createdAt), Date.now())} · {KIND_LABEL[m.kind]}
            </option>
          ))}
      </select>
    </div>
  );
}

function where(at: TabLocation): string {
  return `Window ${at.window}${at.group ? ` · ${at.group.title || 'untitled group'}` : ''}${at.pinned ? ' · pinned' : ''}`;
}

interface Side {
  label: string;
  windows: SnapWindow[];
}

function CompareView({
  from,
  to,
  showsLive,
  onSwap,
  onBack,
  onRefresh,
}: {
  from?: Side;
  to?: Side;
  showsLive: boolean;
  onSwap: () => void;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const result = useMemo(
    () => (from && to ? compareLayouts(from.windows, to.windows) : undefined),
    [from, to],
  );
  return (
    <div class="stack">
      <div class="row">
        <button onClick={onBack}>← Back to snapshot</button>
        <button onClick={onSwap} title="Swap sides">
          ⇄ Swap
        </button>
        {showsLive && <button onClick={onRefresh}>Refresh open tabs</button>}
      </div>
      {!result || !from || !to ? (
        <p class="muted">Loading…</p>
      ) : (
        <>
          <div>
            <h2>
              {from.label} → {to.label}
            </h2>
            <p class="muted small">
              {result.opened.length} opened · {result.closed.length} closed · {result.moved.length}{' '}
              moved · {result.unchanged} unchanged
            </p>
          </div>
          {result.opened.length + result.closed.length + result.moved.length === 0 && (
            <p class="card">No differences.</p>
          )}
          {result.opened.length > 0 && (
            <section class="card">
              <h3>Opened ({result.opened.length})</h3>
              <ul class="snap-tabs">
                {result.opened.map((x, i) => (
                  <TabRow key={`o${i}`} tab={x.tab} note={where(x.at)} />
                ))}
              </ul>
            </section>
          )}
          {result.closed.length > 0 && (
            <section class="card">
              <h3>Closed ({result.closed.length})</h3>
              <ul class="snap-tabs">
                {result.closed.map((x, i) => (
                  <TabRow key={`c${i}`} tab={x.tab} note={where(x.at)} />
                ))}
              </ul>
            </section>
          )}
          {result.moved.length > 0 && (
            <section class="card">
              <h3>Moved ({result.moved.length})</h3>
              <ul class="snap-tabs">
                {result.moved.map((m, i) => (
                  <TabRow key={`m${i}`} tab={m.tab} note={describeMove(m).join(' · ')} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SnapshotsPage() {
  const [metas, setMetas] = useState<SnapshotMeta[]>();
  const [route, setRoute] = useState<PageRoute>(() => parseRoute(location.hash));
  const [cache, setCache] = useState<Record<string, Snapshot>>({});
  const [live, setLive] = useState<SnapWindow[]>();
  const [error, setError] = useState<string>();
  const now = Date.now();

  const go = (r: PageRoute) => {
    history.replaceState(null, '', routeHash(r));
    setRoute(r);
  };

  useEffect(() => {
    send<'listSnapshots'>({ type: 'listSnapshots' }).then(
      (list) => {
        setMetas(list);
        setRoute((r) => ('none' in r && list[0] ? { view: list[0].id } : r));
      },
      (e: Error) => setError(e.message),
    );
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refs: CompareRef[] =
    'view' in route ? [route.view] : 'compare' in route ? [route.compare.a, route.compare.b] : [];
  const selected = refs.find((r) => r !== 'now');
  const needsLive = refs.includes('now');

  useEffect(() => {
    for (const id of refs) {
      if (id === 'now' || cache[id]) continue;
      send<'getSnapshot'>({ type: 'getSnapshot', id }).then(
        (s) => setCache((c) => ({ ...c, [id]: s })),
        (e: Error) => setError(e.message),
      );
    }
  }, [refs.join('|')]);

  const refreshLive = async () => {
    const [windows, groups] = await Promise.all([
      chromeBrowser.getWindows(),
      chromeBrowser.getGroups(),
    ]);
    setLive(captureLayout(windows, groups));
  };
  useEffect(() => {
    if (!needsLive) return;
    void refreshLive();
    const onFocus = () => void refreshLive();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [needsLive]);

  const labels = useMemo(() => {
    const entries = (metas ?? []).map((m) => ({ id: m.id, createdAt: Date.parse(m.createdAt) }));
    return new Map(resolveRestorePoints(entries, now).map((p) => [p.entry.id, p.label.text]));
  }, [metas]);

  const side = (ref: CompareRef): Side | undefined => {
    if (ref === 'now') return live && { label: 'What’s open now', windows: live };
    const s = cache[ref];
    return (
      s && {
        label: `${formatWhen(Date.parse(s.createdAt), now)} · ${s.device.name}`,
        windows: s.windows,
      }
    );
  };

  let detail: ComponentChildren = <p class="muted">Loading…</p>;
  if ('view' in route && cache[route.view]) {
    detail = (
      <SnapshotDetail
        snapshot={cache[route.view]!}
        label={labels.get(route.view)}
        actions={
          metas && (
            <CompareControls
              id={route.view}
              metas={metas}
              onCompare={(a, b) => go({ compare: { a, b } })}
            />
          )
        }
      />
    );
  } else if ('compare' in route) {
    const { a, b } = route.compare;
    detail = (
      <CompareView
        from={side(a)}
        to={side(b)}
        showsLive={needsLive}
        onSwap={() => go({ compare: { a: b, b: a } })}
        onBack={() => selected && go({ view: selected })}
        onRefresh={() => void refreshLive()}
      />
    );
  }

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
                        onClick={() => go({ view: m.id })}
                      >
                        <span>{timeOf(m.createdAt)}</span>
                        <span class="muted small">
                          {cache[m.id]?.device.name ?? KIND_LABEL[m.kind]}
                          {cache[m.id] && m.kind !== 'auto' && ` · ${KIND_LABEL[m.kind]}`}
                        </span>
                        {labels.get(m.id) && <span class="tag">{labels.get(m.id)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div class="snap-detail">{detail}</div>
        </div>
      )}
    </main>
  );
}

render(<SnapshotsPage />, document.getElementById('app')!);
