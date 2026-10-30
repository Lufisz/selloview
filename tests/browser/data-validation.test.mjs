// What the browser trusts and links to: server snapshots must pass validation before they are
// drawn, and only the configured merchant's HTTPS admin pages become links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../server/metrics.mjs';
import { isUsableSnapshot } from '../../public/shared/snapshot-validation.js';
import { formatPeriodLabel } from '../../public/shared/board-model.js';
import { safeShopifyAdminUrl } from '../../public/shared/ui.js';
import { renderAttentionPanel, renderOrdersPanel } from '../../public/shared/board.js';

test('shared renderers independently restrict links to the configured Shopify merchant', () => {
  const options = { storeDomain: 'validation.myshopify.com' };
  const allowed = 'https://admin.shopify.com/store/validation/orders/1';
  const destinations = [
    allowed,
    'https://evil.example/x',
    'https://admin.shopify.com/store/other/orders/1',
  ];
  for (const href of destinations) {
    const orders = {
      title: 'Orders',
      columns: [{ label: 'Order' }],
      rows: [[{ text: '#1', href }]],
      emptyText: '',
    };
    const attention = {
      title: 'Attention',
      items: [{ title: 'Order', description: '', action: { type: 'link', href, label: 'View' } }],
      emptyText: '',
    };
    const shouldLink = href === allowed;
    assert.equal(renderOrdersPanel(orders, options).includes('<a '), shouldLink);
    assert.equal(renderAttentionPanel(attention, options).includes('<a '), shouldLink);
    assert.equal(renderOrdersPanel(orders).includes('<a '), false);
    assert.equal(renderAttentionPanel(attention).includes('<a '), false);
  }
});

function syntheticSnapshot() {
  const cutoff = new Date('2026-10-21T12:00:00Z');
  const snapshot = buildSnapshot(
    {
      shop: {
        name: 'Validation Shop',
        myshopifyDomain: 'validation.myshopify.com',
        currencyCode: 'EUR',
        ianaTimezone: 'Europe/Stockholm',
        plan: { publicDisplayName: 'Basic' },
      },
      // Matches the collector's real 130-day read window.
      since: new Date(cutoff.getTime() - 130 * 86400000),
      until: cutoff,
      orders: [],
      variants: [],
      ordersComplete: true,
      inventoryComplete: true,
    },
    cutoff,
  );
  return { ...snapshot, sync: { state: 'ok' } };
}

test('a complete synthetic server snapshot passes client validation', () => {
  assert.equal(isUsableSnapshot(syntheticSnapshot()), true);
  assert.equal(isUsableSnapshot(null), false);
});

const malformedSnapshots = [
  [
    'missing reporting label',
    (snapshot) => {
      delete snapshot.periods.week.label;
    },
  ],
  [
    'missing store timezone',
    (snapshot) => {
      delete snapshot.shop.timeZone;
    },
  ],
  [
    'invalid store domain',
    (snapshot) => {
      snapshot.shop.domain = 'unrelated.example';
    },
  ],
  [
    'invalid currency code',
    (snapshot) => {
      snapshot.shop.currency = 'eur<';
    },
  ],
  [
    'unknown time zone',
    (snapshot) => {
      snapshot.shop.timeZone = 'Mars/Base';
    },
  ],
  [
    'fractional order count',
    (snapshot) => {
      snapshot.periods.today.current.orders = 1.5;
    },
  ],
  [
    'non-finite chart value',
    (snapshot) => {
      snapshot.charts.week.current[0].valueCents = Infinity;
    },
  ],
  [
    'null chart item',
    (snapshot) => {
      snapshot.charts.week.current[0] = null;
    },
  ],
  [
    'no per-period charts',
    (snapshot) => {
      delete snapshot.charts;
    },
  ],
  [
    'a period without its chart',
    (snapshot) => {
      delete snapshot.charts.days60;
    },
  ],
  [
    'a chart with more points than its period has',
    (snapshot) => {
      snapshot.charts.week.current = new Array(8).fill({ label: 'x', valueCents: 0 });
    },
  ],
  [
    'malformed attention item',
    (snapshot) => {
      snapshot.attention = [null];
    },
  ],
  [
    'invalid recent order date',
    (snapshot) => {
      snapshot.recentOrders = [
        {
          number: '#1',
          createdAt: 'invalid',
          amountCents: 100,
          paymentStatus: 'PAID',
          fulfillmentStatus: 'FULFILLED',
        },
      ];
    },
  ],
  [
    'non-boolean completeness',
    (snapshot) => {
      snapshot.coverage.ordersComplete = 'false';
    },
  ],
  [
    'impossible backlog count',
    (snapshot) => {
      snapshot.backlog.overdueCount = 1;
    },
  ],
  [
    'unknown sync state',
    (snapshot) => {
      snapshot.sync.state = 'unknown';
    },
  ],
];
for (const [description, mutate] of malformedSnapshots) {
  test(`client rejects ${description} before rendering`, () => {
    const snapshot = syntheticSnapshot();
    mutate(snapshot);
    assert.equal(isUsableSnapshot(snapshot), false);
  });
}

test('Shopify links must belong to the configured merchant on the standard HTTPS port', () => {
  const domain = 'validation.myshopify.com';
  for (const url of [
    'https://admin.shopify.com/store/another/orders/1',
    'https://admin.shopify.com/store/validation-evil/orders/1',
    'https://admin.shopify.com:444/store/validation/orders/1',
    'https://validation.myshopify.com:444/admin/orders/1',
  ]) {
    assert.equal(safeShopifyAdminUrl(url, domain), '');
  }
  assert.equal(safeShopifyAdminUrl('https://admin.shopify.com/store/validation', ''), '');
});

test('invalid calendar labels stay escaped display text rather than throwing during formatting', () => {
  for (const label of ['2026-99-99', '2026-02-30', '2026-10-14 to 2026-99-99']) {
    assert.equal(formatPeriodLabel(label), label);
  }
});
