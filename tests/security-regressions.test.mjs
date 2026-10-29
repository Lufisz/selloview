import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot } from '../server/metrics.mjs';
import { createSecurityHeaders, findPublicFile } from '../server/static-files.mjs';
import { isUsableSnapshot, fetchSnapshot, MESSAGES } from '../public/live-client.js';
import { formatPeriodLabel } from '../public/live-view.js';
import { safeShopifyAdminUrl } from '../public/ui.js';
import { renderAttentionPanel, renderOrdersPanel } from '../public/board.js';

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
    'fractional order count',
    (snapshot) => {
      snapshot.periods.today.current.orders = 1.5;
    },
  ],
  [
    'non-finite chart value',
    (snapshot) => {
      snapshot.chart.current[0].valueCents = Infinity;
    },
  ],
  [
    'null chart item',
    (snapshot) => {
      snapshot.chart.current[0] = null;
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

test('malformed snapshot responses expose no metrics or raw upstream details', async () => {
  const snapshot = syntheticSnapshot();
  snapshot.recentOrders = [null];
  snapshot.error = 'untrusted upstream detail';
  const outcome = await fetchSnapshot({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => snapshot,
    }),
  });
  assert.deepEqual(outcome, { status: 'error', message: MESSAGES.error });
});

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

test('symlinks cannot disguise hidden files, forbidden types or blocked entry points', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'stillboard-alias-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDirectory = join(directory, 'public');
  await mkdir(publicDirectory);
  for (const name of ['.hidden-source.js', 'private.txt', 'live.html', 'styles.css']) {
    await writeFile(join(publicDirectory, name), 'Synthetic test fixture only.');
  }
  const options = { indexFile: 'index.html', blockedPaths: new Set(['/live.html']) };
  const hiddenTargets = [
    ['hidden-alias.js', '.hidden-source.js'],
    ['type-alias.js', 'private.txt'],
    ['entry-alias.js', 'live.html'],
  ];
  for (const [alias, target] of hiddenTargets) {
    await symlink(target, join(publicDirectory, alias));
    assert.equal(await findPublicFile(publicDirectory, '/' + alias, options), null);
  }
  await symlink('styles.css', join(publicDirectory, 'styles-alias.css'));
  const safeFile = await findPublicFile(publicDirectory, '/styles-alias.css', options);
  assert.equal(safeFile.contentType, 'text/css; charset=utf-8');
});

test('both servers reuse security headers while retaining distinct network permissions', () => {
  const demo = createSecurityHeaders();
  const live = createSecurityHeaders({ allowApiRequests: true });
  assert.match(demo['Content-Security-Policy'], /connect-src 'none'/);
  assert.match(live['Content-Security-Policy'], /connect-src 'self'/);
  for (const headers of [demo, live]) {
    assert.match(headers['Content-Security-Policy'], /form-action 'none'/);
    assert.equal(headers['Referrer-Policy'], 'no-referrer');
    assert.equal(headers['Cache-Control'], 'no-store');
  }
});
