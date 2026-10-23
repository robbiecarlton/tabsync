/** Push this long after the last layout change... */
export const DEBOUNCE_MS = 5_000;
/** ...but no later than this after the first change in a burst. */
export const MAX_WAIT_MS = 30_000;
/** Ignore tab events this long after browser start while session restore runs. */
export const SETTLE_MS = 10_000;
/** Transient failures become an Error after this long. */
export const ERROR_AFTER_MS = 5 * 60_000;
/** Safety-net alarm period, in minutes. */
export const ALARM_PERIOD_MINUTES = 1;
export const ALARM_NAME = 'tabsync-tick';

export function pushDueAt(dirtySince: number, lastChangeAt: number): number {
  return Math.min(lastChangeAt + DEBOUNCE_MS, dirtySince + MAX_WAIT_MS);
}

/** Retry delay after the n-th consecutive failure (1-based): 5s, 10s, 20s, 40s, then 60s. */
export function retryDelay(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

/** After applying a snapshot, late tab events from our own operations are ignored this long. */
export const ECHO_GRACE_MS = 2_000;
/** Window-focus pulls happen at most this often. */
export const PULL_MIN_INTERVAL_MS = 30_000;
/** Retry interval for persistent failures (rejected credentials, clock skew, too large). */
export const PERSISTENT_RETRY_MS = 5 * 60_000;
