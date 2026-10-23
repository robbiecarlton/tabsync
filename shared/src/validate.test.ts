import { describe, expect, it } from 'vitest';
import { group, snapshot, tab, win } from './testing/fixtures';
import { parseSnapshot, SnapshotValidationError } from './validate';

const valid = () =>
  snapshot(
    [
      win(
        [
          tab('https://a.example/', { pinned: true, active: true, favIconUrl: 'https://a/f.ico' }),
          tab('https://b.example/', { groupKey: 'g1' }),
        ],
        [group('g1', { title: 'Work', color: 'red', collapsed: true })],
        { focused: true, state: 'maximized', bounds: { left: 0, top: 0, width: 800, height: 600 } },
      ),
    ],
    { parentSnapshotId: 'parent' },
  );

// Tests mutate raw JSON freely to produce invalid shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe('parseSnapshot', () => {
  it('accepts a valid snapshot and returns an equal object', () => {
    const s = valid();
    expect(parseSnapshot(roundTrip(s))).toEqual(s);
  });

  it('does not add undefined optional keys', () => {
    const parsed = parseSnapshot(roundTrip(snapshot([win([tab('https://a/')])])));
    expect(Object.keys(parsed)).not.toContain('parentSnapshotId');
    expect(Object.keys(parsed.windows[0]!)).toEqual(['focused', 'groups', 'tabs']);
    expect(Object.keys(parsed.windows[0]!.tabs[0]!)).toEqual(['url', 'title', 'pinned', 'active']);
  });

  it('drops unknown fields', () => {
    const raw = roundTrip(valid());
    raw.extra = 1;
    expect(parseSnapshot(raw)).not.toHaveProperty('extra');
  });

  it.each([
    ['not an object', () => 'x', /snapshot: expected an object/],
    ['wrong version', (s: Raw) => ({ ...s, formatVersion: 2 }), /unsupported version 2/],
    ['bad timestamp', (s: Raw) => ({ ...s, createdAt: 'yesterday' }), /createdAt: not a valid/],
    ['bad reason', (s: Raw) => ({ ...s, reason: 'other' }), /reason: unexpected value "other"/],
    [
      'missing device name',
      (s: Raw) => ({ ...s, device: { id: 'd' } }),
      /device\.name: expected a string/,
    ],
    [
      'bad group color',
      (s: Raw) => {
        s.windows[0].groups[0].color = 'black';
        return s;
      },
      /windows\[0\]\.groups\[0\]\.color/,
    ],
    [
      'unknown group key',
      (s: Raw) => {
        s.windows[0].tabs[1].groupKey = 'nope';
        return s;
      },
      /tabs\[1\]\.groupKey: unknown group "nope"/,
    ],
    [
      'duplicate group key',
      (s: Raw) => {
        s.windows[0].groups.push(s.windows[0].groups[0]);
        return s;
      },
      /duplicate group key/,
    ],
    [
      'non-boolean pinned',
      (s: Raw) => {
        s.windows[0].tabs[0].pinned = 'yes';
        return s;
      },
      /tabs\[0\]\.pinned: expected a boolean/,
    ],
    [
      'bad bounds',
      (s: Raw) => {
        s.windows[0].bounds.width = null;
        return s;
      },
      /bounds\.width: expected a number/,
    ],
    [
      'bad window state',
      (s: Raw) => {
        s.windows[0].state = 'docked';
        return s;
      },
      /state: unexpected value "docked"/,
    ],
  ])('rejects %s', (_name, mutate, message) => {
    const run = () => parseSnapshot(mutate(roundTrip(valid())));
    expect(run).toThrow(SnapshotValidationError);
    expect(run).toThrow(message);
  });
});
