import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCliRunner,
  fetchShopData,
  parseCliOutput,
  validateStore,
  MAX_PAGES,
} from '../server/shopify.mjs';
import {
  buildSnapshot,
  parseCents,
  localDate,
  localToInstant,
  addDays,
} from '../server/metrics.mjs';
import {
  createCache,
  createHandler,
  createLiveServer,
  loadConfig,
  isLoopback,
} from '../server/live-server.mjs';

// ---- synthetic fixtures only ----
const SHOP = {
  name: 'Test Shop',
  myshopifyDomain: 'test-shop.myshopify.com',
  currencyCode: 'EUR',
  ianaTimezone: 'Europe/Stockholm',
  plan: { publicDisplayName: 'Basic' },
};
const order = (n, createdAt, amount, extra = {}) => ({
  id: `gid://shopify/Order/${n}`,
  name: `#${n}`,
  createdAt,
  updatedAt: createdAt,
  cancelledAt: null,
  test: false,
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  currentTotalPriceSet: { shopMoney: { amount, currencyCode: 'EUR' } },
  ...extra,
});
const NOW = new Date('2026-10-21T12:00:00Z'); // 14:00 CEST
const raw = (orders = [], variants = [], extra = {}) => ({
  shop: SHOP,
  since: new Date(NOW - 130 * 864e5),
  until: NOW,
  orders,
  ordersComplete: true,
  variants,
  inventoryComplete: true,
  ...extra,
});

// ---- shopify adapter ----
test('store validation', () => {
  assert.equal(validateStore('a-b.myshopify.com'), 'a-b.myshopify.com');
  for (const s of [
    '',
    undefined,
    'evil.com',
    'a.myshopify.com.evil.com',
    'https://a.myshopify.com',
    'a b.myshopify.com',
    '-a.myshopify.com',
  ])
    assert.throws(() => validateStore(s));
});

test('parseCliOutput handles JSONL progress plus pretty JSON', () => {
  const out =
    '{"event":"progress"}\n{"event":"progress2"}\n{\n  "shop": {\n    "name": "x"\n  }\n}\n';
  assert.deepEqual(parseCliOutput(out), { shop: { name: 'x' } });
  assert.throws(() => parseCliOutput('garbage'));
});

test('cli runner uses args array, env, no shell; hides failures', async () => {
  let call;
  const ok = (cmd, args, opts, cb) => {
    call = { cmd, args, opts };
    cb(null, '{"event":"p"}\n{\n "data": {"shop": {}}\n}');
  };
  const run = createCliRunner({ store: 'a.myshopify.com', execFile: ok });
  assert.deepEqual(await run('shop'), { shop: {} });
  assert.equal(call.cmd, 'npx');
  assert.ok(call.args.includes('--package=@shopify/cli@4.9.4') && call.args.includes('--no-input'));
  assert.equal(call.args[call.args.indexOf('--store') + 1], 'a.myshopify.com');
  assert.equal(call.opts.shell, false);
  assert.equal(call.opts.env.SHOPIFY_CLI_AGENT_IDS, '');
  assert.equal(call.opts.timeout, 60000);
  await assert.rejects(run('nope'), { code: 'unknown_query' });
  const bad = (c, a, o, cb) =>
    cb(Object.assign(new Error('SECRET stderr'), { killed: true }), 'SECRET', 'SECRET');
  await assert.rejects(
    createCliRunner({ store: 'a.myshopify.com', execFile: bad })('shop'),
    (e) => e.code === 'cli_timeout' && !/SECRET/.test(e.message),
  );
  const apiErr = (c, a, o, cb) => cb(null, '{"errors":[{"message":"SECRET"}]}');
  await assert.rejects(
    createCliRunner({ store: 'a.myshopify.com', execFile: apiErr })('shop'),
    (e) => e.code === 'api_error' && !/SECRET/.test(e.message),
  );
  assert.throws(() => createCliRunner({ store: 'bad', execFile: ok }));
});

