import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  icon,
  ICON_NAMES,
  safeShopifyAdminUrl,
  brandLink,
  actionButton,
} from '../public/shared/ui.js';
import { renderBoard, renderChart, renderChange, renderMetric } from '../public/shared/board.js';
import { money } from '../public/shared/model.js';

// All data below is synthetic.
const ATTACK = '<img src=x onerror=alert(1)>"\'';

function chartModel(overrides = {}) {
  return {
    title: 'Trend',
    ariaLabel: 'Trend chart',
    legend: ['This', 'Before'],
    current: [
      { label: 'Mon', value: 1000 },
      { label: 'Tue', value: 2500 },
    ],
    previous: [
      { label: 'Mon', value: 500 },
      { label: 'Tue', value: 700 },
    ],
    currency: 'EUR',
    axisStep: 100,
    plotStart: 62,
    dotRadius: 4,
    emptyText: 'Nothing here.',
    ...overrides,
  };
}

function boardModel(overrides = {}) {
  return {
    title: 'Shop',
    subtitle: 'Today',
    periodOptions: [
      { value: 'week', label: 'Week' },
      { value: 'today', label: 'Today' },
    ],
    selectedPeriod: 'today',
    banner: null,
    changeStyle: 'signs',
    metrics: [{ label: 'Orders', value: '3', change: { current: 3, previous: 2 } }],
    comparisonText: 'vs before',
    chart: chartModel(),
    attention: { title: 'Needs attention', emptyText: 'None.', items: [] },
    orders: null,
    status: null,
    scope: 'EUR · UTC',
    ...overrides,
  };
}

test('unknown or prototype icon names fall back to the arrow and classes are sanitised', () => {
  const arrow = icon('arrow');
  assert.equal(icon('constructor').includes('M4 12h16m-6-6 6 6-6 6'), true);
  assert.equal(icon('__proto__').includes('undefined'), false);
  assert.equal(icon('"><script>').includes('<script>'), false);
  assert.equal(arrow.includes('undefined'), false);
  assert.equal(icon('check', '"><b>').includes('<b>'), false);
  for (const name of ICON_NAMES) assert.match(icon(name), /<path|<rect|<circle/);
});

test('only https Shopify admin URLs for the configured store are linkable', () => {
  const store = 'synthetic.myshopify.com';
  assert.equal(
    safeShopifyAdminUrl('https://synthetic.myshopify.com/admin/orders/1', store),
    'https://synthetic.myshopify.com/admin/orders/1',
  );
  assert.equal(
    safeShopifyAdminUrl('https://admin.shopify.com/store/synthetic/orders/1', store).startsWith(
      'https://admin.shopify.com/',
    ),
    true,
  );
  for (const bad of [
    'javascript:alert(1)',
    'http://synthetic.myshopify.com/admin',
    'https://evil.example/admin',
    'https://synthetic.myshopify.com.evil.example/admin',
    'https://user:pw@synthetic.myshopify.com/admin',
    'https://synthetic.myshopify.com/not-admin',
    'not a url',
    '',
  ]) {
    assert.equal(safeShopifyAdminUrl(bad, store), '', bad);
  }
});

