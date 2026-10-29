// Frontend behaviour for the Shopify connection UX. All data below is synthetic,
// and transports are labelled test doubles, never a claim of a real Shopify install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderLivePage } from '../public/live-view.js';
import {
  parseConnectionStatus,
  validateAuthorizeUrl,
  startAuthorization,
  disconnectLocally,
  fetchConnection,
  consumeCallbackResult,
  connectionAllowsSnapshot,
  MESSAGES,
  fetchSnapshot,
  CALLBACK_MESSAGES,
} from '../public/live-client.js';

const STORE = 'synthetic.myshopify.com';
const CALLBACK = 'https://board.example.test/auth/shopify/callback';
const SCOPES = ['read_all_orders', 'read_orders', 'read_products', 'read_inventory'];
const GOOD_URL = `https://${STORE}/admin/oauth/authorize?client_id=x&scope=read_all_orders,read_orders,read_products,read_inventory&redirect_uri=${encodeURIComponent(CALLBACK)}&state=s`;
const NOW = Date.parse('2026-10-21T12:00:00Z');

function statusBody(overrides = {}) {
  return {
    mode: 'oauth',
    state: 'not_connected',
    store: STORE,
    scopes: SCOPES,
    csrfToken: 'token_abc-123',
    callbackUrl: CALLBACK,
    ...overrides,
  };
}

function connectionOf(overrides = {}) {
  return parseConnectionStatus(statusBody(overrides)).connection;
}

function syntheticSnapshot() {
  const totals = { valueCents: 5000, orders: 2, averageCents: 2500 };
  const period = (label) => ({
    label,
    comparisonLabel: 'compared with before',
    current: totals,
    previous: { valueCents: 0, orders: 0, averageCents: 0 },
  });
  return {
    source: 'shopify',
    fetchedAt: '2026-10-21T11:59:00Z',
    shop: {
      name: 'Synthetic',
      domain: STORE,
      currency: 'SEK',
      timeZone: 'Europe/Stockholm',
      plan: null,
    },
    sync: { state: 'ok' },
    coverage: { historyDays: 60, ordersComplete: true, inventoryComplete: true, notes: [] },
    periods: {
      days60: period('2026-08-22 to 2026-10-20'),
      month: period('2026-09-23 to 2026-10-20'),
      week: period('2026-10-14 to 2026-10-20'),
      today: period('2026-10-21'),
    },
    chart: {
      current: [{ label: 'Mon', valueCents: 1000 }],
      previous: [{ label: 'Mon', valueCents: 0 }],
    },
    backlog: { count: 1, overdueCount: 0 },
    attention: [],
    recentOrders: [],
    metricDefinition: 'Order value definition.',
  };
}

