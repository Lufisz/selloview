import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDemoHandler, DEMO_HEADERS } from '../server.mjs';
import { createCliRunner, fetchShopData, QUERIES } from '../server/shopify.mjs';
import { adminUrl, buildSnapshot, parseCents } from '../server/metrics.mjs';
import { createCache, createHandler, loadConfig, toSafeErrorCode } from '../server/live-server.mjs';
import { parseRequestPath, singleHeaderValue } from '../server/static-files.mjs';

// Synthetic fixtures only.
const HOST = 'box.example.ts.net';
const ENV = {
  SHOPIFY_STORE: 'synthetic.myshopify.com',
  LIVE_ALLOWED_USERS: 'owner@example.com',
  LIVE_ORIGIN: `https://${HOST}`,
};
const GOOD_HEADERS = [
  ['Host', HOST],
  ['Tailscale-User-Login', 'owner@example.com'],
];
const NOW = new Date('2026-10-21T12:00:00Z');
const SHOP = {
  name: 'Synthetic',
  myshopifyDomain: 'synthetic.myshopify.com',
  currencyCode: 'EUR',
  ianaTimezone: 'Europe/Stockholm',
  plan: null,
};

function makeOrder(number, amount, createdAt = '2026-10-20T10:00:00Z') {
  return {
    id: `gid://shopify/Order/${number}`,
    name: `#${number}`,
    createdAt,
    test: false,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    currentTotalPriceSet: { shopMoney: { amount, currencyCode: 'EUR' } },
  };
}
const rawData = (overrides = {}) => ({
  shop: SHOP,
  since: new Date(NOW - 130 * 864e5),
  until: NOW,
  orders: [],
  variants: [],
  ordersComplete: true,
  inventoryComplete: true,
  ...overrides,
});

function mockResponse(done) {
  const response = {
    headers: {},
    writeHead(status, headers) {
      response.status = status;
      for (const [key, value] of Object.entries(headers ?? {}))
        response.headers[key.toLowerCase()] = value;
    },
    end(body) {
      done({
        status: response.status,
        headers: response.headers,
        body: body === undefined ? '' : String(body),
      });
    },
  };
  return response;
}
const mockRequest = ({ method = 'GET', url = '/', rawPairs = GOOD_HEADERS } = {}) => ({
  socket: { remoteAddress: '127.0.0.1' },
  method,
  url,
  headers: {},
  rawHeaders: rawPairs.flatMap(([key, value]) => [key, value]),
});
const callHandler = (handler, options) =>
  new Promise((resolve) => handler(mockRequest(options), mockResponse(resolve)));

function makePublicDir() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'stillboard-sec-'));
  const publicDir = path.join(parent, 'public');
  fs.mkdirSync(publicDir);
  for (const name of [
    'index.html',
    'app.js',
    'data.js',
    'live.html',
    'live.js',
    'live.css',
    'styles.css',
    'model.js',
    'mark.svg',
    '.hidden.js',
    'notes.txt',
    'data.json',
  ]) {
    fs.writeFileSync(path.join(publicDir, name), `// ${name}`);
  }
  fs.writeFileSync(path.join(parent, 'outside.js'), '// OUTSIDE');
  fs.mkdirSync(path.join(parent, 'outside-dir'));
  fs.writeFileSync(path.join(parent, 'outside-dir', 'secret.js'), '// OUTSIDE');
  fs.symlinkSync(path.join(parent, 'outside.js'), path.join(publicDir, 'link.js'));
  fs.symlinkSync(path.join(parent, 'outside-dir'), path.join(publicDir, 'linked-dir'));
  fs.symlinkSync(path.join(publicDir, 'model.js'), path.join(publicDir, 'alias.js')); // stays inside root
  fs.mkdirSync(path.join(publicDir, '.private'));
  fs.writeFileSync(path.join(publicDir, '.private', 'x.js'), '// private');
  return publicDir;
}

const ATTACK_PATHS = [
  '/link.js',
  '/linked-dir/secret.js',
  '/.hidden.js',
  '/.private/x.js',
  '/notes.txt',
  '/data.json',
  '/../outside.js',
  '/%2e%2e/outside.js',
  '/..%2foutside.js',
  '/%00.js',
  '/a%5c..%5cmodel.js',
  '/a\\b.js',
  '//model.js',
  '/model.js/',
  '/./model.js',
  '/%2e/model.js',
  '/ok/../model.js',
];

