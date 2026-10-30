// Read-only Shopify data collection: the fixed GraphQL queries, store validation and cursor paging.
// A query runner (server/shopify/admin-runner.mjs) sends them; server/metrics.mjs turns the result into a snapshot.
import { CodedError } from '../errors.mjs';

export const API_VERSION = '2026-07';
// ceiling: 10,000 orders per refresh (a larger store is reported as incomplete), upgrade: an
// incremental sync that keeps orders between refreshes
export const MAX_PAGES = 100;
export const HISTORY_DAYS = 130;
const MILLISECONDS_PER_DAY = 86400000;
const STORE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?\.myshopify\.com$/;

/**
 * Raw data handed to buildSnapshot (server/metrics.mjs).
 * @typedef {object} RawShopData
 * @property {{ name: string, myshopifyDomain: string, currencyCode: string, ianaTimezone: string, plan: ({ publicDisplayName: string } | null) }} shop
 * @property {Date} since            Start of the order query window.
 * @property {Date} until            End of the order query window (the reporting cutoff).
 * @property {RawOrder[]} orders
 * @property {boolean} ordersComplete     False when paging stopped early (page cap or bad cursor).
 * @property {RawVariant[]} variants
 * @property {boolean} inventoryComplete
 *
 * @typedef {object} RawOrder
 * @property {string} id             e.g. "gid://shopify/Order/123"
 * @property {string} name
 * @property {string} createdAt      ISO instant
 * @property {boolean} test
 * @property {string | null} cancelledAt
 * @property {string} displayFinancialStatus
 * @property {string} displayFulfillmentStatus
 * @property {{ shopMoney: { amount: string, currencyCode: string } }} currentTotalPriceSet
 *
 * @typedef {object} RawVariant
 * @property {string} id
 * @property {string} displayName
 * @property {number} inventoryQuantity
 * @property {{ tracked: boolean }} inventoryItem
 */

export class ShopifyError extends CodedError {}

export const QUERIES = Object.freeze({
  shop: `query DashboardShop {
  shop { name myshopifyDomain currencyCode ianaTimezone plan { publicDisplayName } }
}`,
  orders: `query DashboardOrders($query: String!, $after: String) {
  orders(first: 100, after: $after, sortKey: CREATED_AT, query: $query) {
    nodes {
      id name createdAt updatedAt cancelledAt test
      displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`,
  inventory: `query DashboardInventory($after: String) {
  productVariants(first: 100, after: $after) {
    nodes { id displayName inventoryQuantity inventoryItem { tracked } }
    pageInfo { hasNextPage endCursor }
  }
}`,
});

export function validateStore(store) {
  if (typeof store !== 'string' || !STORE_PATTERN.test(store)) {
    throw new ShopifyError('invalid_store');
  }
  return store;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function extractData(parsed) {
  if (!isPlainObject(parsed)) throw new ShopifyError('bad_output');
  if (parsed.errors || parsed.error) throw new ShopifyError('api_error');
  const data = isPlainObject(parsed.data) ? parsed.data : parsed;
  if (data.errors) throw new ShopifyError('api_error');
  return data;
}

// Validates one GraphQL connection. hasNextPage must be a real boolean: a malformed
// pageInfo is a shape error, never "no more pages".
function readConnection(data, field) {
  const connection = isPlainObject(data) ? data[field] : undefined;
  if (
    !isPlainObject(connection) ||
    !Array.isArray(connection.nodes) ||
    !isPlainObject(connection.pageInfo)
  ) {
    throw new ShopifyError('bad_shape');
  }
  const { hasNextPage, endCursor } = connection.pageInfo;
  if (typeof hasNextPage !== 'boolean') throw new ShopifyError('bad_shape');
  if (endCursor !== null && endCursor !== undefined && typeof endCursor !== 'string') {
    throw new ShopifyError('bad_shape');
  }
  for (const node of connection.nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string') throw new ShopifyError('bad_shape');
  }
  return { nodes: connection.nodes, hasNextPage, endCursor };
}

// Follows cursors up to MAX_PAGES. Stops with complete=false (not an error) on a missing
// or repeated cursor, or when the page cap is reached.
async function paginate(run, queryName, field, variables) {
  const seenIds = new Set();
  const usedCursors = new Set();
  const nodes = [];
  let after = null;
  let complete = true;

  for (let page = 1; ; page++) {
    const pageData = readConnection(await run(queryName, { ...variables, after }), field);
    for (const node of pageData.nodes) {
      if (seenIds.has(node.id)) continue;
      seenIds.add(node.id);
      nodes.push(node);
    }
    if (!pageData.hasNextPage) break;

    const nextCursor = pageData.endCursor;
    if (typeof nextCursor !== 'string' || usedCursors.has(nextCursor)) {
      complete = false;
      break;
    }
    usedCursors.add(nextCursor);
    if (page >= MAX_PAGES) {
      complete = false;
      break;
    }
    after = nextCursor;
  }
  return { nodes, complete };
}

function readShop(shopData) {
  const shop = isPlainObject(shopData) ? shopData.shop : undefined;
  if (
    !isPlainObject(shop) ||
    typeof shop.currencyCode !== 'string' ||
    typeof shop.ianaTimezone !== 'string'
  ) {
    throw new ShopifyError('bad_shape');
  }
  return shop;
}

/**
 * Fetch raw shop, orders and variants. `now` is a Date.
 * @returns {Promise<RawShopData>}
 */
export async function fetchShopData(run, now = new Date()) {
  const shop = readShop(await run('shop', {}));
  const since = new Date(now.getTime() - HISTORY_DAYS * MILLISECONDS_PER_DAY);
  const orderQuery = `created_at:>=${since.toISOString()} created_at:<=${now.toISOString()}`;
  const orders = await paginate(run, 'orders', 'orders', { query: orderQuery });
  const inventory = await paginate(run, 'inventory', 'productVariants', {});
  return {
    shop,
    since,
    until: now,
    orders: orders.nodes,
    ordersComplete: orders.complete,
    variants: inventory.nodes,
    inventoryComplete: inventory.complete,
  };
}
