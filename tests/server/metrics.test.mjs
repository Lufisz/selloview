import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  adminUrl,
  buildSnapshot,
  localDate,
  localToInstant,
  parseCents,
} from '../../server/metrics.mjs';

// Deliberately synthetic fixtures, never exported store data.
const DAY_MS = 86_400_000;
const SHOP = {
  name: 'Test Shop',
  myshopifyDomain: 'test-shop.myshopify.com',
  currencyCode: 'EUR',
  ianaTimezone: 'Europe/Stockholm',
  plan: { publicDisplayName: 'Basic' },
};
const NOW = new Date('2026-10-21T12:00:00Z'); // 14:00 CEST

function order(number, createdAt, amount, overrides = {}) {
  return {
    id: `gid://shopify/Order/${number}`,
    name: `#${number}`,
    createdAt,
    updatedAt: createdAt,
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    currentTotalPriceSet: { shopMoney: { amount, currencyCode: 'EUR' } },
    ...overrides,
  };
}

function rawShopData(orders = [], variants = [], overrides = {}) {
  return {
    shop: SHOP,
    since: new Date(NOW.getTime() - 130 * DAY_MS),
    until: NOW,
    orders,
    ordersComplete: true,
    variants,
    inventoryComplete: true,
    ...overrides,
  };
}

// One EUR 1.00 order per timestamp, reported at `now` with the full 130 days of history.
function snapshotWithOrdersAt(now, createdAtTimestamps) {
  const orders = createdAtTimestamps.map((createdAt, index) => order(index + 1, createdAt, '1.00'));
  const history = { since: new Date(now.getTime() - 130 * DAY_MS), until: now };
  return buildSnapshot(rawShopData(orders, [], history), now);
}

test('genuine empty data yields zeros and the backlog note', () => {
  const snapshot = buildSnapshot(rawShopData(), NOW);
  assert.equal(snapshot.periods.week.current.valueCents, 0);
  assert.equal(snapshot.periods.today.current.orders, 0);
  assert.equal(snapshot.periods.week.current.averageCents, 0);
  assert.deepEqual(snapshot.recentOrders, []);
  assert.equal(snapshot.charts.week.current.length, 7);
  assert.equal(snapshot.charts.week.previous.length, 7);
  assert.deepEqual(snapshot.chart, snapshot.charts.week); // legacy field, see the snapshot typedef
  assert.ok(snapshot.coverage.notes.some((note) => /older order backlog/i.test(note)));
  assert.equal(snapshot.source, 'shopify');
});

test('invalid inputs are rejected, not zeroed', () => {
  for (const amount of ['abc', '', '-1.00', '1.234', '1,5', null, 5]) {
    assert.throws(() => parseCents(amount), { code: 'bad_amount' }, String(amount));
  }
  assert.equal(parseCents('12.3'), 1230);

  const dollarOrder = order(1, '2026-10-20T10:00:00Z', '5.00', {
    currentTotalPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } },
  });
  assert.throws(() => buildSnapshot(rawShopData([dollarOrder]), NOW), {
    code: 'currency_mismatch',
  });
  assert.throws(() => buildSnapshot(rawShopData([order(1, 'not-a-date', '5.00')]), NOW), {
    code: 'bad_date',
  });
  assert.throws(() => buildSnapshot(rawShopData([order(1, '2026-10-20T10:00:00Z', 'x')]), NOW), {
    code: 'bad_amount',
  });
});

