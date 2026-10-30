import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, normaliseStore, percentChange, money } from '../../public/shared/format.js';

test('a zero baseline does not manufacture a percentage', () => {
  assert.equal(percentChange(100, 0), null);
  assert.equal(percentChange(50, 100), -50);
});

test('currency is denominated in cents', () => {
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
