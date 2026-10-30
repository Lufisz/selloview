// The owner page's Shopify client and views, and what the TV receives and shows. Data here is
// SYNTHETIC and labelled as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../server/metrics.mjs';
import { projectBoardForDisplay } from '../../server/screens/display-board.mjs';
import {
  consumeShopifyReturn,
  disconnectShopify,
  loadShopifyStatus,
  parseConnection,
  startShopifyConnection,
} from '../../public/owner/shopify-client.js';
import { renderOwner } from '../../public/owner/owner-view.js';
import { renderStorePanel } from '../../public/owner/store-view.js';
import { renderPaired } from '../../public/tv/tv-view.js';
import { SYNTHETIC_STORE } from '../helpers/synthetic-shopify.mjs';

const OWNER = 'owner@example.test';

// ---- owner page client ---------------------------------------------------------------------------

function syntheticSnapshot({ shopName = 'Synthetic Beta Shop' } = {}) {
  const now = new Date();
  const hour = 3600 * 1000;
  const orders = [1, 2, 3].map((index) => ({
    id: `gid://shopify/Order/${index}`,
    name: `#${1000 + index}`,
    createdAt: new Date(now.getTime() - index * 30 * hour).toISOString(),
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'EUR' } },
  }));
  const raw = {
    shop: {
      name: shopName,
      myshopifyDomain: SYNTHETIC_STORE,
      currencyCode: 'EUR',
      ianaTimezone: 'Europe/Stockholm',
      plan: { publicDisplayName: 'Basic' },
    },
    since: new Date(now.getTime() - 130 * 24 * hour),
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
  return { ...buildSnapshot(raw, now), sync };
}

function fakeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('the client accepts only well-formed connections and drops unusable snapshots', async () => {
  assert.equal(parseConnection({ state: 'bogus' }), null);
  assert.equal(parseConnection({ state: 'connected', store: 'not a store' }), null);
  assert.equal(parseConnection({ state: 'connected', store: 'Upper.myshopify.com' }), null);
  assert.equal(parseConnection({ state: 'connected', sync: { state: 'weird' } }), null);
  assert.deepEqual(parseConnection({ state: 'pilot_unavailable', canConnect: false }), {
    state: 'pilot_unavailable',
    store: '',
    canConnect: false,
    sync: null,
  });

  const snapshot = syntheticSnapshot();
  const connection = {
    state: 'connected',
    store: SYNTHETIC_STORE,
    canConnect: true,
    sync: { state: 'ok' },
  };
  const good = await loadShopifyStatus(fakeFetch(200, { connection, snapshot }).fetchImpl);
  assert.equal(good.ok, true);
  assert.equal(good.snapshot.shop.name, 'Synthetic Beta Shop');

  const broken = { ...snapshot, periods: { ...snapshot.periods, week: null } };
  const dropped = await loadShopifyStatus(
    fakeFetch(200, { connection, snapshot: broken }).fetchImpl,
  );
  assert.equal(dropped.ok, true);
  assert.equal(dropped.snapshot, null, 'an invalid snapshot is never rendered');

  const notConnected = await loadShopifyStatus(
    fakeFetch(200, { connection: { ...connection, state: 'not_connected' }, snapshot }).fetchImpl,
  );
  assert.equal(notConnected.snapshot, null, 'figures only while connected');
  assert.equal(
    (await loadShopifyStatus(fakeFetch(401, { error: 'unauthenticated' }).fetchImpl)).status,
    401,
  );
  assert.equal(
    (await loadShopifyStatus(fakeFetch(200, { connection: 5 }).fetchImpl)).error,
    'malformed',
  );
});

