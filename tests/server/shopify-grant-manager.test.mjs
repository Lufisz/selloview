// All Shopify responses in this file are SYNTHETIC test doubles injected through fetchImpl.
// Nothing here contacts Shopify, uses real credentials or proves a live OAuth installation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createGrantManager } from '../../server/shopify/grant-manager.mjs';
import { createShopifyFetch } from '../../server/shopify/http.mjs';
import { createShopifySdk } from '../../server/shopify/sdk.mjs';
import { createTokenStore } from '../../server/shopify/token-store.mjs';

const STORE = 'synthetic-test-store.myshopify.com';
const ORIGIN = 'https://selloview.test.example';
const CLIENT_ID = 'synthetic_client_id_0001';
const CLIENT_SECRET = 'synthetic_client_secret_value_0001';
const KEY = crypto.randomBytes(32);
const SCOPE_TEXT = 'read_all_orders,read_orders,read_products,read_inventory';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NINETY_DAYS_MS = 90 * 24 * HOUR_MS;

let scratch;
before(async () => {
  // The token store refuses a directory reached through a symlink, and os.tmpdir() is one on macOS.
  scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'selloview-grants-'));
});
after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// The JSON body of Shopify's token endpoint for an expiring offline token.
function tokenResponse(overrides = {}) {
  return {
    access_token: 'synthetic_access_1',
    scope: SCOPE_TEXT,
    expires_in: 3600,
    refresh_token: 'synthetic_refresh_1',
    refresh_token_expires_in: 7776000,
    ...overrides,
  };
}

// What the official SDK hands back after a successful authorization code exchange.
function offlineSession(overrides = {}) {
  return {
    shop: STORE,
    isOnline: false,
    accessToken: 'synthetic_access_1',
    scope: SCOPE_TEXT,
    expires: new Date(Date.now() + HOUR_MS),
    refreshToken: 'synthetic_refresh_1',
    refreshTokenExpires: new Date(Date.now() + NINETY_DAYS_MS),
    ...overrides,
  };
}

/** Synthetic Shopify token endpoint. `respond(body, callIndex)` returns { status, json }. */
function createUpstream(respond) {
  const calls = [];
  async function fetchImpl(url, options) {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body });
    const { status = 200, json } = await respond(body, calls.length);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return { fetchImpl, calls };
}

// Answers every refresh with the next token pair: synthetic_access_2/refresh_2, then 3, ...
function rotatingUpstream() {
  let generation = 1;
  return () => {
    generation += 1;
    return {
      json: tokenResponse({
        access_token: `synthetic_access_${generation}`,
        refresh_token: `synthetic_refresh_${generation}`,
      }),
    };
  };
}

// An upstream that holds each refresh until the test calls release(), so a test can act while
// the refresh is in flight without relying on timers.
function gatedUpstream(respondAfterRelease) {
  const requested = Promise.withResolvers();
  const released = Promise.withResolvers();
  const respond = async (body, callIndex) => {
    requested.resolve();
    await released.promise;
    return respondAfterRelease(body, callIndex);
  };
  return { respond, requested: requested.promise, release: released.resolve };
}

