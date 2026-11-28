import { TooManyRequestsError } from './errors.ts';

/**
 * Counts requests per key in fixed windows, in memory. One BAATS server process
 * is enough for this; behind several servers, put the same limits on the load
 * balancer as well.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; until: number }>();
  readonly limit: number; readonly windowMs: number; readonly what: string;
  constructor(limit: number, windowMs: number, what: string) { this.limit = limit; this.windowMs = windowMs; this.what = what; }

  /** Throws 429 if the key has used up its limit for this window, without counting. */
  check(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (h && h.until > now && h.n >= this.limit) this.refuse(h.until - now);
  }

  /** Count one request; throws 429 once the key is over its limit for this window. */
  hit(key: string, now = Date.now()): void {
    let h = this.hits.get(key);
    if (!h || h.until <= now) {
      h = { n: 0, until: now + this.windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 50_000) this.sweep(now);
    }
    h.n++;
    if (h.n > this.limit) this.refuse(h.until - now);
  }

  private refuse(ms: number): never {
    const wait = Math.ceil(ms / 1000);
    throw new TooManyRequestsError(`too many ${this.what}; try again in ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}`, wait);
  }

  private sweep(now: number) { for (const [k, h] of this.hits) if (h.until <= now) this.hits.delete(k); }
}
