import { DecryptError } from '@tabsync/shared';
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../src/lib/api';
import { describeFailure } from '../src/lib/errors';

describe('describeFailure', () => {
  it.each([
    [
      new NetworkError('Can’t reach the sync server at https://x'),
      'network',
      true,
      /Can’t reach.*Retrying automatically/,
    ],
    [new DecryptError('bad tag'), 'decrypt', false, /different secret, or altered on the server/],
    [
      new ApiError(401, 'unauthorized', 'nope'),
      'auth',
      false,
      /doesn’t recognise this sync profile/,
    ],
    [new ApiError(429, 'rate_limited', 'Too many requests'), 'network', true, /busy/],
    [new ApiError(503, 'http_error', 'x'), 'network', true, /HTTP 503/],
    [new ApiError(413, 'payload_too_large', 'x'), 'server', false, /over the server’s 2 MB limit/],
    [new ApiError(422, 'clock_skew', 'x'), 'server', false, /clock is more than 10 minutes ahead/],
    [
      new ApiError(400, 'invalid_request', 'id must be a UUID'),
      'server',
      false,
      /refused the request: id must be a UUID/,
    ],
    [new Error('boom'), 'server', false, /^boom$/],
  ])('%s', (err, kind, transient, message) => {
    const f = describeFailure(err);
    expect(f.kind).toBe(kind);
    expect(f.transient).toBe(transient);
    expect(f.message).toMatch(message);
  });
});
