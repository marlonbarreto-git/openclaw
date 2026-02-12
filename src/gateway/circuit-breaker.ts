/**
 * Circuit breaker for gateway operations.
 *
 * Prevents cascading failures by monitoring error rates and temporarily
 * halting requests to failing downstream services. Implements the
 * standard three-state pattern: CLOSED -> OPEN -> HALF_OPEN -> CLOSED.
 */

/** The three states of a circuit breaker. */
export const enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

/** Configuration for a {@link CircuitBreaker} instance. */
export type CircuitBreakerConfig = {
  /** Number of consecutive failures before tripping to OPEN. */
  failureThreshold: number;
  /** Milliseconds to wait in OPEN before transitioning to HALF_OPEN. */
  resetTimeoutMs: number;
  /** Maximum concurrent probe requests allowed in HALF_OPEN. */
  halfOpenMaxAttempts: number;
  /** Optional callback fired on every state transition. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
};

/** Snapshot of circuit breaker counters. */
export type CircuitBreakerStats = {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureMs: number | null;
  consecutiveFailures: number;
};

/**
 * Error thrown when a call is rejected because the circuit is OPEN.
 */
export class CircuitOpenError extends Error {
  readonly state: CircuitState;
  readonly retryAfterMs: number;

  constructor(state: CircuitState, retryAfterMs: number) {
    super(`Circuit breaker is ${state}; retry after ${retryAfterMs}ms`);
    this.name = "CircuitOpenError";
    this.state = state;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Circuit breaker that wraps async operations with failure-rate monitoring.
 *
 * - **CLOSED** — requests pass through. Consecutive failures are counted;
 *   when the count reaches `failureThreshold` the breaker trips to OPEN.
 * - **OPEN** — requests are immediately rejected with {@link CircuitOpenError}.
 *   After `resetTimeoutMs` the breaker moves to HALF_OPEN.
 * - **HALF_OPEN** — a limited number of probe requests are allowed. A single
 *   success resets the breaker to CLOSED; any failure returns it to OPEN.
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private consecutiveFailures = 0;
  private lastFailureMs: number | null = null;
  private openedAtMs: number | null = null;
  private halfOpenInflight = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  /** Execute `fn` through the circuit breaker. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - (this.openedAtMs ?? Date.now());
      if (elapsed >= this.config.resetTimeoutMs) {
        this.transition(CircuitState.HALF_OPEN);
      } else {
        throw new CircuitOpenError(
          CircuitState.OPEN,
          this.config.resetTimeoutMs - elapsed,
        );
      }
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenInflight >= this.config.halfOpenMaxAttempts) {
        const remaining =
          this.config.resetTimeoutMs -
          (Date.now() - (this.openedAtMs ?? Date.now()));
        throw new CircuitOpenError(
          CircuitState.OPEN,
          Math.max(0, remaining),
        );
      }
      this.halfOpenInflight++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Current circuit state. */
  getState(): CircuitState {
    return this.state;
  }

  /** Snapshot of internal counters. */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureMs: this.lastFailureMs,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /** Force-reset the breaker to CLOSED and clear all counters. */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.halfOpenInflight = 0;
    this.openedAtMs = null;
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  private onSuccess(): void {
    this.successes++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenInflight--;
      this.transition(CircuitState.CLOSED);
      this.consecutiveFailures = 0;
      this.halfOpenInflight = 0;
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.consecutiveFailures++;
    this.lastFailureMs = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenInflight--;
      this.transition(CircuitState.OPEN);
      this.openedAtMs = Date.now();
    } else if (
      this.state === CircuitState.CLOSED &&
      this.consecutiveFailures >= this.config.failureThreshold
    ) {
      this.transition(CircuitState.OPEN);
      this.openedAtMs = Date.now();
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    this.config.onStateChange?.(from, to);
  }
}

/** Factory that creates a new {@link CircuitBreaker}. */
export function createCircuitBreaker(
  config: CircuitBreakerConfig,
): CircuitBreaker {
  return new CircuitBreaker(config);
}
