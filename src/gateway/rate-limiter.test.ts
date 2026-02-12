import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SlidingWindowRateLimiter,
  createRateLimiter,
  type RateLimiterConfig,
  type RateLimitInfo,
} from "./rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("tryAcquire", () => {
    test("allows requests up to maxRequests", () => {
      const limiter = new SlidingWindowRateLimiter(3, 1000);
      expect(limiter.tryAcquire("user-1")).toBe(true);
      expect(limiter.tryAcquire("user-1")).toBe(true);
      expect(limiter.tryAcquire("user-1")).toBe(true);
    });

    test("rejects requests exceeding maxRequests within the window", () => {
      const limiter = new SlidingWindowRateLimiter(2, 1000);
      expect(limiter.tryAcquire("user-1")).toBe(true);
      expect(limiter.tryAcquire("user-1")).toBe(true);
      expect(limiter.tryAcquire("user-1")).toBe(false);
    });

    test("allows requests again after the window expires", () => {
      const limiter = new SlidingWindowRateLimiter(2, 1000);
      expect(limiter.tryAcquire("user-1")).toBe(true);
      expect(limiter.tryAcquire("user-1")).toBe(true);
      expect(limiter.tryAcquire("user-1")).toBe(false);

      vi.advanceTimersByTime(1001);

      expect(limiter.tryAcquire("user-1")).toBe(true);
      expect(limiter.tryAcquire("user-1")).toBe(true);
    });

    test("tracks keys independently", () => {
      const limiter = new SlidingWindowRateLimiter(1, 1000);
      expect(limiter.tryAcquire("user-a")).toBe(true);
      expect(limiter.tryAcquire("user-a")).toBe(false);

      expect(limiter.tryAcquire("user-b")).toBe(true);
      expect(limiter.tryAcquire("user-b")).toBe(false);
    });

    test("uses sliding window — only expired timestamps are pruned", () => {
      const limiter = new SlidingWindowRateLimiter(3, 1000);

      // t=0: 1st request
      expect(limiter.tryAcquire("k")).toBe(true);

      // t=400: 2nd request
      vi.advanceTimersByTime(400);
      expect(limiter.tryAcquire("k")).toBe(true);

      // t=800: 3rd request
      vi.advanceTimersByTime(400);
      expect(limiter.tryAcquire("k")).toBe(true);

      // t=800: 4th — blocked
      expect(limiter.tryAcquire("k")).toBe(false);

      // t=1001: 1st request expired, so one slot opens
      vi.advanceTimersByTime(201);
      expect(limiter.tryAcquire("k")).toBe(true);

      // t=1001: blocked again (2nd and 3rd still active)
      expect(limiter.tryAcquire("k")).toBe(false);
    });

    test("handles zero maxRequests — always rejects", () => {
      const limiter = new SlidingWindowRateLimiter(0, 1000);
      expect(limiter.tryAcquire("any")).toBe(false);
    });

    test("handles very small window — requests expire quickly", () => {
      const limiter = new SlidingWindowRateLimiter(1, 10);
      expect(limiter.tryAcquire("k")).toBe(true);
      expect(limiter.tryAcquire("k")).toBe(false);

      vi.advanceTimersByTime(11);
      expect(limiter.tryAcquire("k")).toBe(true);
    });
  });

  describe("getRemaining", () => {
    test("returns maxRequests for unknown key", () => {
      const limiter = new SlidingWindowRateLimiter(5, 1000);
      expect(limiter.getRemaining("unknown")).toBe(5);
    });

    test("decreases as requests are made", () => {
      const limiter = new SlidingWindowRateLimiter(3, 1000);
      expect(limiter.getRemaining("k")).toBe(3);

      limiter.tryAcquire("k");
      expect(limiter.getRemaining("k")).toBe(2);

      limiter.tryAcquire("k");
      expect(limiter.getRemaining("k")).toBe(1);

      limiter.tryAcquire("k");
      expect(limiter.getRemaining("k")).toBe(0);
    });

    test("recovers after window expiration", () => {
      const limiter = new SlidingWindowRateLimiter(2, 1000);
      limiter.tryAcquire("k");
      limiter.tryAcquire("k");
      expect(limiter.getRemaining("k")).toBe(0);

      vi.advanceTimersByTime(1001);
      expect(limiter.getRemaining("k")).toBe(2);
    });

    test("returns zero for zero maxRequests", () => {
      const limiter = new SlidingWindowRateLimiter(0, 1000);
      expect(limiter.getRemaining("any")).toBe(0);
    });
  });

  describe("reset", () => {
    test("clears rate limit state for a specific key", () => {
      const limiter = new SlidingWindowRateLimiter(1, 1000);
      limiter.tryAcquire("k");
      expect(limiter.tryAcquire("k")).toBe(false);

      limiter.reset("k");
      expect(limiter.tryAcquire("k")).toBe(true);
    });

    test("does not affect other keys", () => {
      const limiter = new SlidingWindowRateLimiter(1, 1000);
      limiter.tryAcquire("a");
      limiter.tryAcquire("b");

      limiter.reset("a");

      expect(limiter.tryAcquire("a")).toBe(true);
      expect(limiter.tryAcquire("b")).toBe(false);
    });

    test("reset on unknown key is a no-op", () => {
      const limiter = new SlidingWindowRateLimiter(5, 1000);
      limiter.reset("nonexistent");
      expect(limiter.getRemaining("nonexistent")).toBe(5);
    });
  });

  describe("resetAll", () => {
    test("clears all tracked keys", () => {
      const limiter = new SlidingWindowRateLimiter(1, 1000);
      limiter.tryAcquire("a");
      limiter.tryAcquire("b");
      limiter.tryAcquire("c");

      expect(limiter.tryAcquire("a")).toBe(false);
      expect(limiter.tryAcquire("b")).toBe(false);
      expect(limiter.tryAcquire("c")).toBe(false);

      limiter.resetAll();

      expect(limiter.tryAcquire("a")).toBe(true);
      expect(limiter.tryAcquire("b")).toBe(true);
      expect(limiter.tryAcquire("c")).toBe(true);
    });
  });

  describe("memory cleanup", () => {
    test("prunes expired timestamps on tryAcquire", () => {
      const limiter = new SlidingWindowRateLimiter(100, 500);

      for (let i = 0; i < 50; i++) {
        limiter.tryAcquire("k");
      }

      vi.advanceTimersByTime(501);

      // After expiry, tryAcquire should prune old entries
      limiter.tryAcquire("k");
      expect(limiter.getRemaining("k")).toBe(99);
    });

    test("prunes expired timestamps on getRemaining", () => {
      const limiter = new SlidingWindowRateLimiter(5, 500);
      limiter.tryAcquire("k");
      limiter.tryAcquire("k");

      vi.advanceTimersByTime(501);

      // getRemaining should also prune and reflect accurate count
      expect(limiter.getRemaining("k")).toBe(5);
    });
  });

  describe("createRateLimiter factory", () => {
    test("creates a working SlidingWindowRateLimiter instance", () => {
      const config: RateLimiterConfig = { maxRequests: 2, windowMs: 1000 };
      const limiter = createRateLimiter(config);

      expect(limiter).toBeInstanceOf(SlidingWindowRateLimiter);
      expect(limiter.tryAcquire("k")).toBe(true);
      expect(limiter.tryAcquire("k")).toBe(true);
      expect(limiter.tryAcquire("k")).toBe(false);
    });
  });

  describe("RateLimitInfo type usage", () => {
    test("can construct a RateLimitInfo object with correct shape", () => {
      const info: RateLimitInfo = {
        allowed: true,
        remaining: 4,
        resetMs: 1000,
      };
      expect(info.allowed).toBe(true);
      expect(info.remaining).toBe(4);
      expect(info.resetMs).toBe(1000);
    });
  });
});
