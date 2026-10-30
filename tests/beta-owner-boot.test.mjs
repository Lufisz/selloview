// Runs the real owner-page controller (public/owner/owner.js) against a fake page and SYNTHETIC server
// answers. No browser is available here, so this catches controller wiring mistakes (imports,
// state, polling, redirect handling) but is not a substitute for a real browser check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildSnapshot } from '../server/metrics.mjs';

const STORE = 'synthetic-boot.myshopify.com';
const REQUEST_TIMEOUT_MS = 12000;

function syntheticSnapshot() {
  const now = new Date();
  const hour = 3600 * 1000;
  const orders = [1, 2, 3].map((index) => ({
    id: `gid://shopify/Order/${index}`,
    name: `#${7000 + index}`,
    createdAt: new Date(now.getTime() - index * 30 * hour).toISOString(),
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '12.00', currencyCode: 'EUR' } },
  }));
  const snapshot = buildSnapshot(
    {
      shop: {
        name: 'Synthetic Boot Shop',
        myshopifyDomain: STORE,
        currencyCode: 'EUR',
        ianaTimezone: 'Europe/Stockholm',
        plan: null,
      },
      since: new Date(now.getTime() - 130 * 24 * hour),
      until: now,
      orders,
      ordersComplete: true,
      variants: [],
      inventoryComplete: true,
    },
    now,
  );
  return {
    ...snapshot,
    sync: {
      state: 'ok',
      lastSuccessAt: now.toISOString(),
      lastAttemptAt: now.toISOString(),
      errorCode: null,
    },
  };
}

function runOwnerPage({ search = '', connection, snapshot = null, statusCode = 200 }) {
  const controllerUrl = new URL('../public/owner/owner.js', import.meta.url).href;
  const session = {
    owner: { email: 'owner@example.test' },
    sessionExpiresAt: '2099-01-01T00:00:00.000Z',
    workspace: { name: 'My MetricTV', revision: 0, settings: { period: 'week', theme: 'light' } },
    storeConnection: connection,
    csrfToken: 'owner-csrf-token',
  };
  const script = `
    const listeners = {};
    const app = {
      innerHTML: '',
      addEventListener: (type, handler) => { listeners[type] = handler; },
      querySelector: () => null,
      contains: () => false,
    };
    const requests = [];
    const replaced = [];
    const failures = [];
    globalThis.document = {
      querySelector: () => app,
      body: { dataset: {}, classList: { toggle: () => {} } },
      activeElement: null,
    };
    globalThis.window = {
      location: { search: ${JSON.stringify(search)}, hash: '', pathname: '/', origin: 'https://beta.example.test', assign: () => {} },
      history: { replaceState: (state, title, url) => replaced.push(url) },
    };
    const timers = [];
    globalThis.setTimeout = (fn, delay) => { timers.push(delay); return timers.length; };
    globalThis.clearTimeout = () => {};
    const answers = {
      '/api/beta/session': { status: 200, body: ${JSON.stringify(session)} },
      '/api/beta/screens': { status: 200, body: { screens: [] } },
      '/api/beta/shopify': { status: ${statusCode}, body: ${JSON.stringify({ connection: { store: STORE, canConnect: true, ...connection }, snapshot })} },
    };
    globalThis.fetch = async (url) => {
      requests.push(url);
      const answer = answers[url];
      return { status: answer.status, ok: answer.status < 300, json: async () => answer.body };
    };
    process.on('unhandledRejection', (error) => failures.push(error.message));
    await import(${JSON.stringify(controllerUrl)});
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    console.log(JSON.stringify({ html: app.innerHTML, failures, requests, replaced, timers, theme: document.body.dataset.theme }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 8000,
    }),
  );
  // Every request arms a 12 s abort timer; what remains are the page's own polling timers.
  result.timers = result.timers.filter((delay) => delay !== REQUEST_TIMEOUT_MS);
  return result;
}

test('a connected owner sees the board, the return notice, and the page keeps polling', () => {
  const result = runOwnerPage({
    search: '?shopify=connected',
    connection: { state: 'connected', sync: { state: 'ok' } },
    snapshot: syntheticSnapshot(),
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.requests, [
    '/api/beta/session',
    '/api/beta/screens',
    '/api/beta/shopify',
  ]);
  assert.deepEqual(result.replaced, ['/'], 'the result is removed from the address bar');
  assert.match(result.html, /Synthetic Boot Shop/);
  assert.match(result.html, /Order value/);
  assert.match(result.html, /approved the connection/);
  assert.match(result.html, /data-action="disconnect-shopify-ask"/);
  assert.deepEqual(result.timers, [30000], 'figures refresh by themselves');
  assert.doesNotMatch(result.html, /owner-csrf-token/);
});

test('an unconnected owner sees the connect form and no figures or polling', () => {
  const result = runOwnerPage({ connection: { state: 'not_connected' } });
  assert.deepEqual(result.failures, []);
  assert.match(result.html, /data-form="connect-shopify"/);
  assert.match(result.html, new RegExp(`value="${STORE}"`));
  assert.doesNotMatch(result.html, /Order value|class="board-heading"/);
  assert.deepEqual(result.timers, []);
});

test('a failed return from Shopify is shown as a failure and changes nothing else', () => {
  const result = runOwnerPage({
    search: '?shopify=failed',
    connection: { state: 'not_connected' },
  });
  assert.match(result.html, /did not finish/);
  assert.match(result.html, /data-form="connect-shopify"/);
});

test('a first sync still running polls quickly and promises no figures', () => {
  const result = runOwnerPage({ connection: { state: 'connected', sync: { state: 'loading' } } });
  assert.match(result.html, /first read from Shopify is running/);
  assert.doesNotMatch(result.html, /Order value/);
  assert.deepEqual(result.timers, [5000]);
});

test('a store status that cannot load is an honest error with a retry, not an empty page', () => {
  const result = runOwnerPage({ connection: { state: 'not_connected' }, statusCode: 500 });
  assert.match(result.html, /Something went wrong|Could not/);
  assert.match(result.html, /data-action="refresh-store"/);
});