test('starting a connection sends only the canonical store and follows only a Shopify address', async () => {
  const authorize = `https://${SYNTHETIC_STORE}/admin/oauth/authorize?client_id=x&scope=read_all_orders,read_orders,read_products,read_inventory&redirect_uri=https%3A%2F%2Fbeta.example.test%2Fauth%2Fbeta%2Fshopify%2Fcallback&state=abc`;
  const callbackUrl = 'https://beta.example.test/auth/beta/shopify/callback';
  const ok = fakeFetch(200, { authorizationUrl: authorize });
  const started = await startShopifyConnection(
    { csrfToken: 'tok', storeText: ` ${SYNTHETIC_STORE.toUpperCase()} `, callbackUrl },
    ok.fetchImpl,
  );
  assert.deepEqual(started, { ok: true, authorizationUrl: authorize });
  assert.equal(ok.calls[0].url, '/api/shopify/start');
  assert.deepEqual(JSON.parse(ok.calls[0].options.body), { store: SYNTHETIC_STORE });
  assert.equal(ok.calls[0].options.headers['X-CSRF-Token'], 'tok');
  assert.equal(ok.calls[0].options.credentials, 'same-origin');

  const never = fakeFetch(200, {});
  for (const text of ['', 'evil.example.com', 'https://x.myshopify.com', 'a b.myshopify.com']) {
    const refused = await startShopifyConnection(
      { csrfToken: 'tok', storeText: text, callbackUrl },
      never.fetchImpl,
    );
    assert.deepEqual(refused, { ok: false, error: 'invalid_store' });
  }
  assert.equal(never.calls.length, 0, 'invalid input never leaves the page');

  for (const unsafe of [
    'https://evil.example.com/admin/oauth/authorize',
    `http://${SYNTHETIC_STORE}/admin/oauth/authorize`,
    `https://${SYNTHETIC_STORE}/somewhere/else`,
    `${authorize}&scope=write_orders`,
    authorize.replace('read_all_orders,read_orders,read_products,read_inventory', 'write_orders'),
    authorize.replace('beta.example.test', 'evil.example.test'),
    'javascript:alert(1)',
    42,
  ]) {
    const result = await startShopifyConnection(
      { csrfToken: 'tok', storeText: SYNTHETIC_STORE, callbackUrl },
      fakeFetch(200, { authorizationUrl: unsafe }).fetchImpl,
    );
    assert.deepEqual(result, { ok: false, error: 'unsafe_authorize_url' }, String(unsafe));
  }
  const denied = await startShopifyConnection(
    { csrfToken: 'tok', storeText: SYNTHETIC_STORE, callbackUrl },
    fakeFetch(403, { error: 'pilot_unavailable' }).fetchImpl,
  );
  assert.deepEqual(denied, { ok: false, error: 'pilot_unavailable' });

  assert.deepEqual(
    await disconnectShopify({ csrfToken: 'tok' }, fakeFetch(200, { disconnected: true }).fetchImpl),
    { ok: true },
  );
  assert.equal(
    (await disconnectShopify({ csrfToken: 'tok' }, fakeFetch(200, {}).fetchImpl)).ok,
    false,
  );
});

test('the callback result in the address bar is read once and only if known', () => {
  assert.deepEqual(consumeShopifyReturn({ search: '?shopify=connected', pathname: '/' }), {
    result: 'connected',
    cleanedUrl: '/',
  });
  assert.deepEqual(
    consumeShopifyReturn({ search: '?a=1&shopify=failed', hash: '#x', pathname: '/' }),
    {
      result: 'failed',
      cleanedUrl: '/?a=1#x',
    },
  );
  assert.equal(consumeShopifyReturn({ search: '?shopify=%3Cscript%3E' }).result, '');
  assert.equal(consumeShopifyReturn({ search: '?shopify=connected&shopify=failed' }).result, '');
  assert.deepEqual(consumeShopifyReturn({ search: '' }), { result: '', cleanedUrl: null });
});

// ---- owner page views ----------------------------------------------------------------------------

function panel(store, overrides = {}) {
  return renderStorePanel({
    store,
    storeMessage: '',
    storeTone: 'info',
    shopifyReturn: '',
    confirmDisconnect: false,
    storeAction: '',
    ...overrides,
  });
}