test('30 and 60 full days compare with preceding equal-length periods at exact local-midnight boundaries', () => {
  // NOW is 2026-10-21 14:00 Stockholm.
  // 30 days: Current Sep 21..Oct 20, Previous Aug 22..Sep 20.
  // 60 days: Current Aug 22..Oct 20, Previous Jun 23..Aug 21.
  const orders = [
    order(1, '2026-10-20T21:59:59Z', '1.00'), // Oct 20 23:59:59 local: last current second
    order(2, '2026-10-20T22:00:00Z', '90.00'), // Oct 21 00:00 local: today, excluded
    order(3, '2026-09-20T22:00:00Z', '2.00'), // Sep 21 00:00 local: first current 30d instant
    order(4, '2026-09-20T21:59:59Z', '3.00'), // Sep 20 23:59:59 local: last previous 30d second
    order(5, '2026-08-21T22:00:00Z', '4.00'), // Aug 22 00:00 local: first previous 30d / first current 60d instant
    order(6, '2026-08-21T21:59:59Z', '5.00'), // Aug 21 23:59:59 local: last previous 60d second
    order(7, '2026-06-22T22:00:00Z', '6.00'), // Jun 23 00:00 local: first previous 60d instant
    order(8, '2026-06-22T21:59:59Z', '80.00'), // Jun 22: outside all windows
  ];
  const { periods } = buildSnapshot(rawShopData(orders), NOW);
  assert.equal(periods.month.label, '2026-09-21 to 2026-10-20');
  assert.equal(periods.month.comparisonLabel, 'compared with previous 30 full days');
  assert.deepEqual(periods.month.current, { valueCents: 300, orders: 2, averageCents: 150 });
  assert.deepEqual(periods.month.previous, { valueCents: 700, orders: 2, averageCents: 350 });

  assert.equal(periods.days60.label, '2026-08-22 to 2026-10-20');
  assert.equal(periods.days60.comparisonLabel, 'compared with previous 60 full days');
  assert.deepEqual(periods.days60.current, { valueCents: 1000, orders: 4, averageCents: 250 });
  assert.deepEqual(periods.days60.previous, { valueCents: 1100, orders: 2, averageCents: 550 });
});

test('the long comparison fails closed rather than counting unfetched history as zero', () => {
  const shortHistory = rawShopData([], [], { since: new Date('2026-09-01T00:00:00Z') });
  assert.throws(() => buildSnapshot(shortHistory, NOW), { code: 'bad_date' });
});

test('week, today comparison, exclusions, chart and recent orders', () => {
  const orders = [
    order(1, '2026-10-21T08:00:00Z', '10.00'), // today 10:00 local (before now)
    order(2, '2026-10-21T13:00:00Z', '99.00'), // future vs now: excluded from today.current
    order(3, '2026-10-20T11:00:00Z', '4.00'), // yesterday 13:00 local: counts as previous today
    order(4, '2026-10-20T13:00:00Z', '50.00'), // yesterday 15:00 local: after same-time cutoff
    order(5, '2026-10-19T10:00:00Z', '20.00'), // week current
    order(6, '2026-10-12T10:00:00Z', '7.00'), // previous week
    order(7, '2026-10-19T10:00:00Z', '1000.00', { test: true }),
    order(8, '2026-10-19T10:00:00Z', '1000.00', { cancelledAt: '2026-10-19T11:00:00Z' }),
  ];
  const snapshot = buildSnapshot(rawShopData(orders), NOW);
  const { periods, recentOrders } = snapshot;
  const weekChart = snapshot.charts.week;
  assert.deepEqual(periods.today.current, { valueCents: 1000, orders: 1, averageCents: 1000 });
  assert.deepEqual(periods.today.previous, { valueCents: 400, orders: 1, averageCents: 400 });
  // week = Oct 14..20 local (excludes today): orders 3,4,5
  assert.equal(periods.week.current.valueCents, 400 + 5000 + 2000);
  assert.equal(periods.week.previous.valueCents, 700);
  assert.equal(periods.week.label, '2026-10-14 to 2026-10-20');
  assert.equal(weekChart.current.at(-1).date, '2026-10-20');
  assert.equal(weekChart.current.at(-1).valueCents, 5400);
  assert.equal(weekChart.previous[0].date, '2026-10-07');
  assert.equal(recentOrders[0].number, '#2');
  assert.equal(recentOrders.length, 6);
  assert.match(recentOrders[0].url, /^https:\/\/admin\.shopify\.com\/store\/test-shop\/orders\/2$/);
  assert.deepEqual(Object.keys(recentOrders[0]).sort(), [
    'amountCents',
    'createdAt',
    'fulfillmentStatus',
    'number',
    'paymentStatus',
    'url',
  ]);
});

