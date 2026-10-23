import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit';

const rule = { limit: 3, windowMs: 60_000 };

describe('RateLimiter', () => {
  it('allows up to the limit per window, then reports retry-after', () => {
    const rl = new RateLimiter();
    expect([1, 2, 3].map(() => rl.check('k', rule, 0).ok)).toEqual([true, true, true]);
    expect(rl.check('k', rule, 15_000)).toEqual({ ok: false, retryAfter: 45 });
  });

  it('resets after the window', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 4; i++) rl.check('k', rule, 0);
    expect(rl.check('k', rule, 60_000).ok).toBe(true);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 4; i++) rl.check('a', rule, 0);
    expect(rl.check('b', rule, 0).ok).toBe(true);
  });

  it('bounds memory by evicting expired, then oldest, keys', () => {
    const rl = new RateLimiter(3);
    rl.check('a', rule, 0);
    rl.check('b', rule, 0);
    rl.check('c', rule, 70_000);
    rl.check('d', rule, 70_000);
    expect(rl.size).toBe(2);
    rl.check('e', rule, 70_000);
    rl.check('f', rule, 70_000);
    expect(rl.size).toBeLessThanOrEqual(3);
  });
});
