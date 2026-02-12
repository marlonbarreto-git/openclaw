import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitState,
  createCircuitBreaker,
  type CircuitBreakerConfig,
} from "./circuit-breaker.js";

function defaultConfig(
  overrides?: Partial<CircuitBreakerConfig>,
): CircuitBreakerConfig {
  return {
    failureThreshold: 3,
    resetTimeoutMs: 10_000,
    halfOpenMaxAttempts: 2,
    ...overrides,
  };
}

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("CLOSED state", () => {
    test("starts in CLOSED state", () => {
      const cb = new CircuitBreaker(defaultConfig());
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    test("passes through successful calls", async () => {
      const cb = new CircuitBreaker(defaultConfig());
      const result = await cb.execute(() => Promise.resolve("ok"));
      expect(result).toBe("ok");
    });

    test("returns the value from the wrapped function", async () => {
      const cb = new CircuitBreaker(defaultConfig());
      const result = await cb.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
    });

    test("counts failures without tripping below threshold", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 3 }));

      // 2 failures (below threshold of 3)
      for (let i = 0; i < 2; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error("fail"))),
        ).rejects.toThrow("fail");
      }

      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.getStats().consecutiveFailures).toBe(2);
    });

    test("resets failure count on success", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 3 }));

      // 2 failures
      for (let i = 0; i < 2; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error("fail"))),
        ).rejects.toThrow("fail");
      }

      // 1 success resets the counter
      await cb.execute(() => Promise.resolve("ok"));

      expect(cb.getStats().consecutiveFailures).toBe(0);
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    test("propagates the original error on failure", async () => {
      const cb = new CircuitBreaker(defaultConfig());
      const err = new Error("specific error");
      await expect(cb.execute(() => Promise.reject(err))).rejects.toBe(err);
    });
  });

  describe("transition to OPEN", () => {
    test("trips to OPEN after reaching failure threshold", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 3 }));

      for (let i = 0; i < 3; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error("fail"))),
        ).rejects.toThrow("fail");
      }

      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    test("fires onStateChange callback on transition", async () => {
      const onChange = vi.fn();
      const cb = new CircuitBreaker(
        defaultConfig({ failureThreshold: 2, onStateChange: onChange }),
      );

      for (let i = 0; i < 2; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error("fail"))),
        ).rejects.toThrow("fail");
      }

      expect(onChange).toHaveBeenCalledWith(
        CircuitState.CLOSED,
        CircuitState.OPEN,
      );
    });
  });

  describe("OPEN state", () => {
    test("rejects immediately with CircuitOpenError", async () => {
      const cb = new CircuitBreaker(
        defaultConfig({ failureThreshold: 1, resetTimeoutMs: 10_000 }),
      );

      // Trip the circuit
      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");

      expect(cb.getState()).toBe(CircuitState.OPEN);

      // Now it should reject with CircuitOpenError
      const fn = vi.fn();
      await expect(cb.execute(fn)).rejects.toThrow(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });

    test("CircuitOpenError has correct properties", async () => {
      const cb = new CircuitBreaker(
        defaultConfig({ failureThreshold: 1, resetTimeoutMs: 5_000 }),
      );

      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");

      try {
        await cb.execute(() => Promise.resolve("ok"));
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(CircuitOpenError);
        const err = e as CircuitOpenError;
        expect(err.state).toBe(CircuitState.OPEN);
        expect(err.retryAfterMs).toBeGreaterThan(0);
        expect(err.retryAfterMs).toBeLessThanOrEqual(5_000);
      }
    });

    test("does not call the wrapped function while open", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 1 }));

      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");

      const fn = vi.fn(() => Promise.resolve("ok"));
      await expect(cb.execute(fn)).rejects.toThrow(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("transition to HALF_OPEN", () => {
    test("transitions to HALF_OPEN after resetTimeoutMs", async () => {
      const cb = new CircuitBreaker(
        defaultConfig({ failureThreshold: 1, resetTimeoutMs: 5_000 }),
      );

      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");
      expect(cb.getState()).toBe(CircuitState.OPEN);

      vi.advanceTimersByTime(5_000);

      // The next call should be allowed (HALF_OPEN)
      const result = await cb.execute(() => Promise.resolve("recovered"));
      expect(result).toBe("recovered");
    });

    test("fires onStateChange for OPEN to HALF_OPEN", async () => {
      const onChange = vi.fn();
      const cb = new CircuitBreaker(
        defaultConfig({
          failureThreshold: 1,
          resetTimeoutMs: 5_000,
          onStateChange: onChange,
        }),
      );

      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");
      onChange.mockClear();

      vi.advanceTimersByTime(5_000);

      await cb.execute(() => Promise.resolve("ok"));

      // Should have fired OPEN -> HALF_OPEN and then HALF_OPEN -> CLOSED
      expect(onChange).toHaveBeenCalledWith(
        CircuitState.OPEN,
        CircuitState.HALF_OPEN,
      );
    });
  });

  describe("HALF_OPEN state", () => {
    test("success transitions back to CLOSED", async () => {
      const onChange = vi.fn();
      const cb = new CircuitBreaker(
        defaultConfig({
          failureThreshold: 1,
          resetTimeoutMs: 5_000,
          onStateChange: onChange,
        }),
      );

      // Trip to OPEN
      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");
      onChange.mockClear();

      // Wait for reset timeout
      vi.advanceTimersByTime(5_000);

      // Successful call in HALF_OPEN
      await cb.execute(() => Promise.resolve("recovered"));

      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(onChange).toHaveBeenCalledWith(
        CircuitState.HALF_OPEN,
        CircuitState.CLOSED,
      );
    });

    test("failure transitions back to OPEN", async () => {
      const onChange = vi.fn();
      const cb = new CircuitBreaker(
        defaultConfig({
          failureThreshold: 1,
          resetTimeoutMs: 5_000,
          onStateChange: onChange,
        }),
      );

      // Trip to OPEN
      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");
      onChange.mockClear();

      // Wait for reset timeout
      vi.advanceTimersByTime(5_000);

      // Failure in HALF_OPEN
      await expect(
        cb.execute(() => Promise.reject(new Error("still broken"))),
      ).rejects.toThrow("still broken");

      expect(cb.getState()).toBe(CircuitState.OPEN);
      expect(onChange).toHaveBeenCalledWith(
        CircuitState.HALF_OPEN,
        CircuitState.OPEN,
      );
    });

    test("limits concurrent attempts in HALF_OPEN", async () => {
      const cb = new CircuitBreaker(
        defaultConfig({
          failureThreshold: 1,
          resetTimeoutMs: 5_000,
          halfOpenMaxAttempts: 2,
        }),
      );

      // Trip to OPEN
      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");

      // Wait for reset timeout
      vi.advanceTimersByTime(5_000);

      // Create pending promises that don't resolve yet
      let resolveFirst!: (v: string) => void;
      let resolveSecond!: (v: string) => void;
      const first = cb.execute(
        () => new Promise<string>((r) => (resolveFirst = r)),
      );
      const second = cb.execute(
        () => new Promise<string>((r) => (resolveSecond = r)),
      );

      // Third attempt should be rejected (max 2)
      await expect(
        cb.execute(() => Promise.resolve("nope")),
      ).rejects.toThrow(CircuitOpenError);

      // Resolve the pending ones
      resolveFirst("a");
      resolveSecond("b");
      await expect(first).resolves.toBe("a");
      await expect(second).resolves.toBe("b");
    });
  });

  describe("reset", () => {
    test("force resets to CLOSED", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 1 }));

      // Trip to OPEN
      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");
      expect(cb.getState()).toBe(CircuitState.OPEN);

      cb.reset();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.getStats().consecutiveFailures).toBe(0);
    });

    test("allows calls again after reset", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 1 }));

      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");

      cb.reset();
      const result = await cb.execute(() => Promise.resolve("ok"));
      expect(result).toBe("ok");
    });
  });

  describe("stats", () => {
    test("tracks failures and successes", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 5 }));

      await cb.execute(() => Promise.resolve("ok"));
      await cb.execute(() => Promise.resolve("ok"));
      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow();

      const stats = cb.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.successes).toBe(2);
      expect(stats.failures).toBe(1);
      expect(stats.consecutiveFailures).toBe(1);
      expect(stats.lastFailureMs).toBeTypeOf("number");
    });

    test("lastFailureMs is null when no failures", () => {
      const cb = new CircuitBreaker(defaultConfig());
      expect(cb.getStats().lastFailureMs).toBeNull();
    });

    test("stats reflect current state", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 1 }));

      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow();

      expect(cb.getStats().state).toBe(CircuitState.OPEN);
    });
  });

  describe("concurrent execution", () => {
    test("handles concurrent calls in CLOSED state", async () => {
      const cb = new CircuitBreaker(defaultConfig());

      const results = await Promise.all([
        cb.execute(() => Promise.resolve(1)),
        cb.execute(() => Promise.resolve(2)),
        cb.execute(() => Promise.resolve(3)),
      ]);

      expect(results).toEqual([1, 2, 3]);
    });

    test("handles mixed success and failure concurrently", async () => {
      const cb = new CircuitBreaker(defaultConfig({ failureThreshold: 5 }));

      const results = await Promise.allSettled([
        cb.execute(() => Promise.resolve("ok")),
        cb.execute(() => Promise.reject(new Error("fail"))),
        cb.execute(() => Promise.resolve("ok2")),
      ]);

      expect(results[0]).toEqual({ status: "fulfilled", value: "ok" });
      expect(results[1]).toMatchObject({ status: "rejected" });
      expect(results[2]).toEqual({ status: "fulfilled", value: "ok2" });
    });
  });

  describe("onStateChange callback", () => {
    test("fires for full lifecycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED", async () => {
      const onChange = vi.fn();
      const cb = new CircuitBreaker(
        defaultConfig({
          failureThreshold: 1,
          resetTimeoutMs: 5_000,
          onStateChange: onChange,
        }),
      );

      // CLOSED -> OPEN
      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow();

      // OPEN -> HALF_OPEN -> CLOSED
      vi.advanceTimersByTime(5_000);
      await cb.execute(() => Promise.resolve("ok"));

      expect(onChange).toHaveBeenCalledTimes(3);
      expect(onChange).toHaveBeenNthCalledWith(
        1,
        CircuitState.CLOSED,
        CircuitState.OPEN,
      );
      expect(onChange).toHaveBeenNthCalledWith(
        2,
        CircuitState.OPEN,
        CircuitState.HALF_OPEN,
      );
      expect(onChange).toHaveBeenNthCalledWith(
        3,
        CircuitState.HALF_OPEN,
        CircuitState.CLOSED,
      );
    });

    test("does not throw if onStateChange is not provided", async () => {
      const cb = new CircuitBreaker(
        defaultConfig({ failureThreshold: 1, onStateChange: undefined }),
      );

      await expect(
        cb.execute(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow();

      expect(cb.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe("createCircuitBreaker factory", () => {
    test("returns a CircuitBreaker instance", () => {
      const cb = createCircuitBreaker(defaultConfig());
      expect(cb).toBeInstanceOf(CircuitBreaker);
    });
  });
});
