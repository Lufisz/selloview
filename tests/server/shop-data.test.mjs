import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShopData, HISTORY_DAYS, MAX_PAGES, validateStore } from '../../server/shopify.mjs';
import { buildSnapshot } from '../../server/metrics.mjs';

// Deliberately synthetic fixtures, never exported store data.
const SHOP = {
  name: 'Test Shop',
  myshopifyDomain: 'test-shop.myshopify.com',
  currencyCode: 'EUR',
  ianaTimezone: 'Europe/Stockholm',
  plan: { publicDisplayName: 'Basic' },
};
const NOW = new Date('2026-10-21T12:00:00Z');
const LAST_PAGE = { hasNextPage: false, endCursor: null };

function order(number, createdAt, amount) {
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
  };
}

// A query runner that answers `shop` and `inventory` with empty data and serves `orders`
// from `ordersForPage(pageIndex)`.
function runnerWithOrderPages(ordersForPage) {
  let pageIndex = 0;
  return async (queryName) => {
    if (queryName === 'shop') return { shop: SHOP };
    if (queryName === 'inventory') return { productVariants: { nodes: [], pageInfo: LAST_PAGE } };
    return { orders: ordersForPage(pageIndex++) };
  };
}

test('store validation', () => {
  assert.equal(validateStore('a-b.myshopify.com'), 'a-b.myshopify.com');
  for (const store of [
    '',
    undefined,
    'evil.com',
    'a.myshopify.com.evil.com',
    'https://a.myshopify.com',
    'a b.myshopify.com',
    '-a.myshopify.com',
  ]) {
    assert.throws(() => validateStore(store), { code: 'invalid_store' }, String(store));
  }
});

test('pagination: multiple pages, dedupe', async () => {
  const run = runnerWithOrderPages((pageIndex) =>
    pageIndex === 0
      ? {
          nodes: [order(1, '2026-10-20T10:00:00Z', '5.00')],
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
        }
      : {
          nodes: [
            order(1, '2026-10-20T10:00:00Z', '5.00'),
            order(2, '2026-10-20T11:00:00Z', '6.00'),
          ],
          pageInfo: LAST_PAGE,
        },
  );
  const data = await fetchShopData(run, NOW);
  assert.equal(data.orders.length, 2);
  assert.equal(data.ordersComplete, true);
});

test('pagination: repeated cursor and page cap flag incomplete', async () => {
  let pagesRequested = 0;
  const repeatedCursor = await fetchShopData(
    runnerWithOrderPages((pageIndex) => {
      pagesRequested++;
      return {
        nodes: [order(pageIndex, '2026-10-20T10:00:00Z', '1.00')],
        pageInfo: { hasNextPage: true, endCursor: 'same' },
      };
    }),
    NOW,
  );
  assert.equal(repeatedCursor.ordersComplete, false);
  assert.equal(pagesRequested, 2, 'stops as soon as a cursor repeats');

  pagesRequested = 0;
  const pageCapped = await fetchShopData(
    runnerWithOrderPages((pageIndex) => {
      pagesRequested++;
      return {
        nodes: [order(pageIndex, '2026-10-20T10:00:00Z', '1.00')],
        pageInfo: { hasNextPage: true, endCursor: `cursor-${pageIndex}` },
      };
    }),
    NOW,
  );
  assert.equal(pageCapped.ordersComplete, false);
  assert.equal(pagesRequested, MAX_PAGES);

  const snapshot = buildSnapshot(pageCapped, NOW);
  assert.equal(snapshot.coverage.ordersComplete, false);
  assert.ok(snapshot.attention.some((item) => item.id === 'orders-incomplete'));
});

test('malformed pagination is a shape error, not a complete result', async () => {
  const goodNode = { id: 'gid://shopify/Order/1' };
  const malformedOrders = [
    { nodes: [goodNode] },
    { nodes: [goodNode], pageInfo: null },
    { nodes: [goodNode], pageInfo: [] },
    { nodes: [goodNode], pageInfo: {} },
    { nodes: [goodNode], pageInfo: { hasNextPage: 'false' } },
    { nodes: [goodNode], pageInfo: { hasNextPage: 0 } },
    { nodes: [goodNode], pageInfo: { hasNextPage: undefined, endCursor: null } },
    { nodes: [goodNode], pageInfo: { hasNextPage: false, endCursor: 7 } },
    { nodes: [{ id: 5 }], pageInfo: LAST_PAGE },
    { nodes: [null], pageInfo: LAST_PAGE },
    { nodes: 'x', pageInfo: LAST_PAGE },
    null,
    [],
  ];
  for (const orders of malformedOrders) {
    await assert.rejects(
      fetchShopData(
        runnerWithOrderPages(() => orders),
        NOW,
      ),
      { code: 'bad_shape' },
      JSON.stringify(orders),
    );
  }

  // hasNextPage with no cursor stays an explicit incomplete result.
  const incomplete = await fetchShopData(
    runnerWithOrderPages(() => ({
      nodes: [goodNode],
      pageInfo: { hasNextPage: true, endCursor: null },
    })),
    NOW,
  );
  assert.equal(incomplete.ordersComplete, false);

  await assert.rejects(
    fetchShopData(async () => ({ shop: [] }), NOW),
    { code: 'bad_shape' },
  );
});

test('the fetched history covers the longest comparison period', async () => {
  const emptyShop = runnerWithOrderPages(() => ({ nodes: [], pageInfo: LAST_PAGE }));
  const orderQueries = [];
  const run = async (queryName, variables) => {
    if (queryName === 'orders') orderQueries.push(variables.query);
    return emptyShop(queryName, variables);
  };
  const data = await fetchShopData(run, NOW);

  const since = new Date(NOW.getTime() - HISTORY_DAYS * 86_400_000);
  assert.deepEqual(orderQueries, [
    `created_at:>=${since.toISOString()} created_at:<=${NOW.toISOString()}`,
  ]);
  // buildSnapshot refuses a window shorter than 2 x 60 days, so this fails if HISTORY_DAYS shrinks.
  assert.doesNotThrow(() => buildSnapshot(data, NOW));
});