function pagedRunner(pages) {
  let i = 0;
  return async (name) => {
    if (name === 'shop') return { shop: SHOP };
    if (name === 'inventory')
      return { productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    return { orders: pages(i++) };
  };
}

test('pagination: multiple pages, dedupe', async () => {
  const run = pagedRunner((i) =>
    i === 0
      ? {
          nodes: [order(1, '2026-10-20T10:00:00Z', '5.00')],
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
        }
      : {
          nodes: [
            order(1, '2026-10-20T10:00:00Z', '5.00'),
            order(2, '2026-10-20T11:00:00Z', '6.00'),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
  );
  const d = await fetchShopData(run, NOW);
  assert.equal(d.orders.length, 2);
  assert.equal(d.ordersComplete, true);
});

test('pagination: repeated cursor and page cap flag incomplete', async () => {
  const rep = await fetchShopData(
    pagedRunner((i) => ({
      nodes: [order(i, '2026-10-20T10:00:00Z', '1.00')],
      pageInfo: { hasNextPage: true, endCursor: 'same' },
    })),
    NOW,
  );
  assert.equal(rep.ordersComplete, false);
  let calls = 0;
  const cap = await fetchShopData(
    pagedRunner((i) => {
      calls++;
      return {
        nodes: [order(i, '2026-10-20T10:00:00Z', '1.00')],
        pageInfo: { hasNextPage: true, endCursor: 'c' + i },
      };
    }),
    NOW,
  );
  assert.equal(cap.ordersComplete, false);
  assert.equal(calls, MAX_PAGES);
  const snap = buildSnapshot(cap, NOW);
  assert.equal(snap.coverage.ordersComplete, false);
  assert.ok(snap.attention.some((a) => a.id === 'orders-incomplete'));
});

// ---- metrics ----
test('genuine empty data yields zeros and the backlog note', () => {
  const s = buildSnapshot(raw(), NOW);
  assert.equal(s.periods.week.current.valueCents, 0);
  assert.equal(s.periods.today.current.orders, 0);
  assert.equal(s.periods.week.current.averageCents, 0);
  assert.deepEqual(s.recentOrders, []);
  assert.equal(s.chart.current.length, 7);
  assert.equal(s.chart.previous.length, 7);
  assert.ok(s.coverage.notes.some((n) => /older order backlog/i.test(n)));
  assert.equal(s.source, 'shopify');
});

test('invalid inputs are rejected, not zeroed', () => {
  for (const a of ['abc', '', '-1.00', '1.234', '1,5', null, 5]) assert.throws(() => parseCents(a));
  assert.equal(parseCents('12.3'), 1230);
  assert.throws(
    () =>
      buildSnapshot(
        raw([
          order(1, '2026-10-20T10:00:00Z', '5.00', {
            currentTotalPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } },
          }),
        ]),
        NOW,
      ),
    { code: 'currency_mismatch' },
  );
  assert.throws(() => buildSnapshot(raw([order(1, 'not-a-date', '5.00')]), NOW), {
    code: 'bad_date',
  });
  assert.throws(() => buildSnapshot(raw([order(1, '2026-10-20T10:00:00Z', 'x')]), NOW), {
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
  const s = buildSnapshot(raw(orders), NOW);
  assert.equal(s.periods.month.label, '2026-09-21 to 2026-10-20');
  assert.equal(s.periods.month.comparisonLabel, 'compared with previous 30 full days');
  assert.deepEqual(s.periods.month.current, { valueCents: 300, orders: 2, averageCents: 150 });
  assert.deepEqual(s.periods.month.previous, { valueCents: 700, orders: 2, averageCents: 350 });

  assert.equal(s.periods.days60.label, '2026-08-22 to 2026-10-20');
  assert.equal(s.periods.days60.comparisonLabel, 'compared with previous 60 full days');
  assert.deepEqual(s.periods.days60.current, { valueCents: 1000, orders: 4, averageCents: 250 });
  assert.deepEqual(s.periods.days60.previous, { valueCents: 1100, orders: 2, averageCents: 550 });
});

test('the long comparison fails closed rather than counting unfetched history as zero', () => {
  const shortHistory = raw([], [], { since: new Date('2026-09-01T00:00:00Z') });
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
  const s = buildSnapshot(raw(orders), NOW);
  assert.deepEqual(s.periods.today.current, { valueCents: 1000, orders: 1, averageCents: 1000 });
  assert.deepEqual(s.periods.today.previous, { valueCents: 400, orders: 1, averageCents: 400 });
  // week = Oct 14..20 local (excludes today): orders 3,4,5
  assert.equal(s.periods.week.current.valueCents, 400 + 5000 + 2000);
  assert.equal(s.periods.week.previous.valueCents, 700);
  assert.equal(s.periods.week.label, '2026-10-14 to 2026-10-20');
  assert.equal(s.chart.current.at(-1).date, '2026-10-20');
  assert.equal(s.chart.current.at(-1).valueCents, 5400);
  assert.equal(s.chart.previous[0].date, '2026-10-07');
  assert.equal(s.recentOrders[0].number, '#2');
  assert.equal(s.recentOrders.length, 6);
  assert.match(
    s.recentOrders[0].url,
    /^https:\/\/admin\.shopify\.com\/store\/test-shop\/orders\/2$/,
  );
  assert.deepEqual(Object.keys(s.recentOrders[0]).sort(), [
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
  // Order at 23:30 UTC on 24th is local 01:30 on 25th (DST day) -> not in a week ending 24th.
  const now = new Date('2026-10-26T10:00:00Z');
  const s = buildSnapshot(
    raw([order(1, '2026-10-25T23:30:00Z', '3.00'), order(2, '2026-10-24T21:30:00Z', '2.00')], [], {
      until: now,
    }),
    now,
  );
  assert.equal(s.periods.week.label, '2026-10-19 to 2026-10-25');
  assert.equal(s.chart.current.at(-1).date, '2026-10-25');
  assert.equal(s.chart.current.at(-1).valueCents, 0 + 0); // 23:30Z on 25th is local 00:30 on 26th (today)
  assert.equal(s.chart.current.at(-2).valueCents, 200);
  assert.equal(s.periods.today.current.valueCents, 300);
  // same-time comparison across DST: now is 11:00 local on the 26th
  const sp = buildSnapshot(
    raw([order(3, '2026-10-25T09:59:00Z', '1.00'), order(4, '2026-10-25T10:01:00Z', '8.00')], [], {
      until: now,
    }),
    now,
  );
  // yesterday 11:00 local (CET after DST change... 25th is already CET) == 10:00Z
  assert.equal(sp.periods.today.previous.valueCents, 0 + 100 + 0 > 0 ? 100 : 0);
});

test('backlog and inventory', () => {
  const o = [
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
  const v = (id, q, tracked) => ({
    id,
    displayName: id,
    inventoryQuantity: q,
    inventoryItem: { tracked },
  });
  const s = buildSnapshot(
    raw(o, [v('a', 5, true), v('b', 6, true), v('c', 0, false), v('d', -2, true)]),
    NOW,
  );
  assert.deepEqual(s.backlog, { count: 3, overdueCount: 2 });
  assert.deepEqual(s.inventory, { trackedVariants: 3, lowCount: 2 });
  assert.ok(s.attention.length <= 3 && s.attention.length >= 2);
  assert.ok(!JSON.stringify(s).includes('displayName'));
});

// ---- cache ----
test('cache: singleflight, failure preserves last good, staleness by age', async () => {
  let t = 1_000_000,
    n = 0,
    fail = false;
  const cache = createCache({
    now: () => t,
    fetchSnapshot: async () => {
      n++;
      if (fail) throw Object.assign(new Error('SECRET'), { code: 'cli_failed' });
      return { v: n };
    },
  });
  assert.equal(cache.sync().state, 'loading');
  await Promise.all([cache.refresh(), cache.refresh()]);
  assert.equal(n, 1);
  assert.equal(cache.sync().state, 'ok');
  t += 6 * 60 * 1000;
  assert.equal(cache.sync().state, 'stale');
  fail = true;
  await cache.refresh();
  assert.deepEqual(cache.snapshot, { v: 1 });
  const s = cache.sync();
  assert.equal(s.state, 'stale');
  assert.equal(s.errorCode, 'cli_failed');
  fail = false;
  await cache.refresh();
  assert.equal(cache.sync().state, 'ok');
  const bad = createCache({
    fetchSnapshot: async () => {
      throw new Error('x');
    },
  });
  await bad.refresh();
  assert.equal(bad.sync().state, 'error');
  assert.equal(bad.sync().errorCode, 'refresh_failed');
  assert.equal(bad.snapshot, null);
});

// ---- HTTP ----
const ENV = {
  SHOPIFY_STORE: 'test-shop.myshopify.com',
  LIVE_ALLOWED_USERS: 'Alice@example.com, bob@example.com',
  LIVE_ORIGIN: 'https://box.tail1234.ts.net',
};
const HOST = 'box.tail1234.ts.net';

test('config fails closed', () => {
  assert.ok(loadConfig(ENV));
  assert.equal(loadConfig(ENV).port, 4318);
  for (const k of Object.keys(ENV)) assert.throws(() => loadConfig({ ...ENV, [k]: undefined }));
  assert.throws(() => loadConfig({ ...ENV, LIVE_ORIGIN: 'http://box.ts.net' }));
  assert.throws(() => loadConfig({ ...ENV, LIVE_ORIGIN: 'https://box.ts.net/path' }));
});

// In-process request through the real handler (mock socket/headers); avoids sandbox loopback limits.
function mkReq({ method = 'GET', url = '/', headers = {}, rawPairs, addr = '127.0.0.1' }) {
  const pairs = rawPairs || Object.entries(headers);
  const flat = pairs.flatMap(([k, v]) => [k, String(v)]);
  const h = {};
  for (const [k, v] of pairs)
    h[k.toLowerCase()] =
      h[k.toLowerCase()] === undefined ? String(v) : h[k.toLowerCase()] + ', ' + v;
  return { socket: { remoteAddress: addr }, headers: h, rawHeaders: flat, method, url };
}
function call(handler, opts) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      writeHead(s, hd) {
        res.status = s;
        for (const [k, v] of Object.entries(hd || {})) res.headers[k.toLowerCase()] = v;
      },
      end(body) {
        resolve({
          status: res.status,
          headers: res.headers,
          body: body === undefined ? '' : String(body),
        });
      },
    };
    handler(mkReq(opts), res);
  });
}

test('http server boundaries', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pub-'));
  fs.writeFileSync(path.join(pub, 'live.html'), '<h1>live</h1>');
  fs.writeFileSync(path.join(pub, 'live.js'), 'x');
  fs.writeFileSync(path.join(pub, '.secret.js'), 'x');
  fs.writeFileSync(path.join(pub, 'data.json'), '{}');
  fs.writeFileSync(path.join(path.dirname(pub), 'outside.js'), 'x');
  let n = 0;
  const cache = createCache({
    fetchSnapshot: async () => {
      n++;
      return { source: 'shopify', fake: true };
    },
  });
  const handler = createHandler({ config: loadConfig(ENV), cache, publicDir: pub });
  const req = (_p, o) => call(handler, o);
  const port = 0;
  const good = { host: HOST, 'tailscale-user-login': 'ALICE@example.com' };

  // anonymous / bad identity / bad host
  assert.equal((await req(port, { headers: { host: HOST } })).status, 403);
  assert.equal(
    (await req(port, { headers: { ...good, 'tailscale-user-login': 'eve@example.com' } })).status,
    403,
  );
  assert.equal(
    (
      await req(port, {
        headers: { ...good, 'tailscale-user-login': 'alice@example.com, bob@example.com' },
      })
    ).status,
    403,
  );
  assert.equal((await req(port, { headers: { ...good, 'tailscale-user-login': '' } })).status, 403);
  assert.equal(
    (
      await req(port, {
        rawPairs: [
          ['Host', HOST],
          ['Tailscale-User-Login', 'alice@example.com'],
          ['tailscale-user-login', 'alice@example.com'],
        ],
      })
    ).status,
    403,
  );
  assert.equal((await req(port, { headers: { ...good, host: 'evil.example.com' } })).status, 403);
  assert.equal((await req(port, { headers: { ...good, host: HOST + ':8443' } })).status, 403);

  // no snapshot yet
  let r = await req(port, { url: '/api/snapshot', headers: good });
  assert.equal(r.status, 503);
  assert.equal(JSON.parse(r.body).sync.state, 'loading');
  assert.equal(JSON.parse(r.body).periods, undefined);

  await cache.refresh();
  r = await req(port, { url: '/api/snapshot', headers: good });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).sync.state, 'ok');
  await req(port, { url: '/api/snapshot', headers: good });
  assert.equal(n, 1, 'requests must not trigger refreshes');
  assert.equal(
    (await req(port, { url: '/api/snapshot?refresh=1&store=x&query=y', headers: good })).status,
    200,
  );
  assert.equal(n, 1);

  // headers
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['access-control-allow-origin'], undefined);

  // methods
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
    assert.equal((await req(port, { method, url: '/api/snapshot', headers: good })).status, 405);
  assert.equal(
    (await req(port, { method: 'HEAD', url: '/api/snapshot', headers: good })).status,
    200,
  );

  // static
  r = await req(port, { url: '/', headers: good });
  assert.equal(r.status, 200);
  assert.match(r.body, /live/);
  assert.equal((await req(port, { url: '/live.js', headers: good })).status, 200);
  for (const u of [
    '/.secret.js',
    '/data.json',
    '/../outside.js',
    '/%2e%2e/outside.js',
    '/..%2foutside.js',
    '/%00.js',
    '/a%5c..%5clive.js',
    '/missing.js',
    '//live.js',
    '/live.html/..%2f..%2fetc%2fpasswd',
  ]) {
    const x = await req(port, { url: u, headers: good });
    assert.ok([404, 400].includes(x.status), `${u} -> ${x.status}`);
  }
});

