/**
 * Sliding-window rate limiter for gateway operations.
 *
 * Uses a fixed-window counter approach with sub-second precision,
 * designed for high-throughput WebSocket request paths.
 */

/** Configuration for creating a rate limiter instance. */
export type RateLimiterConfig = {
  maxRequests: number;
  windowMs: number;
};

/** Snapshot of rate limit state for a given key. */
export type RateLimitInfo = {
  allowed: boolean;
  remaining: number;
  resetMs: number;
};

type BucketEntry = {
  timestamps: number[];
};

/**
 * A sliding-window rate limiter that tracks requests per key.
 *
 * Each call to `tryAcquire` records a timestamp. On subsequent calls,
 * timestamps outside the current window are pruned before checking the limit.
 * This ensures memory stays bounded even under sustained traffic.
 */
export class SlidingWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, BucketEntry>();

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Attempt to acquire a rate-limit slot for the given key.
   * Returns `true` if the request is allowed, `false` if rate-limited.
   */
  tryAcquire(key: string): boolean {
    if (this.maxRequests <= 0) {
      return false;
    }

    const now = Date.now();
    const entry = this.getOrCreateEntry(key);
    this.prune(entry, now);

    if (entry.timestamps.length >= this.maxRequests) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** Reset rate-limit state for a specific key. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Clear all rate-limit state. */
  resetAll(): void {
    this.buckets.clear();
  }

  /** Return how many requests remain in the current window for the given key. */
  getRemaining(key: string): number {
    if (this.maxRequests <= 0) {
      return 0;
    }

    const entry = this.buckets.get(key);
    if (!entry) {
      return this.maxRequests;
    }

    this.prune(entry, Date.now());
    return Math.max(0, this.maxRequests - entry.timestamps.length);
  }

  private getOrCreateEntry(key: string): BucketEntry {
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.buckets.set(key, entry);
    }
    return entry;
  }

  private prune(entry: BucketEntry, now: number): void {
    const cutoff = now - this.windowMs;
    // Timestamps are in chronological order; find the first one still in the window.
    let i = 0;
    while (i < entry.timestamps.length && entry.timestamps[i]! <= cutoff) {
      i++;
    }
    if (i > 0) {
      entry.timestamps.splice(0, i);
    }
  }
}

/** Factory function to create a rate limiter from a config object. */
export function createRateLimiter(config: RateLimiterConfig): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(config.maxRequests, config.windowMs);
}
