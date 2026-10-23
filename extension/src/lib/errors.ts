import { DecryptError } from '@tabsync/shared';
import { ApiError, NetworkError } from './api';
import type { ErrorKind } from './state';

export interface Failure {
  kind: ErrorKind;
  /** Shown in the popup and options page. */
  message: string;
  /** Worth retrying soon (network trouble, server overload). */
  transient: boolean;
}

/** Turns anything thrown while syncing into a kind, a user-facing message and retry advice. */
export function describeFailure(err: unknown): Failure {
  if (err instanceof NetworkError) {
    return { kind: 'network', message: `${err.message}. Retrying automatically.`, transient: true };
  }
  if (err instanceof DecryptError) {
    return {
      kind: 'decrypt',
      message:
        'Couldn’t decrypt the latest snapshot. It may have been made with a different secret, or altered on the server.',
      transient: false,
    };
  }
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return {
        kind: 'auth',
        message:
          'The server doesn’t recognise this sync profile. If the server was reset, disconnect and set up sync again.',
        transient: false,
      };
    }
    if (err.status === 429) {
      return {
        kind: 'network',
        message: 'The sync server is busy. Retrying shortly.',
        transient: true,
      };
    }
    if (err.status >= 500) {
      return {
        kind: 'network',
        message: `The sync server had a problem (HTTP ${err.status}). Retrying automatically.`,
        transient: true,
      };
    }
    if (err.code === 'payload_too_large') {
      return {
        kind: 'server',
        message:
          'The snapshot is too large to sync (over the server’s size limit). Closing some tabs will fix it.',
        transient: false,
      };
    }
    if (err.code === 'clock_skew') {
      return {
        kind: 'server',
        message:
          'This computer’s clock is more than 10 minutes ahead of the server’s. Check the date and time settings.',
        transient: false,
      };
    }
    return {
      kind: 'server',
      message: `The sync server refused the request: ${err.message}`,
      transient: false,
    };
  }
  return {
    kind: 'server',
    message: err instanceof Error ? err.message : String(err),
    transient: false,
  };
}