test('timezone and DST handling', () => {
  assert.equal(localDate(Date.parse('2026-10-24T22:30:00Z'), 'Europe/Stockholm'), '2026-10-25');
  assert.equal(addDays('2026-10-25', -1), '2026-10-24');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  // Stockholm DST ends 2026-10-25: that local day is 25h long.
  const start = localToInstant('2026-10-25', 'Europe/Stockholm');
  const next = localToInstant('2026-10-26', 'Europe/Stockholm');
  assert.equal(new Date(start).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(new Date(next).toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal((next - start) / 36e5, 25);

  // 11:00 local on Oct 26. Order 1 is 00:30 local today; order 2 is 23:30 local on Oct 24.
  const now = new Date('2026-10-26T10:00:00Z');
  const dstSnapshot = buildSnapshot(
    rawShopData(
      [order(1, '2026-10-25T23:30:00Z', '3.00'), order(2, '2026-10-24T21:30:00Z', '2.00')],
      [],
      { until: now },
    ),
    now,
  );
  const weekChart = dstSnapshot.charts.week;
  assert.equal(dstSnapshot.periods.week.label, '2026-10-19 to 2026-10-25');
  assert.equal(weekChart.current.at(-1).date, '2026-10-25');
  assert.equal(weekChart.current.at(-1).valueCents, 0);
  assert.equal(weekChart.current.at(-2).valueCents, 200);
  assert.equal(dstSnapshot.periods.today.current.valueCents, 300);

  // Same-time comparison across DST: yesterday 11:00 local (CET, after the change) is 10:00Z.
  const sameTimeSnapshot = buildSnapshot(
    rawShopData(
      [order(3, '2026-10-25T09:59:00Z', '1.00'), order(4, '2026-10-25T10:01:00Z', '8.00')],
      [],
      { until: now },
    ),
    now,
  );
  assert.equal(sameTimeSnapshot.periods.today.previous.valueCents, 100);
});

test('same local clock comparison excludes orders after a missing spring DST hour', () => {
  const snapshot = snapshotWithOrdersAt(new Date('2026-03-30T00:30:00Z'), [
    '2026-03-29T00:45:00Z', // 01:45 CET, before the 02:30 wall-clock cutoff
    '2026-03-29T01:15:00Z', // 03:15 CEST, after it; yesterday had no 02:30
  ]);
  assert.equal(snapshot.periods.today.previous.valueCents, 100);
});

test('same local clock comparison handles both copies of an autumn DST hour', () => {
  const snapshot = snapshotWithOrdersAt(new Date('2026-10-26T01:30:00Z'), [
    '2026-10-25T00:15:00Z', // 02:15 CEST, before cutoff
    '2026-10-25T01:15:00Z', // 02:15 CET, also before cutoff
    '2026-10-25T00:45:00Z', // 02:45 CEST, after cutoff by local time
  ]);
  assert.equal(snapshot.periods.today.previous.valueCents, 200);
});

test('same-time comparison preserves milliseconds, not the whole prior second', () => {
  const snapshot = snapshotWithOrdersAt(new Date('2026-10-21T12:00:00.100Z'), [
    '2026-10-20T12:00:00.100Z',
    '2026-10-20T12:00:00.101Z',
  ]);
  assert.equal(snapshot.periods.today.previous.orders, 1);
});

test('backlog and inventory', () => {
  const orders = [
    order(1, '2026-10-21T10:00:00Z', '1.00', { displayFulfillmentStatus: 'UNFULFILLED' }), // recent
    order(2, '2026-10-19T10:00:00Z', '1.00', { displayFulfillmentStatus: 'UNFULFILLED' }), // overdue
    order(3, '2026-10-19T10:00:00Z', '1.00', {
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      displayFinancialStatus: 'PARTIALLY_PAID',
    }),
    order(4, '2026-10-19T10:00:00Z', '1.00', {
      displayFulfillmentStatus: 'UNFULFILLED',
      displayFinancialStatus: 'PENDING',
    }),
    order(5, '2026-10-19T10:00:00Z', '1.00', {
      displayFulfillmentStatus: 'UNFULFILLED',
      test: true,
    }),
  ];
  const variant = (id, inventoryQuantity, tracked) => ({
    id,
    displayName: id,
    inventoryQuantity,
    inventoryItem: { tracked },
  });
  const variants = [
    variant('a', 5, true),
    variant('b', 6, true),
    variant('c', 0, false),
    variant('d', -2, true),
  ];
  const snapshot = buildSnapshot(rawShopData(orders, variants), NOW);
  assert.deepEqual(snapshot.backlog, { count: 3, overdueCount: 2 });
  assert.deepEqual(snapshot.inventory, { trackedVariants: 3, lowCount: 2 });
  assert.ok(snapshot.attention.length <= 3 && snapshot.attention.length >= 2);
  assert.ok(!JSON.stringify(snapshot).includes('displayName'));
});

test('shop metadata and domain must be trustworthy before links are built', () => {
  const withShop = (shop) => rawShopData([], [], { shop });
  for (const domain of [
    'evil.example.com',
    'test-shop.myshopify.com.evil.com',
    'test-shop.myshopify.com/../x',
    'a b.myshopify.com',
    '',
    undefined,
    null,
    5,
  ]) {
    assert.throws(
      () => buildSnapshot(withShop({ ...SHOP, myshopifyDomain: domain }), NOW),
      { code: 'bad_domain' },
      String(domain),
    );
  }
  assert.throws(() => buildSnapshot(withShop({ ...SHOP, name: { x: 1 } }), NOW), {
    code: 'bad_shape',
  });
  assert.throws(() => buildSnapshot(withShop({ ...SHOP, plan: { publicDisplayName: 7 } }), NOW), {
    code: 'bad_shape',
  });
  assert.throws(() => buildSnapshot(rawShopData('x'), NOW), { code: 'bad_shape' });

  assert.equal(buildSnapshot(withShop(SHOP), NOW).shop.plan, 'Basic');
  assert.equal(buildSnapshot(withShop({ ...SHOP, plan: null }), NOW).shop.plan, null);

  assert.equal(adminUrl('evil.example.com', 'gid://shopify/Order/1'), undefined);
  assert.equal(adminUrl('synthetic.myshopify.com', 'gid://shopify/Order/12x'), undefined);
  assert.equal(adminUrl('synthetic.myshopify.com', 'gid://evil/Customer/12'), undefined);
  assert.equal(
    adminUrl('synthetic.myshopify.com', 'gid://shopify/Order/12'),
    'https://admin.shopify.com/store/synthetic/orders/12',
  );
});

test('money parsing and aggregates stay within safe integers', () => {
  assert.throws(() => parseCents('9007199254740991.00'), { code: 'bad_amount' });
  assert.throws(() => parseCents('90071992547409.92'), { code: 'bad_amount' });
  assert.equal(parseCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseCents('9'.repeat(400)), { code: 'bad_amount' });

  // Two individually valid amounts whose total is unsafe.
  const sameDay = [
    order(1, '2026-10-20T10:00:00Z', '45035996273704.99'),
    order(2, '2026-10-20T10:00:00Z', '45035996273704.99'),
  ];
  assert.throws(() => buildSnapshot(rawShopData(sameDay), NOW), { code: 'bad_amount' });

  // Same total split across days overflowing only the weekly sum is also rejected.
  const spread = [
    order(1, '2026-10-20T10:00:00Z', '45035996273704.99'),
    order(2, '2026-10-19T10:00:00Z', '45035996273704.99'),
  ];
  assert.throws(() => buildSnapshot(rawShopData(spread), NOW), { code: 'bad_amount' });

  const small = [
    order(1, '2026-10-20T10:00:00Z', '1.50'),
    order(2, '2026-10-20T10:00:00Z', '2.00'),
  ];
  assert.equal(buildSnapshot(rawShopData(small), NOW).periods.week.current.valueCents, 350);
});