async function createHarness({ respond = () => ({ json: tokenResponse() }), directory, key } = {}) {
  const dir = directory ?? (await fs.mkdtemp(path.join(scratch, 'case-')));
  const tokenFile = path.join(dir, 'private', 'grant.json');
  const upstream = createUpstream(respond);
  const shopify = createShopifySdk({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    origin: ORIGIN,
  });
  const boundedFetch = createShopifyFetch({ store: STORE, fetchImpl: upstream.fetchImpl });
  const clock = { value: Date.now() };
  const events = [];

  // A second manager on the same file is a server restart. `wrapTokenStore` lets a test put its own
  // behaviour around the real store.
  function startManager({ onChange, wrapTokenStore = (realStore) => realStore } = {}) {
    const tokenStore = createTokenStore({
      filePath: tokenFile,
      key: key ?? KEY,
      clientId: CLIENT_ID,
      store: STORE,
    });
    return createGrantManager({
      tokenStore: wrapTokenStore(tokenStore),
      shopify,
      boundedFetch,
      store: STORE,
      clientId: CLIENT_ID,
      now: () => clock.value,
      onChange: onChange ?? (async (event) => events.push(event)),
    });
  }

  const manager = startManager();

  // Install a session the way the OAuth callback does: epoch first, then the exchange result.
  async function connect(session = offlineSession(), target = manager) {
    const installed = await target.installSession(session, target.epoch);
    assert.equal(installed, true);
  }

  async function tokenFileExists() {
    return fs.stat(tokenFile).then(
      () => true,
      (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
    );
  }

  return {
    dir,
    tokenFile,
    upstream,
    clock,
    events,
    manager,
    startManager,
    connect,
    tokenFileExists,
  };
}

describe('access tokens and refresh', () => {
  test('serves the current token without a network call while it is fresh', async () => {
    const { manager, clock, upstream, connect } = await createHarness();
    await connect();
    clock.value += 30 * MINUTE_MS;
    assert.equal(await manager.getAccessToken(), 'synthetic_access_1');
    assert.equal(upstream.calls.length, 0);
  });

  test('refreshes early with singleflight and persists the rotated refresh token', async () => {
    const { manager, clock, upstream, tokenFile, startManager, connect } = await createHarness({
      respond: rotatingUpstream(),
    });
    await connect();
    clock.value += 56 * MINUTE_MS;
    const tokens = await Promise.all([1, 2, 3, 4].map(() => manager.getAccessToken()));
    assert.deepEqual(new Set(tokens), new Set(['synthetic_access_2']));
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].body.grant_type, 'refresh_token');
    assert.equal(upstream.calls[0].body.refresh_token, 'synthetic_refresh_1');
    assert.equal(upstream.calls[0].body.client_secret, CLIENT_SECRET);

    // A restarted manager sees the rotated pair, and the disk stays encrypted.
    const restarted = startManager();
    assert.equal(await restarted.getAccessToken(), 'synthetic_access_2');
    assert.ok(!(await fs.readFile(tokenFile, 'utf8')).includes('synthetic_'));
    await restarted.getAccessToken({ forceRefresh: true });
    assert.equal(
      upstream.calls.at(-1).body.refresh_token,
      'synthetic_refresh_2',
      'the rotated token, not the original, is used next',
    );
  });

  test('forceRefresh refreshes a fresh token once; concurrent forced calls share one flight', async () => {
    const { manager, upstream, connect } = await createHarness({ respond: rotatingUpstream() });
    await connect();
    const tokens = await Promise.all([
      manager.getAccessToken({ forceRefresh: true }),
      manager.getAccessToken({ forceRefresh: true }),
    ]);
    assert.equal(tokens[0], tokens[1]);
    assert.notEqual(tokens[0], 'synthetic_access_1');
    assert.equal(upstream.calls.length, 1);
    assert.equal(await manager.getAccessToken(), tokens[0]);
  });

  test('a transient refresh failure keeps credentials: a valid token is still served, a forced refresh throws', async () => {
    let upstreamIsDown = false;
    const { manager, clock, connect } = await createHarness({
      respond: () =>
        upstreamIsDown
          ? { status: 503, json: { error: 'unavailable' } }
          : {
              json: tokenResponse({
                access_token: 'synthetic_access_9',
                refresh_token: 'synthetic_refresh_9',
              }),
            },
    });
    await connect();
    upstreamIsDown = true;
    clock.value += 58 * MINUTE_MS; // inside the early-refresh window, token still valid
    assert.equal(await manager.getAccessToken(), 'synthetic_access_1');
    await assert.rejects(manager.getAccessToken({ forceRefresh: true }), {
      code: 'refresh_unavailable',
    });

    clock.value += 10 * MINUTE_MS; // the access token has now expired
    await assert.rejects(manager.getAccessToken(), { code: 'refresh_unavailable' });
    assert.equal(await manager.currentState(), 'connected');

    upstreamIsDown = false;
    assert.equal(await manager.getAccessToken(), 'synthetic_access_9');
  });

  test('a revoked refresh grant requires reauthorization and deletes the local credentials', async () => {
    let revoked = false;
    const { manager, events, tokenFileExists, connect } = await createHarness({
      respond: () => (revoked ? { status: 400, json: { error: 'invalid_grant' } } : { json: {} }),
    });
    await connect();
    revoked = true;
    const eventsBefore = events.length;
    await assert.rejects(manager.getAccessToken({ forceRefresh: true }), {
      code: 'reauthorization_required',
    });
    assert.equal(await manager.currentState(), 'reconnect_required');
    assert.equal(events.length, eventsBefore + 1);
    assert.equal(await tokenFileExists(), false);
    await assert.rejects(manager.getAccessToken(), { code: 'reauthorization_required' });

    // The owner can authorize again from reconnect_required.
    await connect();
    assert.equal(await manager.currentState(), 'connected');
  });

  test('an expired refresh token needs reauthorization without a network call', async () => {
    const { manager, clock, upstream, connect } = await createHarness();
    await connect(offlineSession({ refreshTokenExpires: new Date(Date.now() + 2 * HOUR_MS) }));
    clock.value += 3 * HOUR_MS;
    assert.equal(await manager.currentState(), 'reconnect_required');
    await assert.rejects(manager.getAccessToken(), { code: 'reauthorization_required' });
    assert.equal(upstream.calls.length, 0);
  });

  test('a refresh response that is not an acceptable grant leaves the old grant in place', async () => {
    const { manager, tokenFileExists, connect } = await createHarness({
      respond: () => ({ json: tokenResponse({ scope: `${SCOPE_TEXT},write_orders` }) }),
    });
    await connect();
    await assert.rejects(manager.getAccessToken({ forceRefresh: true }), {
      code: 'refresh_unavailable',
    });
    assert.equal(await manager.getAccessToken(), 'synthetic_access_1');
    assert.equal(await tokenFileExists(), true);
  });

  test('a renewed grant that cannot be written is unavailable, and the old grant stays in place', async (t) => {
    const { manager, tokenFileExists, connect } = await createHarness({
      respond: rotatingUpstream(),
    });
    await connect();

    // Fault injection: the disk refuses the atomic write of the renewed grant.
    t.mock.method(fs, 'rename', async () => {
      throw new Error('synthetic disk failure');
    });
    await assert.rejects(manager.getAccessToken({ forceRefresh: true }), {
      code: 'refresh_unavailable',
    });

    assert.equal(await manager.getAccessToken(), 'synthetic_access_1');
    assert.equal(await tokenFileExists(), true);
  });
});

