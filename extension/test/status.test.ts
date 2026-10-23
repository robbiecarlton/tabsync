import { describe, expect, it } from 'vitest';
import {
  DEBOUNCE_MS,
  ERROR_AFTER_MS,
  MAX_WAIT_MS,
  pushDueAt,
  retryDelay,
} from '../src/lib/schedule';
import { badgeFor, computeStatus } from '../src/lib/status';
import { defaultDeviceName } from '../src/lib/state';

const now = 1_000_000;

describe('computeStatus', () => {
  it('is not-setup without credentials', () => {
    expect(computeStatus(false, {}, now)).toBe('not-setup');
  });

  it('is synced with nothing pending', () => {
    expect(computeStatus(true, {}, now)).toBe('synced');
  });

  it('is pending with unsaved changes or an unconfirmed snapshot', () => {
    expect(computeStatus(true, { dirtySince: now }, now)).toBe('pending');
    expect(computeStatus(true, { pending: {} as never }, now)).toBe('pending');
  });

  it('keeps transient failures Pending for 5 minutes', () => {
    const lastError = { kind: 'network' as const, message: 'offline', at: now };
    const state = { pending: {} as never, lastError, failingSince: now - ERROR_AFTER_MS + 1 };
    expect(computeStatus(true, state, now)).toBe('pending');
    expect(computeStatus(true, { ...state, failingSince: now - ERROR_AFTER_MS }, now)).toBe(
      'error',
    );
  });

  it.each(['auth', 'decrypt', 'server'] as const)(
    'shows %s failures as Error immediately',
    (kind) => {
      expect(
        computeStatus(true, { lastError: { kind, message: '', at: now }, failingSince: now }, now),
      ).toBe('error');
    },
  );
});

describe('badgeFor', () => {
  it('matches the spec table', () => {
    expect(badgeFor('synced')).toMatchObject({ text: '●', color: '#1e8e3e' });
    expect(badgeFor('pending')).toMatchObject({ text: '●', color: '#80868b' });
    expect(badgeFor('error', 'offline')).toMatchObject({
      text: 'x',
      color: '#d93025',
      title: 'Tab Sync: error – offline',
    });
    expect(badgeFor('not-setup')).toMatchObject({ text: '', title: 'Set up sync' });
  });
});

describe('schedule', () => {
  it('pushes 5s after the last change, capped at 30s after the first', () => {
    expect(pushDueAt(0, 1_000)).toBe(1_000 + DEBOUNCE_MS);
    expect(pushDueAt(0, 28_000)).toBe(MAX_WAIT_MS);
  });

  it('backs off 5s, 10s, 20s, 40s, then 60s', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });
});

describe('defaultDeviceName', () => {
  it('names the platform', () => {
    expect(defaultDeviceName('macintel')).toBe('Brave on Mac');
    expect(defaultDeviceName('win32')).toBe('Brave on Windows');
    expect(defaultDeviceName('linux x86_64')).toBe('Brave on Linux');
    expect(defaultDeviceName('')).toBe('Brave');
  });
});