function page(overrides = {}) {
  return renderLivePage({
    snapshot: null,
    unavailableMessage: '',
    period: 'week',
    theme: 'light',
    route: 'connections',
    now: NOW,
    ...overrides,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('status parser accepts the contract and rejects inconsistent or unsafe bodies', () => {
  const parsed = parseConnectionStatus(statusBody({ state: 'connected' }));
  assert.equal(parsed.connection.state, 'connected');
  assert.equal(parsed.csrfToken, 'token_abc-123');
  assert.equal('csrfToken' in parsed.connection, false, 'view model never carries the token');

  const cli = parseConnectionStatus(
    statusBody({ mode: 'cli', state: 'cli_pilot', csrfToken: '', callbackUrl: '' }),
  );
  assert.equal(cli.connection.state, 'cli_pilot');
  assert.ok(
    parseConnectionStatus(statusBody({ state: 'setup_required', store: '', csrfToken: '' })),
  );

  const rejected = [
    null,
    'text',
    statusBody({ mode: 'cli', state: 'connected' }),
    statusBody({ mode: 'oauth', state: 'cli_pilot' }),
    statusBody({ state: 'unknown' }),
    statusBody({ store: 'Evil.example.com' }),
    statusBody({ store: '' }),
    statusBody({ scopes: [...SCOPES, 'write_orders'] }),
    statusBody({ scopes: ['read_orders'] }),
    statusBody({ callbackUrl: 'http://board.example.test/auth/shopify/callback' }),
    statusBody({ callbackUrl: 'https://board.example.test/other' }),
    statusBody({ callbackUrl: `${CALLBACK}?code=1` }),
    statusBody({ csrfToken: '<script>' }),
    statusBody({ csrfToken: 5 }),
  ];
  for (const body of rejected)
    assert.equal(parseConnectionStatus(body), null, JSON.stringify(body));
});

test('authorize URL must be the exact configured store over HTTPS', () => {
  const context = { store: STORE, callbackUrl: CALLBACK };
  assert.ok(validateAuthorizeUrl(GOOD_URL, context));
  const unsafe = [
    GOOD_URL.replace('https:', 'http:'),
    GOOD_URL.replace(STORE, 'other.myshopify.com'),
    GOOD_URL.replace(STORE, `${STORE}.evil.example`),
    GOOD_URL.replace(`https://${STORE}`, `https://${STORE}@evil.example`),
    GOOD_URL.replace(`https://${STORE}`, `https://evil.example/@${STORE}`),
    GOOD_URL.replace(STORE, `${STORE}:8443`),
    GOOD_URL.replace('/admin/oauth/authorize', '/admin/oauth/other'),
    GOOD_URL.replace('/admin/oauth/authorize', '/admin/oauth/authorize/x'),
    `${GOOD_URL}#fragment`,
    GOOD_URL.replace(
      'read_all_orders,read_orders,read_products,read_inventory',
      'read_orders,write_orders',
    ),
    GOOD_URL.replace('read_all_orders,read_orders,read_products,read_inventory', 'read_orders'),
    `${GOOD_URL}&scope=read_orders`,
    GOOD_URL.replace(encodeURIComponent(CALLBACK), 'https%3A%2F%2Fevil.example%2Fcb'),
    'javascript:alert(1)',
    '//evil.example/admin/oauth/authorize',
    '',
    42,
    null,
  ];
  for (const url of unsafe) assert.equal(validateAuthorizeUrl(url, context), null, String(url));
  assert.equal(validateAuthorizeUrl(GOOD_URL, { store: 'bad store', callbackUrl: CALLBACK }), null);
});

test('start sends only the configured store with JSON, CSRF and same-origin settings', async () => {
  const calls = [];
  const fetchImpl = async (path, init) => {
    calls.push({ path, init });
    return jsonResponse({ authorizationUrl: GOOD_URL });
  };
  const outcome = await startAuthorization({
    connection: connectionOf(),
    csrfToken: 'tok',
    fetchImpl,
  });
  assert.equal(outcome.status, 'ok');
  assert.equal(calls[0].path, '/auth/shopify/start');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'tok');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].init.body), { store: STORE });
});

test('start refuses a hostile redirect and maps failures to fixed messages', async () => {
  const connection = connectionOf();
  const hostile = await startAuthorization({
    connection,
    csrfToken: 'tok',
    fetchImpl: async () =>
      jsonResponse({ authorizationUrl: 'https://evil.example/admin/oauth/authorize' }),
  });
  assert.deepEqual(hostile, { status: 'error', message: MESSAGES.unsafeAuthorizeUrl });

  const expectations = [
    [403, 'security', MESSAGES.securityExpired],
    [429, 'rate_limited', MESSAGES.rateLimited],
    [503, 'setup_required', MESSAGES.setupRequired],
    [409, 'cli_mode', MESSAGES.cliMode],
    [401, 'unauthorized', MESSAGES.unauthorized],
    [500, 'error', MESSAGES.startFailed],
  ];
  for (const [httpStatus, status, message] of expectations) {
    const outcome = await startAuthorization({
      connection,
      csrfToken: 'tok',
      fetchImpl: async () => jsonResponse({ error: 'raw upstream <secret>' }, httpStatus),
    });
    assert.deepEqual(outcome, { status, message });
  }
  const offline = await startAuthorization({
    connection,
    csrfToken: 'tok',
    fetchImpl: async () => {
      throw new TypeError('boom secret');
    },
  });
  assert.deepEqual(offline, { status: 'offline', message: MESSAGES.offline });
  const noToken = await startAuthorization({
    connection,
    csrfToken: '',
    fetchImpl: async () => assert.fail('no request'),
  });
  assert.equal(noToken.status, 'security');
});

