import {
  FORMAT_VERSION,
  type SnapGroup,
  type Snapshot,
  type SnapTab,
  type SnapWindow,
} from '../types';

/** Test builders. Not part of the runtime API. */

export function tab(url: string, overrides: Partial<SnapTab> = {}): SnapTab {
  return { url, title: url, pinned: false, active: false, ...overrides };
}

export function group(key: string, overrides: Partial<SnapGroup> = {}): SnapGroup {
  return { key, title: key, color: 'blue', collapsed: false, ...overrides };
}

export function win(
  tabs: SnapTab[],
  groups: SnapGroup[] = [],
  overrides: Partial<SnapWindow> = {},
): SnapWindow {
  return { focused: false, groups, tabs, ...overrides };
}

export function snapshot(windows: SnapWindow[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    formatVersion: FORMAT_VERSION,
    snapshotId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-22T12:00:00.000Z',
    device: { id: 'device-1', name: 'Desk iMac' },
    reason: 'auto',
    windows,
    ...overrides,
  };
}
