// SYNTHETIC Shopify for the tests: a bounded fetch transport that answers the token endpoint
// and the three fixed GraphQL queries with made-up data. Nothing here contacts Shopify, uses a
// real credential or proves a live installation; it exercises protocol and failure handling only.
import crypto from 'node:crypto';

export const SYNTHETIC_STORE = 'synthetic-store.myshopify.com';
export const SYNTHETIC_CLIENT_ID = 'synthetic_client_id_0001';
export const SYNTHETIC_CLIENT_SECRET = 'synthetic_client_secret_value_0001';
export const SCOPE_TEXT = 'read_all_orders,read_orders,read_products,read_inventory';

const HOUR_MS = 3600 * 1000;
const ORDER_COUNT = 12;
// A tiny stand-in for the store logo: the PNG signature plus filler, served from the CDN host.
export const SYNTHETIC_LOGO_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic logo'),
]);
const SYNTHETIC_LOGO_URL = 'https://cdn.shopify.com/s/files/1/0000/0001/files/logo.webp?v=1';

function jsonResponse(status, json, headers = {}) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function syntheticOrders(nowMs) {
  const orders = [];
  for (let index = 0; index < ORDER_COUNT; index += 1) {
    orders.push({
      id: `gid://shopify/Order/${9000 + index}`,
      name: `#${9000 + index}`,
      createdAt: new Date(nowMs - (index + 2) * 20 * HOUR_MS).toISOString(),
      updatedAt: new Date(nowMs - (index + 2) * 20 * HOUR_MS).toISOString(),
      cancelledAt: null,
      test: false,
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: index % 3 === 0 ? 'UNFULFILLED' : 'FULFILLED',
      currentTotalPriceSet: { shopMoney: { amount: `${20 + index}.50`, currencyCode: 'EUR' } },
    });
  }
  return orders;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]  Clock used for order dates.
 */
export function createSyntheticShopify({ now = Date.now } = {}) {
  const state = {
    tokenCalls: [],
    graphqlCalls: [],
    issued: 0,
    validAccessTokens: new Set(),
    validRefreshTokens: new Set(),
    // Overrides tests can flip: a function (kind, body) returning {status, json} or undefined.
    tokenOverride: null,
    graphqlOverride: null,
    // A promise the GraphQL answers wait for, to hold a refresh in flight.
    graphqlGate: null,
    tokenGate: null,
    scope: SCOPE_TEXT,
  };

  function issueTokens() {
    state.issued += 1;
    const accessToken = `synthetic_access_${state.issued}`;
    const refreshToken = `synthetic_refresh_${state.issued}`;
    state.validAccessTokens.add(accessToken);
    state.validRefreshTokens.add(refreshToken);
    return jsonResponse(200, {
      access_token: accessToken,
      scope: state.scope,
      expires_in: 3600,
      refresh_token: refreshToken,
      refresh_token_expires_in: 7776000,
    });
  }

  async function handleToken(body) {
    const kind = body.grant_type === 'refresh_token' ? 'refresh' : 'code';
    state.tokenCalls.push({ kind, body });
    if (state.tokenGate) await state.tokenGate;
    const override = state.tokenOverride?.(kind, body);
    if (override) return jsonResponse(override.status, override.json);
    if (kind === 'refresh') {
      if (!state.validRefreshTokens.has(body.refresh_token)) {
        return jsonResponse(400, { error: 'invalid_grant' });
      }
      state.validRefreshTokens.delete(body.refresh_token);
    }
    return issueTokens();
  }

  function dataFor(queryName) {
    const nowMs = now();
    if (queryName === 'DashboardShop') {
      return {
        shop: {
          name: 'Synthetic Shop',
          myshopifyDomain: SYNTHETIC_STORE,
          currencyCode: 'EUR',
          ianaTimezone: 'Europe/Stockholm',
          plan: { publicDisplayName: 'Basic' },
        },
      };
    }
    if (queryName === 'DashboardOrders') {
      return {
        orders: {
          nodes: syntheticOrders(nowMs),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    return {
      productVariants: {
        nodes: [
          {
            id: 'gid://shopify/ProductVariant/1',
            displayName: 'Synthetic Mug - Blue',
            inventoryQuantity: 3,
            inventoryItem: { tracked: true },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  }

  async function handleGraphql(options) {
    const body = JSON.parse(options.body);
    const queryName = /query (\w+)/.exec(body.query)?.[1] ?? 'unknown';
    const accessToken = options.headers['X-Shopify-Access-Token'];
    state.graphqlCalls.push({ queryName, accessToken });
    if (state.graphqlGate) await state.graphqlGate;
    const override = state.graphqlOverride?.(queryName, accessToken);
    if (override) return jsonResponse(override.status, override.json);
    if (!state.validAccessTokens.has(accessToken)) return jsonResponse(401, { errors: 'x' });
    return jsonResponse(200, { data: dataFor(queryName) }, { 'x-shopify-api-version': '2026-07' });
  }

  async function fetchImpl(url, options) {
    const { pathname, host } = new URL(url);
    if (host === 'cdn.shopify.com' && pathname.endsWith('/logo.webp')) {
      return new Response(SYNTHETIC_LOGO_BYTES, { headers: { 'content-type': 'image/png' } });
    }
    if (host !== SYNTHETIC_STORE) return jsonResponse(404, {});
    // Storefront API (no token): only the brand logo query is answered.
    if (pathname.startsWith('/api/')) {
      const logo = { image: { url: SYNTHETIC_LOGO_URL } };
      return jsonResponse(200, { data: { shop: { brand: { logo } } } });
    }
    if (pathname === '/admin/oauth/access_token') return handleToken(JSON.parse(options.body));
    if (pathname.endsWith('/graphql.json')) return handleGraphql(options);
    return jsonResponse(404, {});
  }

  /** Makes every token/GraphQL answer wait until the returned function is called. */
  function hold(kind) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    state[kind === 'token' ? 'tokenGate' : 'graphqlGate'] = gate;
    return () => {
      state[kind === 'token' ? 'tokenGate' : 'graphqlGate'] = null;
      release();
    };
  }

  function queriesRun(name) {
    return state.graphqlCalls.filter((call) => call.queryName === name).length;
  }

  return { fetchImpl, state, hold, queriesRun };
}

/** Signs a callback query exactly like Shopify (and the SDK validator) does. */
export function signedCallbackQuery({
  state,
  shop = SYNTHETIC_STORE,
  code = 'synthetic_code',
  secret = SYNTHETIC_CLIENT_SECRET,
  extra = {},
}) {
  const params = {
    code,
    host: Buffer.from('admin.shopify.com/store/x').toString('base64'),
    shop,
    state,
    timestamp: String(Math.trunc(Date.now() / 1000)),
    ...extra,
  };
  const sorted = Object.keys(params)
    .sort()
    .map((key) => [key, params[key]]);
  const message = new URLSearchParams(sorted).toString().replace(/\+/g, '%20');
  params.hmac = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return new URLSearchParams(params).toString();
}
