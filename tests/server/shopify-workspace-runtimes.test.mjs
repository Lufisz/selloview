// The per-workspace runtimes of linked Shopify stores: how they are created, and when they refresh.
// Everything here is synthetic: no Shopify call is made and no grant file is touched.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntimes } from '../../server/shopify/workspace-runtimes.mjs';

const STORE = 'synthetic-test-store.myshopify.com';
const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174001';
const MINUTE_MS = 60_000;
const REFRESH_INTERVAL_MS = 2 * MINUTE_MS;
const LOGO_RECHECK_MS = 24 * 60 * MINUTE_MS;
const LOGO_RETRY_MS = 30 * MINUTE_MS;

function createRuntimes(overrides = {}) {
  const clock = { now: 1_000_000 };
  const runtimes = createWorkspaceRuntimes({
    database: null,
    config: {
      store: STORE,
      clientId: 'synthetic_client_id_0001',
      tokenDirectory: '/synthetic/grants',
      encryptionKey: crypto.randomBytes(32),
    },
    shopify: null,
    boundedFetch: null,
    fetchImpl: async () => {
      throw new Error('no network in this test');
    },
    now: () => clock.now,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    fetchLogo: async () => null,
    ...overrides,
  });
  return { runtimes, clock };
}

// A runtime whose refresh runs until the test finishes it.
function createFakeRuntime() {
  const runtime = { lastTriggeredAt: null, refreshesStarted: 0, finishRefresh: null };
  runtime.cache = {
    inflight: null,
    refresh() {
      runtime.refreshesStarted += 1;
      runtime.cache.inflight = new Promise((resolve) => {
        runtime.finishRefresh = () => {
          runtime.cache.inflight = null;
          resolve();
        };
      });
      return runtime.cache.inflight;
    },
  };
  return runtime;
}

async function finishRefresh(runtime) {
  const flight = runtime.cache.inflight;
  runtime.finishRefresh();
  await flight;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a workspace id becomes a file name, so only ids shaped like ours get a runtime', () => {
  const { runtimes } = createRuntimes();
  const refused = ['', 'abc', '../../etc/passwd', `${WORKSPACE_ID}/../other`, `${WORKSPACE_ID}\0`];
  for (const workspaceId of refused) {
    assert.throws(() => runtimes.forWorkspace(workspaceId), /invalid workspace id/);
  }
});

test('a workspace keeps one runtime until it is forgotten', () => {
  const { runtimes } = createRuntimes();
  const runtime = runtimes.forWorkspace(WORKSPACE_ID);
  assert.equal(runtimes.forWorkspace(WORKSPACE_ID), runtime);
  assert.notEqual(runtimes.forWorkspace(OTHER_WORKSPACE_ID), runtime);

  runtimes.forget(WORKSPACE_ID);
  assert.notEqual(runtimes.forWorkspace(WORKSPACE_ID), runtime);
});

test('a refresh starts when due, never twice at once, and again only after the interval', async () => {
  const { runtimes, clock } = createRuntimes();
  const runtime = createFakeRuntime();

  runtimes.maybeRefresh(runtime);
  runtimes.maybeRefresh(runtime);
  assert.equal(runtime.refreshesStarted, 1);

  await finishRefresh(runtime);
  clock.now += REFRESH_INTERVAL_MS - 1;
  runtimes.maybeRefresh(runtime);
  assert.equal(runtime.refreshesStarted, 1);

  clock.now += 1;
  runtimes.maybeRefresh(runtime);
  assert.equal(runtime.refreshesStarted, 2);
});

test('only two stores refresh at once; the one that had to wait refreshes on its next read', async () => {
  const { runtimes } = createRuntimes();
  const [first, second, third] = [createFakeRuntime(), createFakeRuntime(), createFakeRuntime()];

  for (const runtime of [first, second, third]) runtimes.maybeRefresh(runtime);
  assert.deepEqual(
    [first, second, third].map((runtime) => runtime.refreshesStarted),
    [1, 1, 0],
  );
  assert.equal(third.lastTriggeredAt, null, 'a store that had to wait is still due');

  await finishRefresh(first);
  runtimes.maybeRefresh(third);
  assert.equal(third.refreshesStarted, 1);
});

test('the logo is read once, kept for a day, and a failed read keeps the last good logo', async () => {
  const readStores = [];
  let nextRead = async () => ({ version: 'synthetic-logo-1' });
  const fetchLogo = async ({ store }) => {
    readStores.push(store);
    return nextRead();
  };
  const { runtimes, clock } = createRuntimes({ fetchLogo });
  const runtime = { logo: { image: null, nextCheckAt: 0, inflight: false } };

  runtimes.maybeRefreshLogo(runtime);
  runtimes.maybeRefreshLogo(runtime);
  await settle();
  assert.deepEqual(readStores, [STORE]);
  assert.equal(runtime.logo.image.version, 'synthetic-logo-1');

  clock.now += LOGO_RECHECK_MS - 1;
  runtimes.maybeRefreshLogo(runtime);
  await settle();
  assert.equal(readStores.length, 1);

  nextRead = async () => {
    throw new Error('synthetic failure');
  };
  clock.now += 1;
  runtimes.maybeRefreshLogo(runtime);
  await settle();
  assert.equal(readStores.length, 2);
  assert.equal(runtime.logo.image.version, 'synthetic-logo-1');

  clock.now += LOGO_RETRY_MS - 1;
  runtimes.maybeRefreshLogo(runtime);
  await settle();
  assert.equal(readStores.length, 2);

  clock.now += 1;
  runtimes.maybeRefreshLogo(runtime);
  await settle();
  assert.equal(readStores.length, 3);
});
