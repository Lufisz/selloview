import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_DAYS,
  SAMPLE_ORDERS,
  ATTENTION_ITEMS,
  DEFAULT_SETTINGS,
} from '../../public/demo/demo-data.js';
import {
  buildDemoBoardModel,
  getPeriod,
  goalProgress,
  summarise,
} from '../../public/demo/demo-board.js';

const demoState = {
  data: { days: SAMPLE_DAYS, orders: SAMPLE_ORDERS, attention: ATTENTION_ITEMS },
  settings: { ...DEFAULT_SETTINGS },
  period: 'week',
  connectionError: false,
};

test('demo model keeps net-sales wording and EUR sample totals', () => {
  const model = buildDemoBoardModel(demoState);
  assert.equal(model.metrics[0].label, 'Net sales');
  assert.equal(model.metrics[0].value, '€4,151.00');
  assert.equal(model.chart.axisStep, 20000);
  assert.equal(buildDemoBoardModel({ ...demoState, period: 'today' }).metrics[0].value, '€782.00');
});

test('weekly metrics use the correct non-overlapping seven-day windows', () => {
  const result = getPeriod(SAMPLE_DAYS, 'week');
  assert.equal(result.currentDays.length, 7);
  assert.equal(result.previousDays.length, 7);
  assert.deepEqual(result.currentDays, SAMPLE_DAYS.slice(7));
  assert.deepEqual(result.previousDays, SAMPLE_DAYS.slice(0, 7));
  assert.equal(result.current.revenue, 415100);
  assert.equal(result.current.orders, 101);
  assert.equal(result.previous.revenue, 324100);
  assert.equal(result.previous.orders, 82);
  assert.equal(result.current.averageOrder, result.current.revenue / result.current.orders);
});

test('sample day compares the final two complete fixture days', () => {
  const { current, previous } = getPeriod(SAMPLE_DAYS, 'today');
  assert.equal(current.revenue, 78200);
  assert.equal(previous.revenue, 66400);
  assert.equal(current.orders, 19);
});

test('a previewed connection issue shows the banner and a cached-sample status', () => {
  const model = buildDemoBoardModel({ ...demoState, connectionError: true });
  assert.equal(model.banner.action.name, 'restore');
  assert.equal(model.status.text, 'Cached sample · Offline');
  assert.equal(buildDemoBoardModel(demoState).banner, null);
});

test('an empty list of days sums to zero', () => {
  assert.deepEqual(summarise([]), { revenue: 0, orders: 0, averageOrder: 0 });
});

test('goal progress clamps to 0 to 100 percent', () => {
  assert.equal(goalProgress(10000, 200), 50);
  assert.equal(goalProgress(30000, 200), 100);
  assert.equal(goalProgress(10000, 0), 0);
});

test('recent order examples are a subset of the final sample day', () => {
  const finalDay = SAMPLE_DAYS.at(-1);
  assert.ok(SAMPLE_ORDERS.length <= finalDay.orders);
  assert.ok(SAMPLE_ORDERS.reduce((total, order) => total + order.amount, 0) <= finalDay.revenue);
});
