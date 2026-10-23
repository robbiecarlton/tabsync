import { hashAuthToken } from '@tabsync/shared';
import { describe, expect, it } from 'vitest';
import { hashToken, parseBearer, tokenMatches } from '../src/auth';

const profileId = 'A'.repeat(22);
const token = 'b'.repeat(43);

describe('parseBearer', () => {
  it('parses Bearer <profileId>.<token>', () => {
    expect(parseBearer(`Bearer ${profileId}.${token}`)).toEqual({ profileId, token });
  });

  it.each([
    undefined,
    '',
    `Basic ${profileId}.${token}`,
    `Bearer ${token}`,
    `Bearer ${profileId}`,
    `Bearer ${profileId}.${token}x`,
    `Bearer ${profileId.slice(1)}.${token}`,
    `Bearer ${profileId}.${token.slice(1)}!`,
    `Bearer ${profileId}.${token} extra`,
  ])('rejects %j', (header) => {
    expect(parseBearer(header)).toBeNull();
  });
});

describe('token hashing', () => {
  it('matches the shared hashAuthToken used by the extension', async () => {
    expect(hashToken(token)).toBe(await hashAuthToken(token));
  });

  it('compares tokens against stored hashes', () => {
    expect(tokenMatches(token, hashToken(token))).toBe(true);
    expect(tokenMatches(token, hashToken('c'.repeat(43)))).toBe(false);
    expect(tokenMatches(token, 'not-hex')).toBe(false);
  });
});
