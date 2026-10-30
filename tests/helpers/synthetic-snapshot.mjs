// SYNTHETIC store figures for the browser-side tests. The orders are invented, but they run through
// the real snapshot and projection code, so the pages are exercised with the shape the server sends.
import { buildSnapshot } from '../../server/metrics.mjs';
import { projectBoardForDisplay } from '../../server/screens/display-board.mjs';

const HOUR_MS = 60 * 60 * 1000;
const HISTORY_DAYS = 130;

/**
 * A snapshot as the owner page receives it.
 * @param {object} [options]
 * @param {string} [options.shopName]
 * @param {string} [options.domain]
 * @param {number} [options.orderCount]  Orders, newest first, `hoursBetweenOrders` apart.
 * @param {number} [options.hoursBetweenOrders]
 * @param {Date} [options.now]
 */
export function syntheticSnapshot({
  shopName = 'Synthetic Shop',
  domain = 'synthetic-store.myshopify.com',
  orderCount = 3,
  hoursBetweenOrders = 30,
  now = new Date(),
} = {}) {
  const orders = Array.from({ length: orderCount }, (unused, position) => {
    const number = position + 1;
    return {
      id: `gid://shopify/Order/${number}`,
      name: `#${1000 + number}`,
      createdAt: new Date(now.getTime() - number * hoursBetweenOrders * HOUR_MS).toISOString(),
      cancelledAt: null,
      test: false,
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: number % 2 === 0 ? 'FULFILLED' : 'UNFULFILLED',
      currentTotalPriceSet: { shopMoney: { amount: `${10 + number}.00`, currencyCode: 'EUR' } },
    };
  });
  const rawShopData = {
    shop: {
      name: shopName,
      myshopifyDomain: domain,
      currencyCode: 'EUR',
      ianaTimezone: 'Europe/Stockholm',
      plan: null,
    },
    since: new Date(now.getTime() - HISTORY_DAYS * 24 * HOUR_MS),
    until: now,
    orders,
    ordersComplete: true,
    variants: [],
    inventoryComplete: true,
  };
  const sync = {
    state: 'ok',
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    errorCode: null,
  };
  return { ...buildSnapshot(rawShopData, now), sync };
}

/**
 * What `GET /api/display` answers for a paired TV that shows `snapshot`.
 * @param {object} [options]
 * @param {string} [options.screenName]
 * @param {{period: string, theme: string}} [options.settings]
 * @param {object} [options.snapshot]
 * @param {Date} [options.now]
 */
export function syntheticDisplay({
  screenName = 'Synthetic TV',
  settings = { period: 'week', theme: 'dark' },
  snapshot = syntheticSnapshot(),
  now = new Date(),
} = {}) {
  return {
    screen: { name: screenName },
    revision: 1,
    serverTime: now.toISOString(),
    settings,
    storeConnection: { state: 'connected', sync: { state: snapshot.sync.state, errorCode: null } },
    board: projectBoardForDisplay(snapshot, snapshot.sync),
  };
}
