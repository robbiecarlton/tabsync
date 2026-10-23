import {
  FORMAT_VERSION,
  GROUP_COLORS,
  SNAPSHOT_REASONS,
  WINDOW_STATES,
  type SnapGroup,
  type Snapshot,
  type SnapTab,
  type SnapWindow,
} from './types';

export class SnapshotValidationError extends Error {
  constructor(path: string, problem: string) {
    super(`Invalid snapshot at ${path}: ${problem}`);
    this.name = 'SnapshotValidationError';
  }
}

type Obj = Record<string, unknown>;

function obj(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotValidationError(path, 'expected an object');
  }
  return value as Obj;
}

function str(o: Obj, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string')
    throw new SnapshotValidationError(`${path}.${key}`, 'expected a string');
  return v;
}

function optStr(o: Obj, key: string, path: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key, path);
}

function bool(o: Obj, key: string, path: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') {
    throw new SnapshotValidationError(`${path}.${key}`, 'expected a boolean');
  }
  return v;
}

function num(o: Obj, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new SnapshotValidationError(`${path}.${key}`, 'expected a number');
  }
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], path: string): T {
  const v = str(o, key, path);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new SnapshotValidationError(`${path}.${key}`, `unexpected value "${v}"`);
  }
  return v as T;
}

function arr(o: Obj, key: string, path: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new SnapshotValidationError(`${path}.${key}`, 'expected an array');
  return v;
}

/** Copies only defined optional fields, so parsed objects have no `key: undefined` entries. */
function withOptional<T extends object>(base: T, extras: Partial<T>): T {
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined) (base as Obj)[k] = v;
  }
  return base;
}

function parseGroup(value: unknown, path: string): SnapGroup {
  const o = obj(value, path);
  return {
    key: str(o, 'key', path),
    title: str(o, 'title', path),
    color: oneOf(o, 'color', GROUP_COLORS, path),
    collapsed: bool(o, 'collapsed', path),
  };
}

function parseTab(value: unknown, path: string, groupKeys: Set<string>): SnapTab {
  const o = obj(value, path);
  const groupKey = optStr(o, 'groupKey', path);
  if (groupKey !== undefined && !groupKeys.has(groupKey)) {
    throw new SnapshotValidationError(`${path}.groupKey`, `unknown group "${groupKey}"`);
  }
  return withOptional<SnapTab>(
    {
      url: str(o, 'url', path),
      title: str(o, 'title', path),
      pinned: bool(o, 'pinned', path),
      active: bool(o, 'active', path),
    },
    {
      groupKey,
      favIconUrl: optStr(o, 'favIconUrl', path),
      previewRef: optStr(o, 'previewRef', path),
    },
  );
}

function parseWindow(value: unknown, path: string): SnapWindow {
  const o = obj(value, path);
  const groups = arr(o, 'groups', path).map((g, i) => parseGroup(g, `${path}.groups[${i}]`));
  const groupKeys = new Set(groups.map((g) => g.key));
  if (groupKeys.size !== groups.length) {
    throw new SnapshotValidationError(`${path}.groups`, 'duplicate group key');
  }
  let bounds: SnapWindow['bounds'];
  if (o.bounds !== undefined) {
    const b = obj(o.bounds, `${path}.bounds`);
    const bp = `${path}.bounds`;
    bounds = {
      left: num(b, 'left', bp),
      top: num(b, 'top', bp),
      width: num(b, 'width', bp),
      height: num(b, 'height', bp),
    };
  }
  return withOptional<SnapWindow>(
    {
      focused: bool(o, 'focused', path),
      groups,
      tabs: arr(o, 'tabs', path).map((t, i) => parseTab(t, `${path}.tabs[${i}]`, groupKeys)),
    },
    {
      state: o.state === undefined ? undefined : oneOf(o, 'state', WINDOW_STATES, path),
      bounds,
    },
  );
}

/**
 * Validates untrusted data (e.g. a decrypted blob) as a Snapshot. Returns a fresh object with
 * unknown fields dropped; throws SnapshotValidationError naming the first bad path.
 */
export function parseSnapshot(value: unknown): Snapshot {
  const o = obj(value, 'snapshot');
  if (o.formatVersion !== FORMAT_VERSION) {
    throw new SnapshotValidationError(
      'snapshot.formatVersion',
      `unsupported version ${String(o.formatVersion)}`,
    );
  }
  const createdAt = str(o, 'createdAt', 'snapshot');
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new SnapshotValidationError('snapshot.createdAt', 'not a valid timestamp');
  }
  const device = obj(o.device, 'snapshot.device');
  return withOptional<Snapshot>(
    {
      formatVersion: FORMAT_VERSION,
      snapshotId: str(o, 'snapshotId', 'snapshot'),
      createdAt,
      device: {
        id: str(device, 'id', 'snapshot.device'),
        name: str(device, 'name', 'snapshot.device'),
      },
      reason: oneOf(o, 'reason', SNAPSHOT_REASONS, 'snapshot'),
      windows: arr(o, 'windows', 'snapshot').map((w, i) =>
        parseWindow(w, `snapshot.windows[${i}]`),
      ),
    },
    { parentSnapshotId: optStr(o, 'parentSnapshotId', 'snapshot') },
  );
}