const CONNECTED = {
  status: 'ready',
  connection: {
    state: 'connected',
    store: SYNTHETIC_STORE,
    canConnect: true,
    sync: { state: 'ok' },
  },
  snapshot: syntheticSnapshot(),
};

test('every connection state has an honest panel, and only the connectable ones offer a form', () => {
  const setup = panel({
    status: 'ready',
    connection: { state: 'setup_required', store: '', canConnect: false, sync: null },
    snapshot: null,
  });
  assert.match(setup, /data-store-state="setup_required"/);
  assert.match(setup, /no Shopify app configuration/);
  assert.equal(/<form|<input/.test(setup), false);

  const pilot = panel({
    status: 'ready',
    connection: { state: 'pilot_unavailable', store: '', canConnect: false, sync: null },
    snapshot: null,
  });
  assert.match(pilot, /only a pilot owner/);
  assert.equal(/<form|<input/.test(pilot), false);

  const none = panel({
    status: 'ready',
    connection: { state: 'not_connected', store: SYNTHETIC_STORE, canConnect: true, sync: null },
    snapshot: null,
  });
  assert.match(none, /data-form="connect-shopify"/);
  assert.match(none, new RegExp(`value="${SYNTHETIC_STORE}"`));
  assert.match(none, /Connect Shopify/);
  assert.match(none, /read-only/);

  const reconnect = panel({
    status: 'ready',
    connection: {
      state: 'reconnect_required',
      store: SYNTHETIC_STORE,
      canConnect: true,
      sync: null,
    },
    snapshot: null,
  });
  assert.match(reconnect, /Reconnect Shopify/);
  assert.match(reconnect, /Figures are hidden/);

  const syncing = panel({
    ...CONNECTED,
    snapshot: null,
    connection: { ...CONNECTED.connection, sync: { state: 'loading' } },
  });
  assert.match(syncing, /first read from Shopify is running/);

  const fresh = panel(CONNECTED);
  assert.match(fresh, /Figures updated/);
  assert.match(fresh, /data-action="disconnect-shopify-ask"/);
  assert.equal(fresh.includes('disconnect-shopify-confirm'), false, 'no one-click disconnect');
  const confirming = panel(CONNECTED, { confirmDisconnect: true });
  assert.match(confirming, /disconnect-shopify-confirm/);
  assert.match(confirming, /does not uninstall the app/);

  const stale = panel({
    ...CONNECTED,
    connection: { ...CONNECTED.connection, sync: { state: 'stale' } },
  });
  assert.match(stale, /last successful figures/);
  assert.match(stale, /may be out of date/);
});

test('the return from Shopify is only believed when the server agrees', () => {
  const disconnected = {
    status: 'ready',
    connection: { state: 'not_connected', store: SYNTHETIC_STORE, canConnect: true, sync: null },
    snapshot: null,
  };
  assert.equal(
    panel(disconnected, { shopifyReturn: 'connected' }).includes('approved the connection'),
    false,
  );
  assert.match(panel(CONNECTED, { shopifyReturn: 'connected' }), /approved the connection/);
  const failed = panel(disconnected, { shopifyReturn: 'failed' });
  assert.match(failed, /did not finish/);
  assert.match(failed, /role="alert"/);
});

test('store text is escaped and no credential detail can appear in the panel', () => {
  const hostile = panel(
    {
      status: 'ready',
      connection: { state: 'not_connected', store: SYNTHETIC_STORE, canConnect: true, sync: null },
      snapshot: null,
      draft: '"><script>alert(1)</script>',
    },
    { storeMessage: '<img src=x onerror=alert(1)>', storeTone: 'error' },
  );
  assert.equal(hostile.includes('<script>'), false);
  assert.equal(hostile.includes('<img src=x'), false);
  const loading = panel({ status: 'error', error: 'offline', connection: null, snapshot: null });
  assert.match(loading, /Could not reach the server/);
  assert.match(loading, /refresh-store/);
});

