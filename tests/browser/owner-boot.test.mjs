// What the owner page shows when it opens, for each state the server can report. The real controller
// (public/owner/owner.js) runs against SYNTHETIC server answers; see tests/helpers/owner-page.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticSnapshot } from '../helpers/synthetic-snapshot.mjs';
import {
  NO_SCREENS,
  SYNTHETIC_STORE,
  ownerSession,
  runOwnerPage,
  storeAnswer,
} from '../helpers/owner-page.mjs';

function openOwnerPage({ search = '', store }) {
  return runOwnerPage({
    search,
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [store],
    },
  });
}

test('a connected owner sees the board, the return notice, and the page keeps polling', () => {
  const result = openOwnerPage({
    search: '?shopify=connected',
    store: storeAnswer({
      state: 'connected',
      sync: { state: 'ok' },
      snapshot: syntheticSnapshot({ shopName: 'Synthetic Boot Shop', domain: SYNTHETIC_STORE }),
    }),
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(
    result.requests.map((request) => request.url),
    ['/api/session', '/api/screens', '/api/shopify'],
  );
  assert.deepEqual(result.replaced, ['/app'], 'the result is removed from the address bar');
  assert.match(result.html, /Synthetic Boot Shop/);
  assert.match(result.html, /Order value/);
  assert.match(result.html, /approved the connection/);
  assert.match(result.html, /data-action="disconnect-shopify-ask"/);
  assert.deepEqual(result.timers, [30000], 'figures refresh by themselves');
  assert.doesNotMatch(result.html, /owner-csrf-token/);
});

test('an unconnected owner sees the connect form and no figures or polling', () => {
  const result = openOwnerPage({ store: storeAnswer() });

  assert.deepEqual(result.failures, []);
  assert.match(result.html, /data-form="connect-shopify"/);
  assert.match(result.html, new RegExp(`value="${SYNTHETIC_STORE}"`));
  assert.doesNotMatch(result.html, /Order value|class="board-heading"/);
  assert.deepEqual(result.timers, []);
});

test('a failed return from Shopify is shown as a failure and changes nothing else', () => {
  const result = openOwnerPage({ search: '?shopify=failed', store: storeAnswer() });

  assert.match(result.html, /did not finish/);
  assert.match(result.html, /data-form="connect-shopify"/);
});

test('a first sync still running polls quickly and promises no figures', () => {
  const result = openOwnerPage({
    store: storeAnswer({ state: 'connected', sync: { state: 'loading' } }),
  });

  assert.match(result.html, /first read from Shopify is running/);
  assert.doesNotMatch(result.html, /Order value/);
  assert.deepEqual(result.timers, [5000]);
});

test('a store status that cannot load is an honest error with a retry, not an empty page', () => {
  const result = openOwnerPage({ store: storeAnswer({ status: 500 }) });

  assert.match(result.html, /Something went wrong|Could not/);
  assert.match(result.html, /data-action="refresh-store"/);
});
