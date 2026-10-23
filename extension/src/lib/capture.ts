import {
  sanitizeWindows,
  type GroupColor,
  type SnapGroup,
  type SnapTab,
  type SnapWindow,
} from '@tabsync/shared';

/** The subset of chrome.windows.Window (populated) that capture reads. */
export interface BrowserWindow {
  incognito: boolean;
  type?: string;
  focused: boolean;
  state?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  tabs?: BrowserTab[];
}

export interface BrowserTab {
  index: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  pinned: boolean;
  active: boolean;
  groupId: number;
  favIconUrl?: string;
}

export interface BrowserGroup {
  id: number;
  title?: string;
  color: string;
  collapsed: boolean;
}

const WINDOW_STATES = new Set(['normal', 'maximized', 'minimized', 'fullscreen']);
const NO_GROUP = -1;

function toSnapWindow(window: BrowserWindow, groupsById: Map<number, BrowserGroup>): SnapWindow {
  const groups: SnapGroup[] = [];
  const keyByGroupId = new Map<number, string>();
  const tabs = [...(window.tabs ?? [])]
    .sort((a, b) => a.index - b.index)
    .map((t): SnapTab => {
      const tab: SnapTab = {
        url: t.url || t.pendingUrl || '',
        title: t.title ?? '',
        pinned: t.pinned,
        active: t.active,
      };
      if (t.favIconUrl) tab.favIconUrl = t.favIconUrl;
      const group = t.groupId !== NO_GROUP ? groupsById.get(t.groupId) : undefined;
      if (group) {
        let key = keyByGroupId.get(group.id);
        if (!key) {
          key = `g${keyByGroupId.size + 1}`;
          keyByGroupId.set(group.id, key);
          groups.push({
            key,
            title: group.title ?? '',
            color: group.color as GroupColor,
            collapsed: group.collapsed,
          });
        }
        tab.groupKey = key;
      }
      return tab;
    });

  const snap: SnapWindow = { focused: window.focused, groups, tabs };
  if (window.state && WINDOW_STATES.has(window.state))
    snap.state = window.state as SnapWindow['state'];
  if (
    window.left !== undefined &&
    window.top !== undefined &&
    window.width !== undefined &&
    window.height !== undefined
  ) {
    snap.bounds = {
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
    };
  }
  return snap;
}

/**
 * Converts the browser's windows into snapshot windows: normal, non-private windows only, tabs
 * in strip order, groups keyed per snapshot, browser IDs dropped, capture rules applied.
 */
export function captureLayout(windows: BrowserWindow[], groups: BrowserGroup[]): SnapWindow[] {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  return sanitizeWindows(
    windows
      .filter((w) => !w.incognito && (w.type === undefined || w.type === 'normal'))
      .map((w) => toSnapWindow(w, groupsById)),
  );
}
