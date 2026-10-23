/** Snapshot format version written by this codebase. */
export const FORMAT_VERSION = 1 as const;

/** Mirrors `chrome.tabGroups.ColorEnum`; redeclared so shared has no chrome typings. */
export const GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export const SNAPSHOT_REASONS = ['auto', 'pre-restore', 'manual'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

export const WINDOW_STATES = ['normal', 'maximized', 'minimized', 'fullscreen'] as const;
export type WindowState = (typeof WINDOW_STATES)[number];

export interface Snapshot {
  formatVersion: typeof FORMAT_VERSION;
  snapshotId: string;
  /** The snapshot this device last synced from (conflict detection). */
  parentSnapshotId?: string;
  /** ISO timestamp with millisecond precision. */
  createdAt: string;
  device: { id: string; name: string };
  reason: SnapshotReason;
  windows: SnapWindow[];
}

export interface SnapWindow {
  focused: boolean;
  state?: WindowState;
  bounds?: { left: number; top: number; width: number; height: number };
  groups: SnapGroup[];
  /** In strip order; pinned tabs first. */
  tabs: SnapTab[];
}

export interface SnapGroup {
  /** Local to this snapshot, e.g. "g1". */
  key: string;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface SnapTab {
  url: string;
  title: string;
  pinned: boolean;
  /** References `SnapGroup.key` in the same window. */
  groupKey?: string;
  active: boolean;
  /** Fallback only; data: URLs are dropped at capture. */
  favIconUrl?: string;
  /** v2: reference to separately stored preview data. */
  previewRef?: string;
}
