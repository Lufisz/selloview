import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createShopSnapshotCache,
  createSnapshotCache,
  STALE_MS,
  toSafeErrorCode,
} from '../../server/shopify/snapshot-cache.mjs';

// Deliberately synthetic fixtures, never exported store data.
const STORE = 'test-shop.myshopify.com';
const NOW = new Date('2026-10-21T12:00:00Z');
const LAST_PAGE = { hasNextPage: false, endCursor: null };

function failingWith(code, message = 'SECRET') {
  return Object.assign(new Error(message), { code });
}

test('singleflight, failure preserves the last good snapshot, staleness by age', async () => {
  let currentTime = 1_000_000;
  let fetchCount = 0;
  let shouldFail = false;
  const cache = createSnapshotCache({
    now: () => currentTime,
    fetchSnapshot: async () => {
      fetchCount++;
      if (shouldFail) throw failingWith('api_error');
      return { version: fetchCount };
    },
  });
  assert.equal(cache.sync().state, 'loading');

  await Promise.all([cache.refresh(), cache.refresh()]);
  assert.equal(fetchCount, 1);
  assert.equal(cache.sync().state, 'ok');

  currentTime += STALE_MS;
  assert.equal(cache.sync().state, 'ok', 'still fresh at exactly the staleness limit');
  currentTime += 1;
  assert.equal(cache.sync().state, 'stale');

  shouldFail = true;
  await cache.refresh();
  assert.deepEqual(cache.snapshot, { version: 1 });
  assert.equal(cache.sync().state, 'stale');
  assert.equal(cache.sync().errorCode, 'api_error');

  shouldFail = false;
  await cache.refresh();
  assert.equal(cache.sync().state, 'ok');
  assert.equal(cache.sync().errorCode, null);
});

test('a cache that has never succeeded reports an error and no snapshot', async () => {
  const cache = createSnapshotCache({
    fetchSnapshot: async () => {
      throw new Error('x');
    },
  });
  await cache.refresh();
  assert.equal(cache.sync().state, 'error');
  assert.equal(cache.sync().errorCode, 'refresh_failed');
  assert.equal(cache.snapshot, null);
});

test('a synchronously throwing collector can recover and cannot expose arbitrary error codes', async () => {
  let shouldFail = true;
  const cache = createSnapshotCache({
    fetchSnapshot: () => {
      if (shouldFail) throw failingWith('private_business_string', 'private error');
      return { source: 'synthetic' };
    },
  });
  await cache.refresh();
  assert.equal(cache.inflight, null);
  assert.equal(cache.sync().state, 'error');
  assert.equal(cache.sync().errorCode, 'refresh_failed');

  shouldFail = false;
  await cache.refresh();
  assert.equal(cache.sync().state, 'ok');
});

test('keeps the last snapshot and exposes only safe codes on failure', async () => {
  let shouldFail = false;
  const cache = createSnapshotCache({
    fetchSnapshot: async () => {
      if (shouldFail) throw failingWith('shpat_SECRET', 'shpat_SECRET');
      return { ok: true };
    },
  });
  await cache.refresh();
  shouldFail = true;
  await cache.refresh();
  assert.deepEqual(cache.snapshot, { ok: true });
  assert.equal(cache.sync().errorCode, 'refresh_failed');
  assert.equal(cache.sync().state, 'stale');
  assert.doesNotMatch(JSON.stringify(cache.sync()), /SECRET/);

  assert.equal(toSafeErrorCode({ code: 'shpat_SECRET' }), 'refresh_failed');
  assert.equal(toSafeErrorCode({ code: 'bad_domain' }), 'bad_domain');
  assert.equal(toSafeErrorCode(undefined), 'refresh_failed');
});

test('clearing rejects late results without clearing a newer inflight refresh', async () => {
  const collectors = [];
  const cache = createSnapshotCache({
    fetchSnapshot: () => new Promise((resolve) => collectors.push(resolve)),
  });
  const oldRefresh = cache.refresh();
  await Promise.resolve();
  cache.clear();
  assert.equal(cache.snapshot, null);

  const newRefresh = cache.refresh();
  await Promise.resolve();
  collectors[0]({ privateMarker: 'old grant' });
  await oldRefresh;
  assert.equal(cache.snapshot, null);
  assert.equal(cache.inflight, newRefresh);

  collectors[1]({ privateMarker: 'new grant' });
  await newRefresh;
  assert.deepEqual(cache.snapshot, { privateMarker: 'new grant' });
  assert.equal(cache.inflight, null);
});

// A query runner that reports `reportedDomain` as the shop and has no orders or variants.
function runnerForShop(reportedDomain) {
  return async (queryName) => {
    if (queryName === 'shop') {
      return {
        shop: {
          name: 'Test Shop',
          myshopifyDomain: reportedDomain,
          currencyCode: 'EUR',
          ianaTimezone: 'Europe/Stockholm',
          plan: null,
        },
      };
    }
    const field = queryName === 'inventory' ? 'productVariants' : 'orders';
    return { [field]: { nodes: [], pageInfo: LAST_PAGE } };
  };
}

test('a shop cache builds its snapshot from the query runner', async () => {
  const cache = createShopSnapshotCache({
    store: STORE,
    run: runnerForShop(STORE),
    now: () => NOW.getTime(),
  });
  await cache.refresh();
  assert.equal(cache.sync().state, 'ok');
  assert.equal(cache.snapshot.shop.domain, STORE);
  assert.equal(cache.snapshot.fetchedAt, NOW.toISOString());
});

test('a shop cache refuses data from a different shop and keeps no snapshot', async () => {
  const cache = createShopSnapshotCache({
    store: STORE,
    run: runnerForShop('other-shop.myshopify.com'),
    now: () => NOW.getTime(),
  });
  await cache.refresh();
  assert.equal(cache.sync().state, 'error');
  assert.equal(cache.sync().errorCode, 'bad_domain');
  assert.equal(cache.snapshot, null);
});
