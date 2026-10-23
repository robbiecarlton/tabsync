import { createHash, timingSafeEqual } from 'node:crypto';

export const PROFILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const AUTH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 hex; matches `hashAuthToken` in @tabsync/shared. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Parses `Authorization: Bearer <profileId>.<authToken>` (PLAN.md D8). The profile ID lets the
 * server find the row, then compare token hashes in constant time.
 */
export function parseBearer(
  header: string | undefined,
): { profileId: string; token: string } | null {
  const match = /^Bearer ([^.\s]+)\.(\S+)$/.exec(header ?? '');
  if (!match) return null;
  const [, profileId, token] = match as unknown as [string, string, string];
  if (!PROFILE_ID_RE.test(profileId) || !AUTH_TOKEN_RE.test(token)) return null;
  return { profileId, token };
}
