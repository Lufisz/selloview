// Small in-memory fixed-window limiter for the pairing routes. Memory only: a restart clears the
// counters, while the pairing data itself (challenge lifetime, caps) is bounded in SQLite.
//
// ceiling: counters live in one process, so a second server instance would multiply every limit,
// upgrade: keep the counters in a shared store before running more than one instance

/**
 * @param {{limit: number, windowMs: number, maxKeys?: number}} options
 * `maxKeys` bounds memory: when full of live windows, new keys are refused (fail closed).
 */
export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  const windows = new Map();

  function currentWindow(key, nowMs) {
    const existing = windows.get(key);
    if (existing && existing.endsAt > nowMs) return existing;
    return null;
  }

  function dropExpiredWindows(nowMs) {
    for (const [key, window] of windows) {
      if (window.endsAt <= nowMs) windows.delete(key);
    }
  }

  function describe(window, nowMs) {
    const retryAfterSeconds = Math.max(1, Math.ceil((window.endsAt - nowMs) / 1000));
    return { allowed: window.count < limit, retryAfterSeconds };
  }

  return {
    /** Counts one event for `key`. */
    consume(key) {
      const nowMs = Date.now();
      let window = currentWindow(key, nowMs);
      if (!window) {
        if (windows.size >= maxKeys) dropExpiredWindows(nowMs);
        if (windows.size >= maxKeys) return { allowed: false, retryAfterSeconds: 1 };
        window = { count: 0, endsAt: nowMs + windowMs };
        windows.set(key, window);
      }
      const result = describe(window, nowMs);
      if (result.allowed) window.count += 1;
      return result;
    },
    /** Reports whether `key` is over its limit without counting. */
    peek(key) {
      const nowMs = Date.now();
      const window = currentWindow(key, nowMs);
      return window ? describe(window, nowMs) : { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
