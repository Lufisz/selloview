// Run the actual TV controller with synthetic HTTP responses and an older-browser API surface.
// This catches startup failures that isolated renderer and API tests cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot } from '../server/metrics.mjs';
import { projectBoardForDisplay } from '../server/beta/display-board.mjs';

const PUBLIC_DIRECTORY = new URL('../public/', import.meta.url).pathname;

// A display answer built from SYNTHETIC orders through the real snapshot and projection code.
function syntheticDisplayWithBoard() {
  const now = new Date();
  const hour = 3600 * 1000;
  const orders = [1, 2, 3, 4].map((index) => ({
    id: `gid://shopify/Order/${index}`,
    name: `#${5000 + index}`,
    createdAt: new Date(now.getTime() - index * 26 * hour).toISOString(),
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: index % 2 === 0 ? 'FULFILLED' : 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: `${10 + index}.00`, currencyCode: 'EUR' } },
  }));
  const snapshot = buildSnapshot(
    {
      shop: {
        name: 'Synthetic Compat Shop',
        myshopifyDomain: 'synthetic-compat.myshopify.com',
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
  const sync = { state: 'ok', lastSuccessAt: now.toISOString() };
  return {
    screen: { name: 'Compat TV' },
    revision: 1,
    serverTime: now.toISOString(),
    settings: { period: 'week', theme: 'dark' },
    storeConnection: { state: 'connected', sync: { state: 'ok', errorCode: null } },
    board: projectBoardForDisplay(snapshot, sync),
  };
}

function runTvStartup({ offline = false, display = null } = {}) {
  const controllerUrl = new URL('../public/tv.js', import.meta.url).href;
  const script = `
    const app = { innerHTML: '' };
    const failures = [];
    const requests = [];
    globalThis.document = {
      querySelector: () => app,
      body: { dataset: {} },
    };
    Object.hasOwn = undefined;
    String.prototype.replaceAll = undefined;
    AbortSignal.timeout = undefined;
    const display = ${JSON.stringify(display)};
    globalThis.setTimeout = () => 1;
    globalThis.clearTimeout = () => {};
    globalThis.fetch = async (url) => {
      requests.push(url);
      if (${JSON.stringify(offline)}) throw new Error('synthetic network failure');
      if (display && url === '/api/display') {
        return { status: 200, ok: true, json: async () => display };
      }
      const status = url === '/api/display' ? 401 : 201;
      return {
        status,
        ok: status === 201,
        json: async () => status === 401
          ? { error: 'unauthenticated' }
          : { code: 'ABCD-EFGH' },
      };
    };
    process.on('unhandledRejection', error => failures.push(error.message));
    await import(${JSON.stringify(controllerUrl)});
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    console.log(JSON.stringify({ html: app.innerHTML, failures, requests }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  );
}

test('TV startup reaches a pairing code without Object.hasOwn or AbortSignal.timeout', () => {
  const result = runTvStartup();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.requests, ['/api/display', '/api/tv/challenge']);
  assert.match(result.html, /ABCD-EFGH/);
  assert.doesNotMatch(result.html, /<h1>Loading/);
});

test('TV startup shows a connection error rather than hanging on an older browser', () => {
  const result = runTvStartup({ offline: true });
  assert.deepEqual(result.failures, []);
  assert.match(result.html, /Cannot reach the server/);
  assert.doesNotMatch(result.html, /<h1>Loading/);
});

test('a paired TV renders the real board without Object.hasOwn, replaceAll or AbortSignal.timeout', () => {
  const display = syntheticDisplayWithBoard();
  const result = runTvStartup({ display });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.requests, ['/api/display']);
  assert.match(result.html, /Synthetic Compat Shop/);
  assert.match(result.html, /board-tv/);
  assert.match(result.html, /Order value/);
  assert.match(result.html, /dark-board/);
  // Display-only: order numbers are shown as plain text, but no admin links, store domain,
  // controls or owner management.
  assert.doesNotMatch(result.html, /href="https?:/);
  assert.doesNotMatch(result.html, /myshopify|admin\.shopify|data-action|<select|<input/);
  assert.match(result.html, /Latest orders/);
});

test('a TV given figures it cannot validate shows no figures at all', () => {
  const display = syntheticDisplayWithBoard();
  display.board.periods.week = null;
  const result = runTvStartup({ display });
  assert.deepEqual(result.failures, []);
  assert.match(result.html, /cannot show/);
  assert.doesNotMatch(result.html, /Order value/);
});

// Everything the TV page loads, found by following its import statements.
function tvModuleClosure() {
  const seen = new Set();
  const pending = ['tv.js'];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = fs.readFileSync(path.join(PUBLIC_DIRECTORY, name), 'utf8');
    for (const match of source.matchAll(/from '\.\/([\w-]+\.js)'/g)) pending.push(match[1]);
  }
  return [...seen].sort();
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

test('no module the TV loads uses a built-in that older TV browsers lack', () => {
  const modules = tvModuleClosure();
  assert.ok(modules.includes('board.js') && modules.includes('live-board-model.js'));
  // The owner page modules are not part of the TV.
  for (const owner of ['beta.js', 'beta-view.js', 'beta-store-view.js', 'beta-shopify-client.js']) {
    assert.equal(modules.includes(owner), false, `${owner} must not load on the TV`);
  }
  const banned = [
    /Object\.hasOwn\s*\(/,
    /\.replaceAll\s*\(/,
    /AbortSignal\.(timeout|any)\b/,
    /structuredClone\s*\(/,
    /\.at\s*\(/,
    /\.findLast(Index)?\s*\(/,
    /\.toSorted\s*\(/,
    /Object\.groupBy\s*\(/,
  ];
  for (const name of modules) {
    const source = withoutComments(fs.readFileSync(path.join(PUBLIC_DIRECTORY, name), 'utf8'));
    for (const pattern of banned) {
      assert.doesNotMatch(source, pattern, `${name} uses ${pattern}`);
    }
  }
});