describe('disconnecting and reconnecting during slow work', () => {
  test('a renewed grant is not published when a removal lands right after its write', async () => {
    const { startManager, connect } = await createHarness({ respond: rotatingUpstream() });
    // The manager does not rely on the store alone: a removal can land between the store
    // finishing its write and the manager looking at the epoch.
    const manager = startManager({
      wrapTokenStore: (realStore) => ({
        get epoch() {
          return realStore.epoch;
        },
        load: () => realStore.load(),
        replace: (grant, epoch) => realStore.replace(grant, epoch),
        remove: () => realStore.remove(),
        save: async (grant, epoch) => {
          const savedEpoch = await realStore.save(grant, epoch);
          realStore.remove().catch(() => {});
          return savedEpoch;
        },
      }),
    });
    await connect(offlineSession(), manager);

    await assert.rejects(manager.getAccessToken({ forceRefresh: true }), {
      code: 'reauthorization_required',
    });
    assert.equal(await manager.getAccessToken(), 'synthetic_access_1', 'the renewal was not kept');
  });

  test('a disconnect while the renewed grant is being written cannot be undone by the write', async (t) => {
    const { manager, tokenFileExists, connect } = await createHarness({
      respond: rotatingUpstream(),
    });
    await connect();

    // Fault injection: hold the atomic write of the renewed grant.
    const realRename = fs.rename;
    const writeStarted = Promise.withResolvers();
    const writeReleased = Promise.withResolvers();
    t.mock.method(fs, 'rename', async (from, to) => {
      writeStarted.resolve();
      await writeReleased.promise;
      return realRename(from, to);
    });
    const outcome = assert.rejects(manager.getAccessToken({ forceRefresh: true }), {
      code: 'reauthorization_required',
    });
    await writeStarted.promise;

    // The removal waits for the held write, so release it before waiting for the disconnect.
    const disconnecting = manager.disconnect();
    writeReleased.resolve();
    await disconnecting;
    await outcome;

    assert.equal(await tokenFileExists(), false);
    assert.equal(await manager.currentState(), 'not_connected');
    await assert.rejects(manager.getAccessToken(), { code: 'reauthorization_required' });
  });

  test('a disconnect during an in-flight refresh cannot restore credentials', async () => {
    const gate = gatedUpstream(() => ({ json: tokenResponse({ access_token: 'late_access' }) }));
    const { manager, startManager, tokenFileExists, connect } = await createHarness({
      respond: gate.respond,
    });
    await connect();
    const pending = manager.getAccessToken({ forceRefresh: true });
    const outcome = assert.rejects(pending, { code: 'reauthorization_required' });
    await gate.requested;

    await manager.disconnect();
    gate.release();
    await outcome;

    assert.equal(await tokenFileExists(), false);
    assert.equal(await manager.currentState(), 'not_connected');
    assert.equal(await startManager().currentState(), 'not_connected');
    await assert.rejects(manager.getAccessToken(), { code: 'reauthorization_required' });
  });

  test('a reconnect during an in-flight refresh wins over the older refresh', async () => {
    const gate = gatedUpstream(() => ({ json: tokenResponse({ access_token: 'late_access' }) }));
    const { manager, startManager, connect } = await createHarness({ respond: gate.respond });
    await connect();
    const pending = manager.getAccessToken({ forceRefresh: true });
    const outcome = assert.rejects(pending, { code: 'reauthorization_required' });
    await gate.requested;

    await connect(offlineSession({ accessToken: 'synthetic_reconnected' }));
    gate.release();
    await outcome;

    assert.equal(await manager.getAccessToken(), 'synthetic_reconnected');
    assert.equal(await startManager().getAccessToken(), 'synthetic_reconnected');
  });

  test('a disconnect during the authorization code exchange cannot create a grant', async () => {
    const { manager, tokenFileExists } = await createHarness();
    const epochBeforeExchange = manager.epoch;
    await manager.disconnect();

    const installed = await manager.installSession(offlineSession(), epochBeforeExchange);
    assert.equal(installed, false);
    assert.equal(await tokenFileExists(), false);
    assert.equal(await manager.currentState(), 'not_connected');
  });
});