test('demo server: confines static files, gates live entries, keeps CSP', async () => {
  const handler = createDemoHandler({ publicDir: makePublicDir() });
  for (const url of ATTACK_PATHS) {
    const result = await callHandler(handler, { url });
    assert.ok([400, 404].includes(result.status), `${url} -> ${result.status}`);
    assert.doesNotMatch(result.body, /OUTSIDE|private/);
  }
  for (const url of ['/live.html', '/live.js', '/live.css'])
    assert.equal((await callHandler(handler, { url })).status, 404, url);
  for (const url of [
    '/',
    '/index.html',
    '/app.js',
    '/styles.css',
    '/model.js',
    '/alias.js',
    '/mark.svg?x=1',
  ])
    assert.equal((await callHandler(handler, { url })).status, 200, url);
  const head = await callHandler(handler, { method: 'HEAD', url: '/' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.match(head.headers['content-security-policy'], /connect-src 'none'/);
  assert.equal(DEMO_HEADERS['Cache-Control'], 'no-store');
  const post = await callHandler(handler, { method: 'POST', url: '/' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('live server: same confinement, demo entries are not served, shared assets are', async () => {
  const cache = createCache({ fetchSnapshot: async () => ({}) });
  const handler = createHandler({ config: loadConfig(ENV), cache, publicDir: makePublicDir() });
  for (const url of ATTACK_PATHS) {
    const result = await callHandler(handler, { url });
    assert.ok([400, 404].includes(result.status), `${url} -> ${result.status}`);
    assert.doesNotMatch(result.body, /OUTSIDE|private/);
  }
  for (const url of ['/index.html', '/app.js', '/data.js'])
    assert.equal((await callHandler(handler, { url })).status, 404, url);
  for (const url of [
    '/',
    '/live.html',
    '/live.js',
    '/live.css',
    '/styles.css',
    '/model.js',
    '/mark.svg',
  ])
    assert.equal((await callHandler(handler, { url })).status, 200, url);
  assert.match((await callHandler(handler, { url: '/' })).body, /live\.html/);
  assert.match(
    (await callHandler(handler, { url: '/' })).headers['content-security-policy'],
    /connect-src 'self'/,
  );
});

test('live server: duplicate or comma-joined Host and identity headers are denied before anything else', async () => {
  const cache = createCache({ fetchSnapshot: async () => ({}) });
  const handler = createHandler({ config: loadConfig(ENV), cache, publicDir: makePublicDir() });
  const denied = [
    [
      ['Host', HOST],
      ['host', HOST],
      ['Tailscale-User-Login', 'owner@example.com'],
    ],
    [
      ['Host', `${HOST}, evil.example`],
      ['Tailscale-User-Login', 'owner@example.com'],
    ],
    [
      ['Host', HOST],
      ['Tailscale-User-Login', 'owner@example.com'],
      ['TAILSCALE-USER-LOGIN', 'owner@example.com'],
    ],
    [
      ['Host', HOST],
      ['Tailscale-User-Login', 'owner@example.com,evil@example.com'],
    ],
    [['Host', HOST]],
  ];
  for (const rawPairs of denied) {
    for (const request of [
      { url: '/api/snapshot' },
      { url: '/live.js' },
      { method: 'POST', url: '/' },
      { method: 'DELETE', url: '/x' },
    ]) {
      assert.equal(
        (await callHandler(handler, { ...request, rawPairs })).status,
        403,
        JSON.stringify([rawPairs, request]),
      );
    }
  }
  // Owner auth precedes the method check, so a valid owner gets 405 and an outsider gets 403.
  assert.equal((await callHandler(handler, { method: 'POST', url: '/' })).status, 405);
});

test('request path parsing rejects hostile encodings', () => {
  assert.deepEqual(parseRequestPath('/a/b.js?x=1#y'), { pathname: '/a/b.js' });
  assert.equal(parseRequestPath('//x').rejection, 'bad_request');
  assert.equal(parseRequestPath('/%E0%A4%A').rejection, 'bad_request');
  assert.equal(parseRequestPath('/%00').rejection, 'not_found');
  assert.equal(parseRequestPath('/a%5cb').rejection, 'not_found');
  assert.equal(parseRequestPath('/a\\b').rejection, 'not_found');
  assert.equal(singleHeaderValue(['A', '1', 'a', '2'], 'a'), null);
  assert.equal(singleHeaderValue(['A', '1,2'], 'a'), null);
  assert.equal(singleHeaderValue(['A', ' 1 '], 'a'), '1');
});

test('CLI query names must be own fixed queries', async () => {
  let executed = 0;
  const run = createCliRunner({
    store: 'synthetic.myshopify.com',
    execFile: (c, a, o, cb) => {
      executed++;
      cb(null, '{"data":{}}');
    },
  });
  for (const name of [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '',
    undefined,
    null,
    5,
    ['shop'],
    { toString: () => 'shop' },
  ]) {
    await assert.rejects(run(name), { code: 'unknown_query' }, String(name));
  }
  assert.equal(executed, 0);
  for (const name of Object.keys(QUERIES)) await run(name);
  assert.equal(executed, Object.keys(QUERIES).length);
});

test('CLI errors never carry stdout, stderr, tokens or messages', async () => {
  const failing = (c, a, o, cb) =>
    cb(
      Object.assign(new Error('token shpat_SECRET'), { stderr: 'shpat_SECRET' }),
      'shpat_SECRET',
      'shpat_SECRET',
    );
  const run = createCliRunner({ store: 'synthetic.myshopify.com', execFile: failing });
  await assert.rejects(
    run('shop'),
    (error) =>
      error.code === 'cli_failed' &&
      !/SECRET/.test(`${error.message}${JSON.stringify(error)}${error.stack}`),
  );
  const garbage = createCliRunner({
    store: 'synthetic.myshopify.com',
    execFile: (c, a, o, cb) => cb(null, 'shpat_SECRET not json'),
  });
  await assert.rejects(
    garbage('shop'),
    (error) => error.code === 'bad_output' && !/SECRET/.test(error.message),
  );
  assert.equal(toSafeErrorCode({ code: 'shpat_SECRET' }), 'refresh_failed');
  assert.equal(toSafeErrorCode({ code: 'bad_domain' }), 'bad_domain');
});

test('malformed pagination is a shape error, not a complete result', async () => {
  const emptyInventory = {
    productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
  const runnerWithOrders = (orders) => async (name) => {
    if (name === 'shop') return { shop: SHOP };
    return name === 'inventory' ? emptyInventory : { orders };
  };
  const goodNode = { id: 'gid://shopify/Order/1' };
  const malformed = [
    { nodes: [goodNode] },
    { nodes: [goodNode], pageInfo: null },
    { nodes: [goodNode], pageInfo: [] },
    { nodes: [goodNode], pageInfo: {} },
    { nodes: [goodNode], pageInfo: { hasNextPage: 'false' } },
    { nodes: [goodNode], pageInfo: { hasNextPage: 0 } },
    { nodes: [goodNode], pageInfo: { hasNextPage: undefined, endCursor: null } },
    { nodes: [goodNode], pageInfo: { hasNextPage: false, endCursor: 7 } },
    { nodes: [{ id: 5 }], pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: [null], pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: 'x', pageInfo: { hasNextPage: false, endCursor: null } },
    null,
    [],
  ];
  for (const orders of malformed)
    await assert.rejects(
      fetchShopData(runnerWithOrders(orders), NOW),
      { code: 'bad_shape' },
      JSON.stringify(orders),
    );
  // hasNextPage with no cursor stays an explicit incomplete result.
  const incomplete = await fetchShopData(
    runnerWithOrders({ nodes: [goodNode], pageInfo: { hasNextPage: true, endCursor: null } }),
    NOW,
  );
  assert.equal(incomplete.ordersComplete, false);
  await assert.rejects(
    fetchShopData(async () => ({ shop: [] }), NOW),
    { code: 'bad_shape' },
  );
});

test('shop metadata and domain must be trustworthy before links are built', () => {
  for (const domain of [
    'evil.example.com',
    'synthetic.myshopify.com.evil.com',
    'synthetic.myshopify.com/../x',
    'a b.myshopify.com',
    '',
    undefined,
    null,
    5,
  ]) {
    assert.throws(
      () => buildSnapshot(rawData({ shop: { ...SHOP, myshopifyDomain: domain } }), NOW),
      { code: 'bad_domain' },
      String(domain),
    );
  }
  assert.throws(() => buildSnapshot(rawData({ shop: { ...SHOP, name: { x: 1 } } }), NOW), {
    code: 'bad_shape',
  });
  assert.throws(
    () => buildSnapshot(rawData({ shop: { ...SHOP, plan: { publicDisplayName: 7 } } }), NOW),
    { code: 'bad_shape' },
  );
  assert.throws(() => buildSnapshot(rawData({ orders: 'x' }), NOW), { code: 'bad_shape' });
  assert.equal(adminUrl('evil.example.com', 'gid://shopify/Order/1'), undefined);
  assert.equal(adminUrl('synthetic.myshopify.com', 'gid://shopify/Order/12x'), undefined);
  assert.equal(adminUrl('synthetic.myshopify.com', 'gid://evil/Customer/12'), undefined);
  assert.equal(
    adminUrl('synthetic.myshopify.com', 'gid://shopify/Order/12'),
    'https://admin.shopify.com/store/synthetic/orders/12',
  );
});

test('money parsing and aggregates stay within safe integers', () => {
  assert.throws(() => parseCents('90071992547409.92'), { code: 'bad_amount' });
  assert.equal(parseCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseCents('9'.repeat(400)), { code: 'bad_amount' });
  // Two individually valid amounts whose total is unsafe.
  const orders = [makeOrder(1, '45035996273704.99'), makeOrder(2, '45035996273704.99')];
  assert.throws(() => buildSnapshot(rawData({ orders }), NOW), { code: 'bad_amount' });
  // Same total split across days overflowing only the weekly sum is also rejected.
  const spread = [
    makeOrder(1, '45035996273704.99', '2026-10-20T10:00:00Z'),
    makeOrder(2, '45035996273704.99', '2026-10-19T10:00:00Z'),
  ];
  assert.throws(() => buildSnapshot(rawData({ orders: spread }), NOW), { code: 'bad_amount' });
  assert.equal(
    buildSnapshot(rawData({ orders: [makeOrder(1, '1.50'), makeOrder(2, '2.00')] }), NOW).periods
      .week.current.valueCents,
    350,
  );
});

test('cache keeps last snapshot and exposes only safe codes on failure', async () => {
  let shouldFail = false;
  const cache = createCache({
    fetchSnapshot: async () => {
      if (shouldFail) throw Object.assign(new Error('shpat_SECRET'), { code: 'shpat_SECRET' });
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
});

test('OAuth routes remain behind the same exact owner and host gate as store data', async () => {
  let handled = 0;
  const connection = {
    async handle(request, response) {
      handled++;
      response.writeHead(200, {});
      response.end('{}');
      return true;
    },
  };
  const cache = createCache({ fetchSnapshot: async () => ({}) });
  const handler = createHandler({ config: loadConfig(ENV), cache, connection });
  for (const url of [
    '/api/connection',
    '/auth/shopify/start',
    '/auth/shopify/callback',
    '/api/connection/disconnect',
  ]) {
    const denied = await callHandler(handler, { url, rawPairs: [['Host', HOST]] });
    assert.equal(denied.status, 403);
    const wrongOwner = await callHandler(handler, {
      url,
      rawPairs: [
        ['Host', HOST],
        ['Tailscale-User-Login', 'other@example.com'],
      ],
    });
    assert.equal(wrongOwner.status, 403);
    const wrongHost = await callHandler(handler, {
      url,
      rawPairs: [
        ['Host', 'wrong.example'],
        ['Tailscale-User-Login', 'owner@example.com'],
      ],
    });
    assert.equal(wrongHost.status, 403);
  }
  assert.equal(handled, 0);
  assert.equal((await callHandler(handler, { url: '/api/connection' })).status, 200);
  assert.equal(handled, 1);
});

test('OAuth snapshots fail closed when setup, connection or reauthorization is required', async () => {
  const cache = createCache({
    fetchSnapshot: async () => ({ privateMarker: 'synthetic private snapshot' }),
  });
  await cache.refresh();
  for (const [state, status] of [
    ['setup_required', 503],
    ['not_connected', 409],
    ['reconnect_required', 401],
    ['connected', 200],
  ]) {
    const connection = {
      async handle() {
        return false;
      },
      async status() {
        return { mode: 'oauth', state };
      },
    };
    const handler = createHandler({ config: loadConfig(ENV), cache, connection });
    const result = await callHandler(handler, { url: '/api/snapshot' });
    assert.equal(result.status, status);
    if (state !== 'connected') assert.doesNotMatch(result.body, /privateMarker/);
  }
});

test('disconnect cache clearing rejects late results without clearing a newer inflight refresh', async () => {
  const collectors = [];
  const cache = createCache({
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

test('async connection failures return a safe response rather than an unhandled rejection', async () => {
  const connection = {
    async handle() {
      throw new Error('synthetic-secret');
    },
  };
  const handler = createHandler({
    config: loadConfig(ENV),
    cache: createCache({ fetchSnapshot: async () => ({}) }),
    connection,
  });
  const result = await callHandler(handler, { url: '/api/connection' });
  assert.equal(result.status, 503);
  assert.doesNotMatch(result.body, /synthetic-secret/);
});
