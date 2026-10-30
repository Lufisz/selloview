// In-memory snapshot cache for one Shopify store, and the collector that fills it.
import { fetchShopData, ShopifyError } from '../shopify.mjs';
import { buildSnapshot } from '../metrics.mjs';

export const STALE_MS = 5 * 60 * 1000;
export const REFRESH_MS = 120 * 1000;

// Only these error codes are ever shown to clients; anything else becomes 'refresh_failed'.
const SAFE_ERROR_CODES = new Set([
  'invalid_store',
  'bad_output',
  'api_error',
  'unknown_query',
  'cli_timeout',
  'cli_failed',
  'bad_shape',
  'bad_amount',
  'bad_date',
  'bad_timezone',
  'currency_mismatch',
  'bad_inventory',
  'bad_domain',
  'api_timeout',
  'api_response_too_large',
  'api_version_mismatch',
  'reauthorization_required',
]);

export function toSafeErrorCode(error) {
  return SAFE_ERROR_CODES.has(error?.code) ? error.code : 'refresh_failed';
}

function toIsoOrNull(milliseconds) {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

/**
 * In-memory snapshot cache with singleflight refresh.
 * A failed refresh keeps the last good snapshot and records only a safe error code.
 * @param {{ fetchSnapshot: () => object | Promise<object>, now?: () => number }} options
 */
export function createSnapshotCache({ fetchSnapshot, now = () => Date.now() }) {
  const cache = {
    snapshot: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
    errorCode: null,
    inflight: null,
    timer: null,
    generation: 0,
  };

  function currentState() {
    if (!cache.snapshot) {
      const neverFinished = cache.inflight || cache.lastAttemptAt === null;
      return neverFinished ? 'loading' : 'error';
    }
    const isFresh = now() - cache.lastSuccessAt <= STALE_MS;
    return !cache.errorCode && isFresh ? 'ok' : 'stale';
  }

  cache.sync = () => ({
    state: currentState(),
    lastSuccessAt: toIsoOrNull(cache.lastSuccessAt),
    lastAttemptAt: toIsoOrNull(cache.lastAttemptAt),
    errorCode: cache.errorCode,
  });

  cache.refresh = () => {
    if (cache.inflight) return cache.inflight;
    const generation = cache.generation;
    cache.lastAttemptAt = now();
    // Promise.resolve().then also turns a synchronously throwing collector into a rejection.
    const operation = Promise.resolve()
      .then(fetchSnapshot)
      .then((snapshot) => {
        if (generation !== cache.generation) return;
        cache.snapshot = snapshot;
        cache.lastSuccessAt = now();
        cache.errorCode = null;
      })
      .catch((error) => {
        if (generation !== cache.generation) return;
        cache.errorCode = toSafeErrorCode(error);
      })
      .finally(() => {
        if (cache.inflight === operation) cache.inflight = null;
      });
    cache.inflight = operation;
    return cache.inflight;
  };

  // Disconnect/reconnect must not let a previous collector restore old merchant data.
  cache.clear = () => {
    cache.generation++;
    cache.snapshot = null;
    cache.lastSuccessAt = null;
    cache.lastAttemptAt = null;
    cache.errorCode = null;
    cache.inflight = null;
  };

  cache.start = (intervalMs = REFRESH_MS) => {
    cache.refresh();
    cache.timer = setInterval(() => cache.refresh(), intervalMs);
    cache.timer.unref();
  };

  cache.stop = () => {
    clearInterval(cache.timer);
    cache.timer = null;
  };

  return cache;
}

/**
 * Snapshot cache for one store, filled through `run`: a Shopify query runner such as the one
 * `createAdminRunner` returns.
 */
export function createShopSnapshotCache({ store, run, now = () => Date.now() }) {
  return createSnapshotCache({
    now,
    fetchSnapshot: async () => {
      // One reporting cutoff across pagination and calculation, including midnight.
      const cutoff = new Date(now());
      const rawData = await fetchShopData(run, cutoff);
      // The shop must be the configured store before any link is built from its domain.
      if (String(rawData.shop.myshopifyDomain).toLowerCase() !== store) {
        throw new ShopifyError('bad_domain');
      }
      return buildSnapshot(rawData, cutoff);
    },
  });
}