test('local disconnect posts an empty JSON body with CSRF and requires disconnected:true', async () => {
  const calls = [];
  const ok = await disconnectLocally({
    csrfToken: 'tok',
    fetchImpl: async (path, init) => {
      calls.push({ path, init });
      return jsonResponse({ disconnected: true });
    },
  });
  assert.equal(ok.status, 'ok');
  assert.equal(calls[0].path, '/api/connection/disconnect');
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'tok');

  const unconfirmed = await disconnectLocally({
    csrfToken: 'tok',
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(unconfirmed.status, 'error');
  const failed = await disconnectLocally({
    csrfToken: 'tok',
    fetchImpl: async () => jsonResponse({}, 500),
  });
  assert.equal(failed.message, MESSAGES.disconnectFailed);
});

test('fetchConnection validates the response and reports authorization loss', async () => {
  const ok = await fetchConnection({ fetchImpl: async () => jsonResponse(statusBody()) });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.csrfToken, 'token_abc-123');
  const malformed = await fetchConnection({ fetchImpl: async () => jsonResponse({ hello: 1 }) });
  assert.equal(malformed.status, 'error');
  const denied = await fetchConnection({ fetchImpl: async () => jsonResponse({}, 403) });
  assert.equal(denied.status, 'unauthorized');
  const offline = await fetchConnection({
    fetchImpl: async () => {
      throw new Error('x');
    },
  });
  assert.equal(offline.status, 'offline');
});

test('callback query is consumed once, with fixed outcomes and the hash preserved', () => {
  const connected = consumeCallbackResult({
    search: '?connection=connected',
    hash: '#/connections',
    pathname: '/live.html',
  });
  assert.deepEqual(connected, { result: 'connected', cleanedUrl: '/live.html#/connections' });
  assert.equal(
    consumeCallbackResult({ search: '?connection=failed&x=1', hash: '#/connections' }).cleanedUrl,
    '/?x=1#/connections',
  );
  const hostile = consumeCallbackResult({
    search: '?connection=<img src=x>',
    hash: '#/connections',
  });
  assert.equal(hostile.result, '');
  assert.equal(hostile.cleanedUrl, '/#/connections');
  assert.equal(
    consumeCallbackResult({ search: '?connection=connected&connection=failed' }).result,
    '',
  );
  assert.deepEqual(consumeCallbackResult({ search: '' }), { result: '', cleanedUrl: null });
});

test('setup_required is an honest disabled state without an active connect form', () => {
  const html = page({ connection: connectionOf({ state: 'setup_required', csrfToken: '' }) });
  assert.match(html, /Server setup needed/);
  assert.match(html, /Setup required/);
  assert.match(html, /<button[^>]*disabled/);
  assert.equal(html.includes('id="connect-form"'), false);
  assert.equal(html.includes('type="submit"'), false);
  assert.match(html, new RegExp(CALLBACK.replaceAll('/', '\\/')));
  assert.equal(html.includes('metric-value'), false);
});

