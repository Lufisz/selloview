import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SAMPLE_DAYS, SAMPLE_ORDERS, ATTENTION_ITEMS, DEFAULT_SETTINGS } from '../public/data.js';
import {
  buildDemoBoardModel,
  renderHome,
  renderSetup,
  renderDashboard,
  renderSettings,
  renderConnections,
} from '../public/demo-view.js';
import {
  buildLiveBoardModel,
  renderLivePage,
  buildSyncWarning,
  formatPeriodLabel,
  humanizeStatus,
} from '../public/live-view.js';
import { fetchSnapshot, isUsableSnapshot, MESSAGES } from '../public/live-client.js';

const demoState = {
  data: { days: SAMPLE_DAYS, orders: SAMPLE_ORDERS, attention: ATTENTION_ITEMS },
  settings: { ...DEFAULT_SETTINGS },
  period: 'week',
  connectionError: false,
};

// Synthetic live snapshot, never real store data.
const NOW = Date.parse('2026-10-21T12:00:00Z');
function liveSnapshot(overrides = {}) {
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
      domain: 'synthetic.myshopify.com',
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
    attention: [
      { title: 'Low', description: 'd', url: 'https://evil.example/admin' },
      { title: 'Ok', description: 'd', url: 'https://synthetic.myshopify.com/admin/products/1' },
    ],
    recentOrders: [
      {
        number: '#1',
        createdAt: '2026-10-21T10:00:00Z',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'FULFILLED',
        amountCents: 5000,
        url: 'https://synthetic.myshopify.com/admin/orders/1',
      },
    ],
    metricDefinition: 'Order value definition.',
    ...overrides,
  };
}
const liveState = (overrides = {}) => ({
  snapshot: liveSnapshot(),
  unavailableMessage: '',
  period: 'week',
  theme: 'light',
  route: 'dashboard',
  now: NOW,
  ...overrides,
});

test('demo model keeps net-sales wording and EUR sample totals', () => {
  const model = buildDemoBoardModel(demoState);
  assert.equal(model.metrics[0].label, 'Net sales');
  assert.equal(model.metrics[0].value, '€4,151.00');
  assert.equal(model.chart.axisStep, 20000);
  assert.equal(buildDemoBoardModel({ ...demoState, period: 'today' }).metrics[0].value, '€782.00');
});

test('demo pages render readable multi-line markup with expected selectors', () => {
  const pages = [
    renderHome(demoState),
    renderSetup({ step: 1, storeText: '', settings: demoState.settings }),
    renderDashboard(demoState),
    renderConnections(demoState),
    renderSettings(demoState),
  ];
  for (const html of pages) {
    const longest = Math.max(
      ...html
        .split('\n')
        .filter((line) => !/^\s*<poly/.test(line))
        .map((line) => line.length),
    );
    assert.ok(longest < 700, `line of ${longest} characters`);
  }
  assert.match(renderDashboard(demoState), /id="period"/);
  assert.match(renderSettings(demoState), /id="settings-name"/);
  assert.match(
    renderSetup({ step: 2, storeText: 'x.myshopify.com', settings: demoState.settings }),
    /data-action="approve"/,
  );
  assert.match(renderDashboard({ ...demoState, tv: true }), /class="tv-shell/);
});

test('demo escapes the editable business name and store text', () => {
  const settings = { ...demoState.settings, name: 'Studio <test>', store: '"><x>' };
  assert.equal(renderDashboard({ ...demoState, settings }).includes('<test>'), false);
  assert.equal(renderSetup({ step: 1, storeText: '"><b>', settings }).includes('"><b>'), false);
  assert.equal(renderConnections({ settings }).includes('"><x>'), false);
});

test('live model keeps order-value wording, snapshot currency and restricted links', () => {
  const model = buildLiveBoardModel(liveState());
  assert.equal(model.metrics[0].label, 'Order value');
  assert.match(model.metrics[0].value, /50[,.]00/);
  assert.equal(model.chart.axisStep, 100);
  const html = renderLivePage(liveState());
  assert.equal(html.includes('evil.example'), false);
  assert.match(html, /href="https:\/\/synthetic\.myshopify\.com\/admin\/orders\/1"/);
  assert.match(html, /SEK · Europe\/Stockholm/);
});

test('chart adapts title, legend, dot radius and series to selected period', () => {
  const chartOf = (period) => buildLiveBoardModel(liveState({ period })).chart;

  const week = chartOf('week');
  assert.equal(week.title, 'Daily order value');
  assert.deepEqual(week.legend, ['Last 7 full days', 'Previous 7']);
  assert.equal(week.dotRadius, 4);

  const month = chartOf('month');
  assert.equal(month.title, 'Daily order value (30 days)');
  assert.deepEqual(month.legend, ['Last 30 full days', 'Previous 30']);
  assert.equal(month.dotRadius, 0);

  const days60 = chartOf('days60');
  assert.equal(days60.title, 'Daily order value (60 days)');
  assert.deepEqual(days60.legend, ['Last 60 full days', 'Previous 60']);
  assert.equal(days60.dotRadius, 0);

  const today = chartOf('today');
  assert.equal(today.title, 'Hourly order value');
  assert.deepEqual(today.legend, ['Today', 'Yesterday']);
  assert.equal(today.dotRadius, 3);
});

test('live view escapes hostile snapshot text', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const snapshot = liveSnapshot({
    shop: { ...liveSnapshot().shop, name: hostile, domain: hostile, plan: hostile },
    metricDefinition: hostile,
  });
  for (const route of ['dashboard', 'connections', 'tv']) {
    assert.equal(
      renderLivePage(liveState({ snapshot, route })).includes('<img src=x'),
      false,
      route,
    );
  }
});

