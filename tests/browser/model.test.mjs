import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_DAYS, SAMPLE_ORDERS } from '../../public/demo/demo-data.js';
import {
  escapeHtml,
  summarise,
  getPeriod,
  goalProgress,
  normaliseStore,
  percentChange,
  money,
} from '../../public/shared/model.js';

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

test('empty fixtures and zero baseline do not manufacture percentages', () => {
  assert.deepEqual(summarise([]), { revenue: 0, orders: 0, averageOrder: 0 });
  assert.equal(percentChange(100, 0), null);
  assert.equal(percentChange(50, 100), -50);
});

test('progress clamps safely and currency is denominated in cents', () => {
  assert.equal(goalProgress(10000, 200), 50);
  assert.equal(goalProgress(30000, 200), 100);
  assert.equal(goalProgress(10000, 0), 0);
  assert.equal(money(4800), '€48.00');
});

test('store field accepts only an actual myshopify hostname, not a URL', () => {
  assert.equal(normaliseStore(' Sunday-Supply.myshopify.com '), 'sunday-supply.myshopify.com');
  for (const invalid of [
    'https://shop.myshopify.com',
    'shop.com',
    'shop.myshopify.com.evil.test',
    'x/y.myshopify.com',
    '<script>.myshopify.com',
    '-shop.myshopify.com',
    '',
  ]) {
    assert.equal(normaliseStore(invalid), null);
  }
});

test('editable labels are escaped before HTML rendering', () => {
  assert.equal(
    escapeHtml('<img src="x" onerror=\'alert(1)\'>'),
    '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;',
  );
});

test('recent order examples are a subset of the final sample day', () => {
  const finalDay = SAMPLE_DAYS.at(-1);
  assert.ok(SAMPLE_ORDERS.length <= finalDay.orders);
  assert.ok(SAMPLE_ORDERS.reduce((total, order) => total + order.amount, 0) <= finalDay.revenue);
});