test('not_connected shows a read-only prefilled form and no figures, even if a snapshot lingers', () => {
  const html = page({ connection: connectionOf(), snapshot: syntheticSnapshot() });
  assert.match(html, /id="connect-form"/);
  assert.match(html, new RegExp(`id="connect-store" type="text" value="${STORE}" readonly`));
  assert.match(html, /Connect Shopify/);
  assert.match(html, /read-only access/i);
  assert.match(html, /approve read-only access in Shopify/);
  assert.equal(html.includes('Disconnect locally'), false);
  assert.equal(html.includes('Order value'), false);
  for (const route of ['dashboard', 'tv']) {
    const other = page({ connection: connectionOf(), snapshot: syntheticSnapshot(), route });
    assert.match(other, /Shopify is not connected/);
    assert.equal(other.includes('metric-value'), false);
    assert.equal(other.includes('tv-shell'), false);
  }
});

test('reconnect_required hides figures and offers reconnect plus local removal', () => {
  const html = page({
    connection: connectionOf({ state: 'reconnect_required' }),
    snapshot: syntheticSnapshot(),
  });
  assert.match(html, /Reconnect your store/);
  assert.match(html, /Reconnect Shopify/);
  assert.match(html, /expired or was revoked/);
  assert.match(html, /data-action="disconnect-ask"/);
  assert.equal(html.includes('Order value'), false);
  assert.match(
    page({ connection: connectionOf({ state: 'reconnect_required' }), route: 'dashboard' }),
    /needs to be reconnected/,
  );
});

test('connected without a snapshot is a pending first sync, not an empty or zero board', () => {
  const connected = connectionOf({ state: 'connected' });
  const connectionPage = page({ connection: connected });
  assert.match(connectionPage, /first Shopify sync has not finished/);
  assert.match(connectionPage, /Syncing/);
  const dashboard = page({ connection: connected, route: 'dashboard' });
  assert.match(dashboard, /Waiting for the first sync/);
  assert.equal(dashboard.includes('metric-value'), false);
  assert.match(
    page({ connection: connected, route: 'dashboard', unavailableMessage: MESSAGES.error }),
    /could not be refreshed/,
  );
});