test('shared templates escape text, attributes and numbers from view models', () => {
  const html = renderBoard(
    boardModel({
      title: ATTACK,
      subtitle: ATTACK,
      scope: ATTACK,
      comparisonText: ATTACK,
      banner: { title: ATTACK, message: ATTACK },
      metrics: [{ label: ATTACK, value: ATTACK, note: ATTACK }],
      attention: {
        title: ATTACK,
        emptyText: ATTACK,
        items: [
          {
            title: ATTACK,
            description: ATTACK,
            tone: ATTACK,
            action: { type: 'button', action: ATTACK, id: ATTACK, label: ATTACK },
          },
        ],
      },
      orders: {
        title: ATTACK,
        note: ATTACK,
        emptyText: ATTACK,
        columns: [{ label: ATTACK }],
        rows: [[{ text: ATTACK, kind: ATTACK, href: `https://x.example/?a="${ATTACK}` }]],
      },
      status: { tone: ATTACK, text: ATTACK },
      chart: chartModel({
        ariaLabel: ATTACK,
        legend: [ATTACK, ATTACK],
        current: [{ label: ATTACK, value: 1 }],
        previous: [],
      }),
    }),
  );
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(/["']\s*onerror=/.test(html), false, 'attribute break-out');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('unsafe link schemes are not rendered in attention items or order cells', () => {
  const html = renderBoard(
    boardModel({
      attention: {
        title: 'A',
        emptyText: '',
        items: [
          {
            title: 'T',
            description: 'D',
            action: { type: 'link', href: 'javascript:alert(1)', label: 'Go' },
          },
        ],
      },
      orders: {
        title: 'O',
        emptyText: '',
        columns: [{ label: 'Order' }],
        rows: [[{ text: '#1', kind: 'id', href: 'javascript:alert(1)' }]],
      },
    }),
  );
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('<a href'), false);
});

test('attention buttons are hidden in TV and preview modes', () => {
  const model = boardModel({
    attention: {
      title: 'A',
      emptyText: '',
      items: [
        {
          title: 'T',
          description: 'D',
          action: { type: 'button', action: 'attention', id: 'x', label: 'Open' },
        },
      ],
    },
  });
  assert.match(renderBoard(model), /data-action="attention" data-id="x"/);
  assert.equal(renderBoard(model, { tv: true }).includes('data-action="attention"'), false);
  assert.equal(renderBoard(model, { preview: true }).includes('data-action="attention"'), false);
});

test('chart survives empty, zero and non-finite data without NaN or Infinity', () => {
  const zero = renderChart(
    chartModel({
      current: [
        { label: 'A', value: 0 },
        { label: 'B', value: 0 },
      ],
      previous: [],
    }),
  );
  const broken = renderChart(
    chartModel({
      current: [{ label: 'A', value: NaN }],
      previous: [{ label: 'A', value: Infinity }],
    }),
  );
  for (const svg of [zero, broken]) {
    assert.equal(/NaN|Infinity|undefined/.test(svg), false);
    assert.match(svg, /<svg/);
  }
  assert.match(renderChart(chartModel({ current: [] })), /Nothing here\./);
});

test('chart axis labels are never duplicated by rounding', () => {
  const svg = renderChart(
    chartModel({ current: [{ label: 'A', value: 0 }], previous: [], axisStep: 100 }),
  );
  const ticks = [...svg.matchAll(/<text x="0"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  assert.equal(ticks.length, 3);
  assert.equal(new Set(ticks).size, 3, ticks.join(' | '));
});

test('change badge supports both styles, escapes srText and handles a zero baseline', () => {
  assert.match(renderChange({ current: 110, previous: 100 }, 'signs'), /\+10\.0%/);
  assert.match(renderChange({ current: 90, previous: 100 }, 'signs'), /−10\.0%/);
  assert.match(renderChange({ current: 110, previous: 100 }, 'arrows'), /↗ 10\.0%/);
  assert.match(renderChange({ current: 5, previous: 0 }), /No previous baseline/);
  assert.equal(renderChange({ current: 1, previous: 2, srText: ATTACK }).includes('<img'), false);
});

test('goal metric clamps its width and help buttons are hidden in preview', () => {
  const goal = renderMetric({ kind: 'goal', label: 'Goal', percent: 9999, target: 'of x' });
  assert.match(goal, /width:100%/);
  assert.match(renderMetric({ kind: 'goal', label: 'Goal', percent: NaN, target: '' }), /width:0%/);
  const metric = { label: 'Sales', value: '1', help: { action: 'help', label: 'Why' } };
  assert.match(renderMetric(metric), /help-button/);
  assert.equal(renderMetric(metric, { preview: true }).includes('help-button'), false);
});

test('currency and time zone are explicit inputs to formatters', () => {
  assert.match(money(12345, false, 'EUR'), /€123\.45/);
  assert.notEqual(money(12345, false, 'SEK'), money(12345, false, 'EUR'));
  assert.equal(money(12300, true, 'EUR'), '€123');
});

test('shared primitives escape their inputs', () => {
  assert.equal(brandLink({ href: ATTACK, label: ATTACK }).includes('<img src=x'), false);
  assert.equal(
    actionButton({ action: ATTACK, label: ATTACK, data: { id: ATTACK } }).includes('<img'),
    false,
  );
  assert.match(actionButton({ action: 'a', label: 'b' }), /type="button"/);
});

test('shared modules do not import fixtures or fetch data', async () => {
  for (const file of ['ui.js', 'board.js', 'model.js']) {
    const source = await readFile(new URL(`../public/shared/${file}`, import.meta.url), 'utf8');
    assert.equal(
      /from\s+['"][^'"]*demo-data\.js['"]/.test(source),
      false,
      `${file} imports fixtures`,
    );
    assert.equal(
      /\bfetch\s*\(|XMLHttpRequest|localStorage/.test(source),
      false,
      `${file} touches network or storage`,
    );
  }
});