test('the owner board shows real-shaped figures with no demo, live-page or TV controls', () => {
  const session = {
    owner: { email: OWNER },
    workspace: { name: 'My MetricTV', revision: 0, settings: { period: 'week', theme: 'light' } },
    storeConnection: { state: 'connected' },
    csrfToken: 'owner-csrf-token',
  };
  const state = {
    session,
    message: '',
    tone: 'info',
    screens: { status: 'ready', items: [] },
    confirmRevokeId: '',
    screenMessage: '',
    screenTone: 'info',
    store: { ...CONNECTED, snapshot: syntheticSnapshot({ shopName: '<b>Shop</b>' }) },
  };
  const html = renderOwner(state);
  assert.match(html, /class="board/);
  assert.match(html, /Order value/);
  assert.equal(html.includes('<b>Shop</b>'), false, 'shop name is escaped');
  assert.match(html, /owner-page/);
  assert.equal(html.includes('href="#/tv"'), false, 'no TV route on this page');
  assert.equal(html.includes('data-action="definition"'), false);
  assert.match(html, /Order value is the sum of Shopify currentTotalPriceSet/);
  assert.match(html, /<select id="period"/);
  assert.equal(html.includes('owner-csrf-token'), false);

  const disconnected = renderOwner({
    ...state,
    store: {
      status: 'ready',
      connection: {
        state: 'reconnect_required',
        store: SYNTHETIC_STORE,
        canConnect: true,
        sync: null,
      },
      snapshot: null,
    },
  });
  assert.equal(disconnected.includes('class="board-heading"'), false, 'figures vanish with access');
});

// ---- TV projection -------------------------------------------------------------------------------

test('the display projection keeps figures and a bare order feed, never links or store identity', () => {
  const snapshot = syntheticSnapshot();
  const projected = projectBoardForDisplay(snapshot, {
    state: 'ok',
    lastSuccessAt: snapshot.fetchedAt,
    errorCode: 'x',
  });
  // Orders reach the TV with number, time, amount and status only.
  assert.equal(projected.recentOrders.length, snapshot.recentOrders.length);
  assert.ok(projected.recentOrders.length > 0, 'the synthetic snapshot has orders');
  for (const order of projected.recentOrders) {
    assert.deepEqual(Object.keys(order).sort(), [
      'amountCents',
      'createdAt',
      'fulfillmentStatus',
      'number',
      'paymentStatus',
    ]);
  }
  assert.equal(projected.recentOrders[0].number, snapshot.recentOrders[0].number);
  assert.deepEqual(projected.sync, { state: 'ok', lastSuccessAt: snapshot.fetchedAt });
  assert.equal(projected.shop.plan, null);
  const text = JSON.stringify(projected);
  for (const forbidden of [SYNTHETIC_STORE, 'myshopify', 'gid://', 'admin.shopify.com', '"url"']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.ok(projected.periods.week);
});

function pairedDisplay(board) {
  return {
    screen: { name: 'Office TV' },
    settings: { period: 'week', theme: 'light' },
    storeConnection: { state: 'connected', sync: board.sync },
    board,
  };
}

test('the TV puts latest orders beside the chart, with alerts, and no brand bar', () => {
  const snapshot = syntheticSnapshot();
  // The server sends at most three grouped alerts.
  const alerts = [1, 2, 3].map((index) => ({
    id: `alert-${index}`,
    title: `Alert ${index}`,
    description: 'Low stock',
  }));
  const board = projectBoardForDisplay({ ...snapshot, attention: alerts }, snapshot.sync);
  const html = renderPaired({
    display: pairedDisplay(board),
    notice: '',
    now: Date.parse(snapshot.fetchedAt),
  });

  assert.match(html, /board-main with-orders/);
  assert.match(html, /Latest orders/);
  assert.match(html, new RegExp(snapshot.recentOrders[0].number));
  assert.equal(/>Payment</.test(html), false);
  assert.equal(/tv-topbar/.test(html), false, 'the brand bar gives its height to the board');
  assert.match(html, /Alert 3/);
  assert.match(html, /<span class="count">3<\/span>/);
});