test('connected with a snapshot keeps dashboard, TV, definition and Reconnect/Disconnect', () => {
  const connection = connectionOf({ state: 'connected' });
  const snapshot = syntheticSnapshot();
  assert.match(page({ connection, snapshot, route: 'dashboard' }), /Order value/);
  assert.match(page({ connection, snapshot, route: 'tv' }), /class="tv-shell/);
  const html = page({ connection, snapshot });
  assert.match(html, />Connected</);
  assert.match(html, /Reconnect Shopify/);
  assert.match(html, /data-action="disconnect-ask"/);
  assert.match(html, /Order value definition\./);
});

test('disconnect confirmation is explicit, local-only and cannot be double submitted', () => {
  const connection = connectionOf({ state: 'connected' });
  const asking = page({ connection, connectionAction: { confirmingDisconnect: true } });
  assert.match(asking, /id="disconnect-confirm"/);
  assert.match(asking, /id="disconnect-cancel"/);
  assert.match(asking, /does not uninstall the app from Shopify/);
  const busy = page({
    connection,
    connectionAction: { busy: 'disconnecting', confirmingDisconnect: true },
  });
  assert.match(busy, /id="disconnect-confirm"[^>]*disabled/);
  const failed = page({
    connection,
    connectionAction: { confirmingDisconnect: true, error: MESSAGES.disconnectFailed },
  });
  assert.match(failed, /role="alert"/);
  const starting = page({ connection: connectionOf(), connectionAction: { busy: 'starting' } });
  assert.match(starting, /id="connect-submit"[^>]*disabled/);
  assert.match(starting, /Opening Shopify/);
});

test('callback notices are fixed text; "connected" is not trusted without a server grant', () => {
  const failed = page({ connection: connectionOf(), callbackResult: 'failed' });
  assert.match(failed, /role="status"/);
  assert.ok(failed.includes(CALLBACK_MESSAGES.failed));
  const claimed = page({ connection: connectionOf(), callbackResult: 'connected' });
  assert.equal(claimed.includes(CALLBACK_MESSAGES.connected), false);
  const confirmed = page({
    connection: connectionOf({ state: 'connected' }),
    callbackResult: 'connected',
  });
  assert.ok(confirmed.includes(CALLBACK_MESSAGES.connected));
});

test('CLI pilot keeps the board working with an honest notice and no connect controls', () => {
  const connection = connectionOf({
    mode: 'cli',
    state: 'cli_pilot',
    csrfToken: '',
    callbackUrl: '',
  });
  assert.equal(connectionAllowsSnapshot(connection), true);
  const snapshot = syntheticSnapshot();
  assert.match(page({ connection, snapshot, route: 'dashboard' }), /Order value/);
  assert.match(page({ connection, snapshot, route: 'tv' }), /tv-shell/);
  const html = page({ connection, snapshot });
  assert.match(html, /CLI pilot|Connected/);
  assert.match(html, /Pilot sign-in/);
  assert.match(html, /Shopify credentials stay in the server's CLI session|own CLI login/);
  assert.equal(html.includes('id="connect-form"'), false);
  assert.equal(html.includes('disconnect-ask'), false);
});

test('callers without connection state render exactly as before', () => {
  const withSnapshot = page({ snapshot: syntheticSnapshot(), route: 'dashboard' });
  assert.match(withSnapshot, /Order value/);
  assert.match(page({ snapshot: null, route: 'dashboard' }), /Connecting to your store/);
  assert.match(page({ snapshot: syntheticSnapshot() }), /Your store, connected\./);
});

test('header wordmark and close control stay intact on connection pages', () => {
  const html = page({ connection: connectionOf(), route: 'connections' });
  assert.match(html, /Metric/);
  assert.match(html, /Private · Read only/);
  const tv = page({
    connection: connectionOf({ state: 'connected' }),
    snapshot: syntheticSnapshot(),
    route: 'tv',
  });
  assert.match(tv, /Exit TV mode/);
  assert.match(tv, /Metric/);
});

test('hostile store text is escaped and the CSRF token never reaches markup', () => {
  const hostile = { ...connectionOf(), store: '"><img src=x onerror=alert(1)>', callbackUrl: '' };
  assert.equal(page({ connection: hostile }).includes('<img src=x'), false);
  const rendered = page({ connection: connectionOf() });
  assert.equal(rendered.includes('token_abc-123'), false);
});

test('connection code keeps secrets out of storage and URLs, and stays out of demo files', async () => {
  const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const live = await read('live.js');
  assert.equal(/localStorage\.setItem\([^)]*(csrf|connection)/i.test(live), false);
  assert.equal(/(location|history)[^;]*csrf/i.test(live), false);
  for (const file of ['app.js', 'demo-view.js', 'data.js']) {
    assert.equal(/auth\/shopify|api\/connection|live-client/.test(await read(file)), false, file);
  }
  assert.match(await read('live-client.js'), /redirect: 'error'/);
});

// --- live.js wiring, driven through a minimal DOM double ---------------------------------

function createHarness({ responses, search = '', hash = '#/connections' }) {
  const listeners = { app: {}, window: {}, document: {} };
  const requests = [];
  const element = (name) => ({
    innerHTML: '',
    addEventListener(type, handler) {
      listeners[name] ??= {};
      (listeners[name][type] ??= []).push(handler);
    },
  });
  const app = element('app');
  const dialogElement = { ...element('dialog'), open: false, showModal() {}, close() {} };
  const toast = { ...element('toast'), textContent: '', classList: { add() {}, remove() {} } };
  const registry = {
    '#app': app,
    '#toast': toast,
    '#info-dialog': dialogElement,
    '#dialog-content': { innerHTML: '' },
    '#close-dialog': element('close'),
  };
  const replaced = [];
  const assigned = [];
  const queues = Object.fromEntries(
    Object.entries(responses).map(([path, list]) => [path, [...list]]),
  );
  Object.assign(globalThis, {
    // The 30 s poll must not keep the test process alive; tests trigger refreshes explicitly.
    setInterval: () => 0,
    document: {
      title: '',
      hidden: false,
      activeElement: null,
      body: { classList: { toggle() {} } },
      documentElement: { classList: { add() {}, remove() {} } },
      querySelector: (selector) => registry[selector] ?? null,
      getElementById: () => null,
      addEventListener: (type, handler) => (listeners.document[type] ??= []).push(handler),
    },
    localStorage: { getItem: () => null, setItem() {} },
    location: { search, hash, pathname: '/live.html' },
    history: { replaceState: (_state, _title, url) => replaced.push(url) },
    fetch: async (path, init = {}) => {
      requests.push({ path, method: init.method ?? 'GET', headers: init.headers, body: init.body });
      const queue = queues[path];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next() : next.clone();
    },
  });
  globalThis.window = {
    location: { assign: (url) => assigned.push(url) },
    addEventListener: (type, handler) => (listeners.window[type] ??= []).push(handler),
  };
  return { app, listeners, requests, replaced, assigned };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const tick = async () => {
  for (let index = 0; index < 5; index += 1) await settle();
};

function clickOn(harness, action) {
  const button = { dataset: { action } };
  for (const handler of harness.listeners.app.click ?? []) {
    handler({ target: { closest: () => button } });
  }
}

let importCounter = 0;
async function loadLive(harnessOptions) {
  const harness = createHarness(harnessOptions);
  await import(`../public/live.js?harness=${(importCounter += 1)}`);
  await tick();
  return harness;
}

test('live.js consumes the callback query once and shows the fixed message', async () => {
  const harness = await loadLive({
    search: '?connection=failed',
    responses: {
      '/api/connection': [jsonResponse(statusBody())],
      '/api/snapshot': [jsonResponse({}, 503)],
    },
  });
  assert.deepEqual(harness.replaced, ['/live.html#/connections']);
  assert.ok(harness.app.innerHTML.includes(CALLBACK_MESSAGES.failed));
  assert.equal(
    harness.requests.some((request) => request.path === '/api/snapshot'),
    false,
  );
});

test('live.js starts authorization with CSRF and navigates only to the validated URL', async () => {
  const harness = await loadLive({
    responses: {
      '/api/connection': [jsonResponse(statusBody())],
      '/auth/shopify/start': [jsonResponse({ authorizationUrl: GOOD_URL })],
    },
  });
  assert.match(harness.app.innerHTML, /id="connect-form"/);
  const submit = harness.listeners.app.submit[0];
  let prevented = false;
  submit({ target: { matches: () => true }, preventDefault: () => (prevented = true) });
  await tick();
  assert.equal(prevented, true);
  const start = harness.requests.find((request) => request.path === '/auth/shopify/start');
  assert.equal(start.headers['X-CSRF-Token'], 'token_abc-123');
  assert.deepEqual(JSON.parse(start.body), { store: STORE });
  assert.deepEqual(harness.assigned, [new URL(GOOD_URL).href]);
});

test('live.js shows a safe error and never navigates on a hostile authorize URL', async () => {
  const harness = await loadLive({
    responses: {
      '/api/connection': [jsonResponse(statusBody())],
      '/auth/shopify/start': [jsonResponse({ authorizationUrl: 'https://evil.example/x' })],
    },
  });
  harness.listeners.app.submit[0]({ target: { matches: () => true }, preventDefault() {} });
  await tick();
  assert.deepEqual(harness.assigned, []);
  assert.ok(harness.app.innerHTML.includes(MESSAGES.unsafeAuthorizeUrl));
});

test('live.js local disconnect needs confirmation, clears figures and ignores a stale snapshot', async () => {
  let releaseSnapshot;
  const slowSnapshot = () =>
    new Promise((resolve) => {
      releaseSnapshot = () => resolve(jsonResponse(syntheticSnapshot()));
    });
  const connected = jsonResponse(statusBody({ state: 'connected' }));
  const harness = await loadLive({
    hash: '#/dashboard',
    responses: {
      '/api/connection': [
        () => jsonResponse(statusBody({ state: 'connected' })),
        () => jsonResponse(statusBody({ state: 'connected' })),
        () => jsonResponse(statusBody({ state: 'not_connected' })),
      ],
      '/api/snapshot': [() => jsonResponse(syntheticSnapshot()), slowSnapshot],
      '/api/connection/disconnect': [jsonResponse({ disconnected: true })],
    },
  });
  void connected;
  assert.match(harness.app.innerHTML, /Order value/);
  globalThis.location.hash = '#/connections';
  harness.listeners.window.hashchange.forEach((handler) => handler());
  assert.match(harness.app.innerHTML, /data-action="disconnect-ask"/);

  clickOn(harness, 'disconnect-ask');
  assert.match(harness.app.innerHTML, /id="disconnect-confirm"/);
  assert.equal(
    harness.requests.some((request) => request.path.endsWith('/disconnect')),
    false,
  );
  clickOn(harness, 'disconnect-cancel');
  assert.equal(harness.app.innerHTML.includes('id="disconnect-confirm"'), false);

  // A refresh is in flight when the user confirms; its late snapshot must be discarded.
  const refreshing = harness.listeners.window.online[0]();
  await settle();
  clickOn(harness, 'disconnect-ask');
  clickOn(harness, 'disconnect-confirm');
  await tick();
  releaseSnapshot?.();
  await refreshing;
  await tick();
  const disconnectRequest = harness.requests.find((request) =>
    request.path.endsWith('/disconnect'),
  );
  assert.equal(disconnectRequest.method, 'POST');
  assert.equal(disconnectRequest.headers['X-CSRF-Token'], 'token_abc-123');
  assert.equal(harness.app.innerHTML.includes('metric-value'), false);
  assert.equal(harness.app.innerHTML.includes('Order value'), false);
  assert.match(harness.app.innerHTML, /Connect Shopify/);
});

test('OAuth snapshot denials are connection states, not Tailscale denials', async () => {
  const cases = [
    [401, 'reauthorization_required', 'reconnect_required', MESSAGES.reconnect],
    [409, 'store_not_connected', 'not_connected', MESSAGES.notConnected],
    [503, 'setup_required', 'setup_required', MESSAGES.setupRequired],
  ];
  for (const [httpStatus, error, status, message] of cases) {
    const outcome = await fetchSnapshot({
      fetchImpl: async () => jsonResponse({ error }, httpStatus),
    });
    assert.deepEqual(outcome, { status, message });
  }
  const plain = await fetchSnapshot({ fetchImpl: async () => jsonResponse({}, 401) });
  assert.equal(plain.status, 'unauthorized');
  const unknown = await fetchSnapshot({ fetchImpl: async () => jsonResponse({ error: 'x' }, 409) });
  assert.equal(unknown.status, 'error');
});

test('live.js clears stale metrics when the snapshot is denied for reconnection', async () => {
  const harness = await loadLive({
    hash: '#/dashboard',
    responses: {
      '/api/connection': [
        () => jsonResponse(statusBody({ state: 'connected' })),
        () => jsonResponse(statusBody({ state: 'reconnect_required' })),
      ],
      '/api/snapshot': [
        () => jsonResponse(syntheticSnapshot()),
        () => jsonResponse({ error: 'reauthorization_required' }, 401),
      ],
    },
  });
  assert.match(harness.app.innerHTML, /Order value/);
  await harness.listeners.window.online[0]();
  await tick();
  assert.equal(harness.app.innerHTML.includes('Order value'), false);
  assert.match(harness.app.innerHTML, /needs to be reconnected/);
  assert.equal(harness.app.innerHTML.includes('Tailscale'), false);
});
