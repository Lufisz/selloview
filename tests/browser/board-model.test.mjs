import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveBoardModel,
  buildSyncWarning,
  formatPeriodLabel,
  humanizeStatus,
  LIVE_PERIOD_OPTIONS,
  normalizePeriod,
} from '../../public/live-board-model.js';

// Synthetic snapshot, never real store data.
const NOW = Date.parse('2026-10-21T12:00:00Z');
const SHOP_DOMAIN = 'synthetic.myshopify.com';

function snapshotFixture(overrides = {}) {
  const totals = { valueCents: 5000, orders: 2, averageCents: 2500 };
  const period = (label) => ({
    label,
    comparisonLabel: 'compared with before',
    current: totals,
    previous: { valueCents: 0, orders: 0, averageCents: 0 },
  });
  const series = {
    current: [{ label: 'Mon', valueCents: 1000 }],
    previous: [{ label: 'Mon', valueCents: 0 }],
  };
  return {
    source: 'shopify',
    fetchedAt: '2026-10-21T11:59:00Z',
    shop: {
      name: 'Synthetic',
      domain: SHOP_DOMAIN,
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
    chart: series,
    charts: { days60: series, month: series, week: series, today: series },
    backlog: { count: 1, overdueCount: 0 },
    attention: [
      { title: 'Low', description: 'd', url: 'https://evil.example/admin' },
      { title: 'Ok', description: 'd', url: `https://${SHOP_DOMAIN}/admin/products/1` },
    ],
    recentOrders: [
      {
        number: '#1',
        createdAt: '2026-10-21T10:00:00Z',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'FULFILLED',
        amountCents: 5000,
        url: `https://${SHOP_DOMAIN}/admin/orders/1`,
      },
    ],
    metricDefinition: 'Order value definition.',
    ...overrides,
  };
}

const boardInput = (overrides = {}) => ({
  snapshot: snapshotFixture(),
  unavailableMessage: '',
  period: 'week',
  now: NOW,
  ...overrides,
});

test('the board model keeps order-value wording, snapshot currency and restricted links', () => {
  const model = buildLiveBoardModel(boardInput());
  assert.equal(model.metrics[0].label, 'Order value');
  assert.match(model.metrics[0].value, /50[,.]00/);
  assert.equal(model.chart.axisStep, 100);
  assert.equal(model.scope, 'SEK · Europe/Stockholm');
  assert.equal(model.subtitle, '14 Oct to 20 Oct 2026');

  const [hostile, ownShop] = model.attention.items;
  assert.equal(hostile.action, undefined, 'a link to another site is not offered');
  assert.equal(ownShop.action.href, `https://${SHOP_DOMAIN}/admin/products/1`);
  assert.equal(model.orders.rows[0][0].href, `https://${SHOP_DOMAIN}/admin/orders/1`);
});

test('the TV model drops the payment column from the latest orders', () => {
  const owner = buildLiveBoardModel(boardInput());
  const tv = buildLiveBoardModel(boardInput({ compact: true }));
  assert.deepEqual(
    owner.orders.columns.map((column) => column.label),
    ['Order', 'Placed', 'Payment', 'Fulfillment', 'Value'],
  );
  assert.deepEqual(
    tv.orders.columns.map((column) => column.label),
    ['Order', 'Placed', 'Status', 'Value'],
  );
  assert.equal(tv.orders.rows[0].length, tv.orders.columns.length);
});

test('the chart adapts title, legend, dot radius and series to the selected period', () => {
  const chartOf = (period) => buildLiveBoardModel(boardInput({ period })).chart;

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

test('stale, interrupted and incomplete data are labelled, never hidden', () => {
  const fresh = snapshotFixture();
  assert.equal(buildSyncWarning(fresh, '', NOW), '');
  assert.match(buildSyncWarning(fresh, 'x', NOW), /last successful figures/);
  assert.match(buildSyncWarning(fresh, '', NOW + 600000), /last successful figures/);
  assert.match(
    buildSyncWarning(
      snapshotFixture({ coverage: { ...fresh.coverage, ordersComplete: false } }),
      '',
      NOW,
    ),
    /incomplete/,
  );
  assert.match(
    buildSyncWarning(snapshotFixture({ fetchedAt: 'garbage' }), '', NOW),
    /last successful/,
  );

  const staleModel = buildLiveBoardModel(boardInput({ now: NOW + 600000 }));
  assert.equal(staleModel.status.tone, 'amber');
  assert.match(staleModel.status.text, /^Last snapshot /);
  assert.equal(staleModel.banner.message, buildSyncWarning(fresh, '', NOW + 600000));
  assert.match(buildLiveBoardModel(boardInput()).status.text, /^Updated /);
  assert.equal(
    buildLiveBoardModel(boardInput({ unavailableMessage: 'offline' })).status.text,
    'Connection interrupted',
  );
});

test('label helpers', () => {
  assert.equal(humanizeStatus('PARTIALLY_PAID'), 'Partially paid');
  assert.equal(formatPeriodLabel('2026-10-14 to 2026-10-20'), '14 Oct to 20 Oct 2026');
  assert.equal(formatPeriodLabel('weird'), 'weird');
  for (const label of ['2026-99-99', '2026-02-30', '2026-10-14 to 2026-99-99']) {
    assert.equal(formatPeriodLabel(label), label, 'an impossible date is shown unchanged');
  }
});

test('an unknown period falls back to the 7-day view', () => {
  for (const option of LIVE_PERIOD_OPTIONS) {
    assert.equal(normalizePeriod(option.value), option.value);
  }
  for (const unknown of ['', 'year', undefined, null, 7, '__proto__']) {
    assert.equal(normalizePeriod(unknown), 'week', String(unknown));
  }
});
