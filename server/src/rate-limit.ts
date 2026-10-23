import type { RateLimit } from './config';

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (when not ok). */
  retryAfter: number;
}

/** Fixed-window counters held in memory; fine for the single-process server. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly maxKeys = 10_000) {}

  check(key: string, { limit, windowMs }: RateLimit, now: number): RateLimitResult {
    let w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.evictExpired(now, windowMs);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    if (w.count <= limit) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: Math.ceil((w.start + windowMs - now) / 1000) };
  }

  private evictExpired(now: number, windowMs: number): void {
    for (const [key, w] of this.windows) {
      if (now - w.start >= windowMs) this.windows.delete(key);
    }
    // Still full: drop the oldest entries (Map preserves insertion order).
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
