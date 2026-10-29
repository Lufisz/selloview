import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, parseCents } from '../server/metrics.mjs';
import { createCache, loadConfig } from '../server/live-server.mjs';

// Deliberately synthetic fixtures, never exported store data.
const shop = {
  name: 'Synthetic Shop',
  myshopifyDomain: 'synthetic.myshopify.com',
  currencyCode: 'EUR',
  ianaTimezone: 'Europe/Stockholm',
  plan: { publicDisplayName: 'Basic' },
};
function snapshotAt(now, dates) {
  const orders = dates.map((createdAt, index) => ({
    id: `gid://shopify/Order/${index + 1}`,
    name: `#${index + 1}`,
    createdAt,
    test: false,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '1.00', currencyCode: 'EUR' } },
  }));
  return buildSnapshot(
    {
      shop,
      orders,
      variants: [],
      since: new Date(now.getTime() - 130 * 86400000),
      until: now,
      ordersComplete: true,
      inventoryComplete: true,
    },
    now,
  );
}

test('same local clock comparison excludes orders after a missing spring DST hour', () => {
  const snapshot = snapshotAt(new Date('2026-03-30T00:30:00Z'), [
    '2026-03-29T00:45:00Z', // 01:45 CET, before the 02:30 wall-clock cutoff
    '2026-03-29T01:15:00Z', // 03:15 CEST, after it; yesterday had no 02:30
  ]);
  assert.equal(snapshot.periods.today.previous.valueCents, 100);
});

test('same local clock comparison handles both copies of an autumn DST hour', () => {
  const snapshot = snapshotAt(new Date('2026-10-26T01:30:00Z'), [
    '2026-10-25T00:15:00Z', // 02:15 CEST, before cutoff
    '2026-10-25T01:15:00Z', // 02:15 CET, also before cutoff
    '2026-10-25T00:45:00Z', // 02:45 CEST, after cutoff by local time
  ]);
  assert.equal(snapshot.periods.today.previous.valueCents, 200);
});

test('same-time comparison preserves milliseconds, not the whole prior second', () => {
  const snapshot = snapshotAt(new Date('2026-10-21T12:00:00.100Z'), [
    '2026-10-20T12:00:00.100Z',
    '2026-10-20T12:00:00.101Z',
  ]);
  assert.equal(snapshot.periods.today.previous.orders, 1);
});

test('synchronously throwing collectors can recover and cannot expose arbitrary error codes', async () => {
  let fail = true;
  const cache = createCache({
    fetchSnapshot: () => {
      if (fail)
        throw Object.assign(new Error('private error'), { code: 'private_business_string' });
      return { source: 'synthetic' };
    },
  });
  await cache.refresh();
  assert.equal(cache.inflight, null);
  assert.equal(cache.sync().state, 'error');
  assert.equal(cache.sync().errorCode, 'refresh_failed');
  fail = false;
  await cache.refresh();
  assert.equal(cache.sync().state, 'ok');
});

test('unsafe money integers and origins with password-only userinfo are rejected', () => {
  assert.throws(() => parseCents('9007199254740991.00'), { code: 'bad_amount' });
  assert.throws(() =>
    loadConfig({
      SHOPIFY_STORE: 'synthetic.myshopify.com',
      LIVE_ALLOWED_USERS: 'owner@example.com',
      LIVE_ORIGIN: 'https://:password@synthetic.example:9443',
    }),
  );
});