test('stale, interrupted and incomplete data are labelled, never hidden', () => {
  const fresh = liveSnapshot();
  assert.equal(buildSyncWarning(fresh, '', NOW), '');
  assert.match(buildSyncWarning(fresh, 'x', NOW), /last successful figures/);
  assert.match(buildSyncWarning(fresh, '', NOW + 600000), /last successful figures/);
  assert.match(
    buildSyncWarning(
      liveSnapshot({ coverage: { ...fresh.coverage, ordersComplete: false } }),
      '',
      NOW,
    ),
    /incomplete/,
  );
  assert.match(
    buildSyncWarning(liveSnapshot({ fetchedAt: 'garbage' }), '', NOW),
    /last successful/,
  );
});

test('waiting page shows no figures and no sample data', () => {
  const html = renderLivePage(
    liveState({ snapshot: null, unavailableMessage: MESSAGES.unauthorized }),
  );
  assert.equal(html.includes('metric-value'), false);
  assert.match(html, /Store data is unavailable/);
  assert.match(renderLivePage(liveState({ snapshot: null })), /Connecting to your store/);
});

test('live label helpers', () => {
  assert.equal(humanizeStatus('PARTIALLY_PAID'), 'Partially paid');
  assert.equal(formatPeriodLabel('2026-10-14 to 2026-10-20'), '14 Oct to 20 Oct 2026');
  assert.equal(formatPeriodLabel('weird'), 'weird');
});

test('client returns fixed messages and never raw errors', async () => {
  const respond = (status, body) => async () => ({
    status,
    ok: status < 400,
    json: async () => {
      if (body === undefined) throw new SyntaxError('secret parser detail');
      return body;
    },
  });
  assert.equal((await fetchSnapshot({ fetchImpl: respond(200, liveSnapshot()) })).status, 'ok');
  assert.deepEqual(await fetchSnapshot({ fetchImpl: respond(403, {}) }), {
    status: 'unauthorized',
    message: MESSAGES.unauthorized,
  });
  assert.equal((await fetchSnapshot({ fetchImpl: respond(401, {}) })).status, 'unauthorized');
  assert.equal(
    (await fetchSnapshot({ fetchImpl: respond(503, { sync: { state: 'loading' } }) })).status,
    'syncing',
  );
  assert.equal(
    (await fetchSnapshot({ fetchImpl: respond(500, { sync: { state: 'error' } }) })).message,
    MESSAGES.error,
  );
  const malformed = await fetchSnapshot({ fetchImpl: respond(200, undefined) });
  assert.equal(malformed.message, MESSAGES.malformed);
  const offline = await fetchSnapshot({
    fetchImpl: async () => {
      throw new TypeError('private host detail');
    },
  });
  assert.deepEqual(offline, { status: 'offline', message: MESSAGES.offline });
  assert.equal(
    (await fetchSnapshot({ fetchImpl: respond(200, { source: 'shopify' }) })).status,
    'error',
  );
});

test('client only requests the same-origin snapshot path', async () => {
  let requested;
  await fetchSnapshot({
    fetchImpl: async (url, options) => {
      requested = { url, options };
      throw new TypeError('x');
    },
  });
  assert.equal(requested.url, '/api/snapshot');
  assert.equal(requested.options.cache, 'no-store');
  assert.ok(requested.options.signal);
});

test('snapshot validation rejects bad currency and time zones', () => {
  assert.equal(isUsableSnapshot(liveSnapshot()), true);
  assert.equal(
    isUsableSnapshot(liveSnapshot({ shop: { ...liveSnapshot().shop, currency: 'eur<' } })),
    false,
  );
  assert.equal(
    isUsableSnapshot(liveSnapshot({ shop: { ...liveSnapshot().shop, timeZone: 'Mars/Base' } })),
    false,
  );
  assert.equal(isUsableSnapshot(null), false);
});

test('demo and live entry modules stay separated', async () => {
  const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
  for (const file of ['live.js', 'live-view.js', 'live-client.js']) {
    assert.equal(
      /from\s+['"]\.\/(data|app|demo-view)\.js['"]/.test(await read(file)),
      false,
      `${file} imports demo code`,
    );
  }
  for (const file of ['app.js', 'demo-view.js']) {
    const source = await read(file);
    assert.equal(
      /live-client|live-view|\/api\/|fetch\s*\(/.test(source),
      false,
      `${file} references live code`,
    );
  }
  assert.equal(/localStorage\.setItem\([^)]*snapshot/.test(await read('live.js')), false);
});
