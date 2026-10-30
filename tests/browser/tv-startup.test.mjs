// Start the actual TV controller with synthetic HTTP responses and an older-browser API surface.
// This catches startup failures that isolated renderer and API tests cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syntheticDisplay, syntheticSnapshot } from '../helpers/synthetic-snapshot.mjs';
import { runTvPage } from '../helpers/tv-page.mjs';

const PUBLIC_DIRECTORY = new URL('../../public/', import.meta.url).pathname;

function syntheticDisplayWithBoard() {
  const snapshot = syntheticSnapshot({
    shopName: 'Synthetic Compat Shop',
    domain: 'synthetic-compat.myshopify.com',
    orderCount: 4,
    hoursBetweenOrders: 26,
  });
  return syntheticDisplay({ screenName: 'Compat TV', snapshot });
}

// The page's start-up: with no display session (it asks for a pairing code), or already paired.
function runTvStartup({ offline = false, display = null } = {}) {
  const routes = display
    ? { '/api/display': [{ status: 200, body: display }] }
    : {
        '/api/display': [{ status: 401, body: { error: 'unauthenticated' } }],
        '/api/tv/challenge': [{ status: 201, body: { code: 'ABCD-EFGH' } }],
      };
  return runTvPage({ routes, offline });
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

test('a surprise while showing figures puts an error on screen and tries again, not a frozen board', () => {
  const display = { ...syntheticDisplayWithBoard(), settings: undefined };
  const result = runTvStartup({ display });
  assert.deepEqual(result.failures, []);
  assert.match(result.html, /Something went wrong/);
  assert.deepEqual(result.timers, [15000], 'the screen starts over after the retry delay');
});

test('a paired TV asks for fresh figures every ten seconds', () => {
  const result = runTvStartup({ display: syntheticDisplayWithBoard() });
  assert.deepEqual(result.timers, [10000]);
});

// Everything the TV page loads, found by following its import statements.
function tvModuleClosure() {
  const seen = new Set();
  const pending = ['tv/tv.js'];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = fs.readFileSync(path.join(PUBLIC_DIRECTORY, name), 'utf8');
    for (const match of source.matchAll(/from '(\.{1,2}\/[\w/-]+\.js)'/g)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1])));
    }
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
  assert.ok(modules.includes('shared/board.js') && modules.includes('shared/board-model.js'));
  // The owner page modules are not part of the TV.
  for (const owner of [
    'owner/owner.js',
    'owner/owner-view.js',
    'owner/store-view.js',
    'owner/shopify-client.js',
  ]) {
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