describe('failure reports', () => {
  test('markReauthorizationRequired clears credentials, notifies, and is a no-op after a disconnect', async () => {
    const { manager, events, tokenFileExists, connect } = await createHarness();
    await connect();
    const eventsBefore = events.length;
    await manager.markReauthorizationRequired();
    assert.equal(events.length, eventsBefore + 1);
    assert.equal(await manager.currentState(), 'reconnect_required');
    assert.equal(await tokenFileExists(), false);
    await assert.rejects(manager.getAccessToken(), { code: 'reauthorization_required' });

    await connect();
    await manager.disconnect();
    const eventsAfterDisconnect = events.length;
    await manager.markReauthorizationRequired();
    assert.equal(events.length, eventsAfterDisconnect);
    assert.equal(await manager.currentState(), 'not_connected');
  });

  test('a report carrying an outdated token does not revoke a newer grant', async () => {
    const { manager, events, connect } = await createHarness({
      respond: () => ({
        json: tokenResponse({
          access_token: 'synthetic_access_new',
          refresh_token: 'synthetic_refresh_new',
        }),
      }),
    });
    await connect();
    const failedToken = await manager.getAccessToken();
    const refreshedToken = await manager.getAccessToken({ forceRefresh: true });
    assert.notEqual(refreshedToken, failedToken);

    const eventsBefore = events.length;
    await manager.markReauthorizationRequired({ accessToken: failedToken });
    assert.equal(events.length, eventsBefore);
    assert.equal(await manager.getAccessToken(), refreshedToken);

    // A reconnect replaces the grant as well.
    await connect(offlineSession({ accessToken: 'synthetic_reconnected' }));
    await manager.markReauthorizationRequired({ accessToken: refreshedToken });
    assert.equal(await manager.getAccessToken(), 'synthetic_reconnected');

    // The matching token does revoke.
    await manager.markReauthorizationRequired({ accessToken: 'synthetic_reconnected' });
    assert.equal(await manager.currentState(), 'reconnect_required');
    await assert.rejects(manager.getAccessToken(), { code: 'reauthorization_required' });
  });

  test('a report waits for an in-flight refresh instead of revoking the grant it is replacing', async () => {
    const gate = gatedUpstream(() => ({
      json: tokenResponse({
        access_token: 'synthetic_access_new',
        refresh_token: 'synthetic_refresh_new',
      }),
    }));
    const { manager, connect } = await createHarness({ respond: gate.respond });
    await connect();
    const failedToken = await manager.getAccessToken();
    const refresh = manager.getAccessToken({ forceRefresh: true });
    await gate.requested;

    let reportSettled = false;
    const report = manager
      .markReauthorizationRequired({ accessToken: failedToken })
      .then(() => (reportSettled = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reportSettled, false, 'the report is held back while the refresh runs');

    gate.release();
    await report;
    assert.equal(await refresh, 'synthetic_access_new');
    assert.equal(await manager.getAccessToken(), 'synthetic_access_new');
  });
});

describe('change notifications', () => {
  test('onChange receives only a safe state for connect, disconnect and revocation', async () => {
    const { manager, events, connect } = await createHarness();
    await connect();
    await manager.disconnect();
    await connect();
    await manager.markReauthorizationRequired();
    assert.deepEqual(events, [
      { state: 'connected' },
      { state: 'not_connected' },
      { state: 'connected' },
      { state: 'reconnect_required' },
    ]);
  });

  test('a throwing listener neither blocks nor undoes credential changes', async () => {
    const { startManager, tokenFileExists } = await createHarness();
    const manager = startManager({
      onChange: async () => {
        throw new Error('listener failure');
      },
    });
    assert.equal(await manager.installSession(offlineSession(), manager.epoch), true);
    assert.equal(await manager.currentState(), 'connected');
    await manager.disconnect();
    assert.equal(await manager.currentState(), 'not_connected');
    assert.equal(await tokenFileExists(), false);
  });
});

describe('sessions that are not acceptable offline grants', () => {
  const unacceptable = [
    ['broader scopes', { scope: `${SCOPE_TEXT},write_orders` }],
    ['narrower scopes', { scope: 'read_orders,read_products' }],
    ['unrelated extra scope', { scope: 'read_orders,read_products,read_inventory,read_customers' }],
    ['an online session', { isOnline: true }],
    [
      'a session without a refresh token',
      { refreshToken: undefined, refreshTokenExpires: undefined },
    ],
    ['a token with whitespace', { accessToken: 'has space' }],
    ['another store', { shop: 'other-store.myshopify.com' }],
  ];

  for (const [name, overrides] of unacceptable) {
    test(`${name} is refused without saving`, async () => {
      const { manager, events, tokenFileExists } = await createHarness();
      const installed = await manager.installSession(offlineSession(overrides), manager.epoch);
      assert.equal(installed, false);
      assert.equal(await manager.currentState(), 'not_connected');
      assert.equal(await tokenFileExists(), false);
      assert.deepEqual(events, []);
    });
  }

  test('a refused reconnect keeps the previous still-valid grant', async () => {
    const { manager, startManager, connect } = await createHarness();
    await connect();
    const installed = await manager.installSession(
      offlineSession({ accessToken: 'synthetic_other', scope: 'read_orders' }),
      manager.epoch,
    );
    assert.equal(installed, false);
    assert.equal(await manager.currentState(), 'connected');
    assert.equal(await manager.getAccessToken(), 'synthetic_access_1');
    assert.equal(await startManager().currentState(), 'connected');
  });
});

describe('corrupt or mismatched stored credentials', () => {
  test('the wrong key fails closed as reconnect_required, exposes no token, and can be reconnected', async () => {
    const first = await createHarness();
    await first.connect();

    const other = await createHarness({ directory: first.dir, key: crypto.randomBytes(32) });
    assert.equal(await other.manager.currentState(), 'reconnect_required');
    await assert.rejects(other.manager.getAccessToken(), { code: 'reauthorization_required' });

    await other.connect();
    assert.equal(await other.manager.currentState(), 'connected');
  });

  test('a corrupted file fails closed', async () => {
    const { tokenFile, startManager, connect } = await createHarness();
    await connect();
    const envelope = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    envelope.data = Buffer.from('tampered-ciphertext-bytes').toString('base64');
    await fs.writeFile(tokenFile, JSON.stringify(envelope), { mode: 0o600 });

    const restarted = startManager();
    assert.equal(await restarted.currentState(), 'reconnect_required');
    await assert.rejects(restarted.getAccessToken(), { code: 'reauthorization_required' });
  });
});