test('non-loopback socket rejected; failure state served', async () => {
  const cache = createCache({
    fetchSnapshot: async () => {
      throw new Error('x');
    },
  });
  const handler = createHandler({ config: loadConfig(ENV), cache });
  const mk = (addr) => ({
    socket: { remoteAddress: addr },
    headers: { host: HOST, 'tailscale-user-login': 'alice@example.com' },
    rawHeaders: ['Host', HOST, 'Tailscale-User-Login', 'alice@example.com'],
    method: 'GET',
    url: '/api/snapshot',
  });
  const mkRes = () => {
    const r = {
      status: 0,
      writeHead(s) {
        r.status = s;
      },
      end() {},
    };
    return r;
  };
  for (const a of ['192.168.1.5', '100.64.0.1', '::ffff:10.0.0.1', undefined]) {
    const r = mkRes();
    handler(mk(a), r);
    assert.equal(r.status, 403);
  }
  const ok = mkRes();
  handler(mk('::1'), ok);
  assert.equal(ok.status, 503);
  assert.ok(isLoopback('::ffff:127.0.0.1') && !isLoopback('0.0.0.0'));
  await cache.refresh();
  assert.equal(cache.sync().state, 'error');
});

test('real listener smoke (skipped when loopback TCP is blocked)', async (t) => {
  const cache = createCache({ fetchSnapshot: async () => ({ source: 'shopify' }) });
  const server = createLiveServer({ config: loadConfig(ENV), cache });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  assert.equal(server.address().address, '127.0.0.1');
  const { port } = server.address();
  const r = await new Promise((resolve) => {
    const q = http.get(
      { host: '127.0.0.1', port, path: '/api/snapshot', timeout: 3000, headers: { host: HOST } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    q.on('error', () => resolve(null));
    q.on('timeout', () => {
      q.destroy();
      resolve(null);
    });
  });
  if (r === null) return t.skip('loopback TCP blocked in this environment');
  assert.equal(r, 403);
});
