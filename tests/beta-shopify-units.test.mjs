// Units for the beta's Shopify pieces: settings, store links, schema migration, the owner page's
// client and views. Data here is SYNTHETIC and labelled as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { buildSnapshot } from '../server/metrics.mjs';
import { loadBetaShopifyConfig } from '../server/beta/shopify-config.mjs';
import {
  MAX_OPEN_ATTEMPTS,
  claimStore,
  consumeAttempt,
  createAttempt,
  readLiveSession,
  readLink,
  removeLink,
  restoreLink,
} from '../server/beta/shopify-links.mjs';
import {
  AccountError,
  migrateDatabase,
  openInitializedDatabase,
} from '../server/beta/accounts.mjs';
import { projectBoardForDisplay } from '../server/beta/display-board.mjs';
import {
  consumeShopifyReturn,
  disconnectShopify,
  loadShopifyStatus,
  parseConnection,
  startShopifyConnection,
} from '../public/beta-shopify-client.js';
import { renderOwner } from '../public/beta-view.js';
import { renderStorePanel } from '../public/beta-store-view.js';
import { renderPaired } from '../public/tv-view.js';
import { spawn } from 'node:child_process';
import {
  createBetaEnvironment,
  curlAvailable,
  findFreePort,
  httpRequest,
  makeTemporaryDirectory,
} from './beta-helpers.mjs';
import { SYNTHETIC_CLIENT_SECRET, SYNTHETIC_STORE } from './synthetic-shopify.mjs';

const OWNER = 'owner@example.test';
const KEY = crypto.randomBytes(32).toString('base64');

function validEnvironment(directory) {
  return {
    BETA_SHOPIFY_CLIENT_ID: 'synthetic_client_id_0001',
    BETA_SHOPIFY_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    BETA_SHOPIFY_ENCRYPTION_KEY: KEY,
    BETA_SHOPIFY_TOKEN_DIR: directory,
    BETA_SHOPIFY_ALLOWED_STORE: SYNTHETIC_STORE,
    BETA_SHOPIFY_OWNER_EMAIL: 'Owner@Example.test',
  };
}

// ---- configuration ------------------------------------------------------------------------

test('no Shopify settings at all is a safe setup-required state', () => {
  assert.deepEqual({ ...loadBetaShopifyConfig({}) }, { status: 'setup_required' });
  assert.deepEqual(
    { ...loadBetaShopifyConfig({ BETA_SHOPIFY_CLIENT_ID: '' }) },
    { status: 'setup_required' },
  );
});

test('complete settings load; partial or malformed settings fail closed without details', () => {
  const directory = path.join(path.sep, 'var', 'lib', 'metrictv-test-grants');
  const config = loadBetaShopifyConfig(validEnvironment(directory));
  assert.equal(config.status, 'ready');
  assert.equal(config.ownerEmail, 'owner@example.test', 'the owner address is normalized');
  assert.equal(config.store, SYNTHETIC_STORE);
  assert.equal(config.clientSecret, SYNTHETIC_CLIENT_SECRET);
  const serialized = JSON.stringify(config) + String(Object.keys(config));
  for (const secret of [SYNTHETIC_CLIENT_SECRET, KEY, directory, 'synthetic_client_id_0001']) {
    assert.equal(serialized.includes(secret), false, 'secrets are not enumerable');
  }

  const good = validEnvironment(directory);
  const bad = [];
  for (const name of Object.keys(good)) bad.push({ ...good, [name]: '' });
  bad.push(
    { ...good, BETA_SHOPIFY_CLIENT_ID: 'short' },
    { ...good, BETA_SHOPIFY_CLIENT_SECRET: 'has space in it, not allowed' },
    { ...good, BETA_SHOPIFY_ENCRYPTION_KEY: crypto.randomBytes(16).toString('base64') },
    { ...good, BETA_SHOPIFY_ENCRYPTION_KEY: ` ${KEY}` },
    { ...good, BETA_SHOPIFY_ENCRYPTION_KEY: KEY.replace(/=$/, '') },
    { ...good, BETA_SHOPIFY_ENCRYPTION_KEY: 12345 },
    { ...good, BETA_SHOPIFY_TOKEN_DIR: 'relative/grants' },
    { ...good, BETA_SHOPIFY_TOKEN_DIR: `${directory}/` },
    { ...good, BETA_SHOPIFY_TOKEN_DIR: `${directory}/../x` },
    { ...good, BETA_SHOPIFY_TOKEN_DIR: path.resolve(import.meta.dirname, '..', 'grants') },
    { ...good, BETA_SHOPIFY_TOKEN_DIR: path.resolve(import.meta.dirname, '..', 'public') },
    // A folder whose name merely starts with ".." is still inside the project, not above it.
    { ...good, BETA_SHOPIFY_TOKEN_DIR: path.resolve(import.meta.dirname, '..', '..tokens') },
    { ...good, BETA_SHOPIFY_TOKEN_DIR: path.sep },
    { ...good, BETA_SHOPIFY_ALLOWED_STORE: 'Store.myshopify.com' },
    { ...good, BETA_SHOPIFY_ALLOWED_STORE: 'evil.example.com' },
    { ...good, BETA_SHOPIFY_ALLOWED_STORE: `https://${SYNTHETIC_STORE}` },
    { ...good, BETA_SHOPIFY_OWNER_EMAIL: 'not an email' },
  );
  for (const env of bad) {
    assert.throws(
      () => loadBetaShopifyConfig(env),
      (error) =>
        error.code === 'invalid_connection_config' &&
        !String(error.message).includes(SYNTHETIC_CLIENT_SECRET),
    );
  }
});

// ---- links and attempts ------------------------------------------------------------------------

async function databaseWithOwners(t, emails) {
  const environment = await createBetaEnvironment(t, { invites: emails });
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  const workspaces = emails.map((email) =>
    database
      .prepare(
        `SELECT workspace.id AS workspaceId, "user".id AS userId FROM workspace
           JOIN "user" ON "user".id = workspace.owner_user_id WHERE "user".email = ?`,
      )
      .get(email),
  );
  return { environment, database, workspaces };
}

test('a store belongs to one workspace; the unique constraint decides, not a prior read', async (t) => {
  const { database, workspaces } = await databaseWithOwners(t, [OWNER, 'second@example.test']);
  const [first, second] = workspaces;
  const nowMs = Date.now();
  assert.equal(
    claimStore(database, {
      workspaceId: first.workspaceId,
      shop: SYNTHETIC_STORE,
      state: 'connected',
      nowMs,
    }),
    'ok',
  );
  assert.equal(
    claimStore(database, {
      workspaceId: second.workspaceId,
      shop: SYNTHETIC_STORE,
      state: 'connected',
      nowMs,
    }),
    'conflict',
  );
  assert.equal(readLink(database, second.workspaceId), null);
  // Claiming again from the owner updates, it does not fail.
  assert.equal(
    claimStore(database, {
      workspaceId: first.workspaceId,
      shop: SYNTHETIC_STORE,
      state: 'reconnect_required',
      nowMs,
    }),
    'ok',
  );
  assert.equal(readLink(database, first.workspaceId).state, 'reconnect_required');

  // Putting a failed attempt back restores exactly what was there before.
  const previous = readLink(database, first.workspaceId);
  claimStore(database, {
    workspaceId: first.workspaceId,
    shop: SYNTHETIC_STORE,
    state: 'connected',
    nowMs,
  });
  restoreLink(database, { workspaceId: first.workspaceId, previous, nowMs });
  assert.equal(readLink(database, first.workspaceId).state, 'reconnect_required');
  removeLink(database, first.workspaceId);
  restoreLink(database, { workspaceId: first.workspaceId, previous: null, nowMs });
  assert.equal(readLink(database, first.workspaceId), null);
});

test('a pending attempt is one-use, one per workspace and bounded overall', async (t) => {
  const { database, workspaces } = await databaseWithOwners(t, [OWNER, 'second@example.test']);
  const [first, second] = workspaces;
  const nowMs = Date.now();
  const attempt = (workspace, state) => ({
    state,
    bindingSecret: `binding-${state}`,
    workspaceId: workspace.workspaceId,
    userId: workspace.userId,
    sessionId: 'session-id',
    shop: SYNTHETIC_STORE,
    nowMs,
    lifetimeMs: 60_000,
  });
  assert.equal(createAttempt(database, attempt(first, 'state-one')), true);
  assert.equal(createAttempt(database, attempt(first, 'state-two')), true);
  assert.equal(consumeAttempt(database, 'state-one'), null, 'a newer start replaced it');
  assert.equal(createAttempt(database, attempt(second, 'state-three')), true);

  const taken = consumeAttempt(database, 'state-two');
  assert.equal(taken.workspace_id, first.workspaceId);
  assert.equal(taken.binding_hash.includes('binding'), false, 'only hashes are stored');
  assert.equal(consumeAttempt(database, 'state-two'), null, 'consuming is one-use');

  database.prepare('DELETE FROM shopify_oauth_attempt').run();
  const insertRow = database.prepare(
    `INSERT INTO shopify_oauth_attempt
       (id, state_hash, binding_hash, workspace_id, user_id, session_id, shop, created_at, expires_at)
     VALUES (?, ?, 'h', ?, ?, 's', ?, ?, ?)`,
  );
  for (let index = 0; index < MAX_OPEN_ATTEMPTS; index += 1) {
    insertRow.run(
      `id-${index}`,
      `hash-${index}`,
      first.workspaceId,
      first.userId,
      SYNTHETIC_STORE,
      nowMs,
      nowMs + 60_000,
    );
  }
  assert.equal(createAttempt(database, attempt(second, 'state-over-cap')), false);
  // Expired rows do not count against the cap.
  database.prepare('UPDATE shopify_oauth_attempt SET expires_at = ?').run(nowMs - 1);
  assert.equal(createAttempt(database, attempt(second, 'state-after-expiry')), true);
});

test('a session counts as live only while its row exists and has not expired', async (t) => {
  const { database, environment } = await databaseWithOwners(t, [OWNER]);
  const user = database.prepare('SELECT id FROM "user"').get();
  const insert = database.prepare(
    `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const nowMs = Date.now();
  const later = new Date(nowMs + 60_000).toISOString();
  const earlier = new Date(nowMs - 60_000).toISOString();
  insert.run('live-session', later, 'token-one', earlier, earlier, user.id);
  insert.run('old-session', earlier, 'token-two', earlier, earlier, user.id);
  assert.equal(readLiveSession(database, 'live-session', nowMs).email, OWNER);
  assert.equal(readLiveSession(database, 'old-session', nowMs), null);
  assert.equal(readLiveSession(database, 'missing', nowMs), null);
  database.prepare('DELETE FROM session WHERE id = ?').run('live-session');
  assert.equal(readLiveSession(database, 'live-session', nowMs), null);
  assert.ok(environment.databasePath);
});

// ---- migration ---------------------------------------------------------------------------------

test('schema 2 is refused until migrated; migration keeps accounts, sessions, screens and settings', async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [OWNER] });
  const database = openInitializedDatabase(environment.databasePath);
  const user = database.prepare('SELECT id FROM "user"').get();
  const workspace = database.prepare('SELECT id FROM workspace').get();
  database
    .prepare(
      `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES ('kept-session', '2099-01-01T00:00:00.000Z', 'kept-token', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(user.id);
  database
    .prepare(
      `INSERT INTO display_session (id, secret_hash, workspace_id, name, created_at, expires_at, last_seen_at)
       VALUES ('kept-screen', 'hash', ?, 'Kept TV', 1, 4102444800000, NULL)`,
    )
    .run(workspace.id);
  database
    .prepare("UPDATE workspace_settings SET period = 'month', theme = 'dark', revision = 4")
    .run();

  // Emulate a version 2 file: the two tables version 3 adds do not exist.
  database.exec(
    'DROP TABLE shopify_oauth_attempt; DROP TABLE workspace_store; PRAGMA user_version = 2;',
  );
  database.close();
  assert.throws(
    () => openInitializedDatabase(environment.databasePath),
    (error) => error instanceof AccountError && error.code === 'schema_not_current',
  );

  const credentials = {
    databasePath: environment.databasePath,
    secret: environment.secret,
    origin: environment.origin,
  };
  await migrateDatabase(credentials);
  await migrateDatabase(credentials); // idempotent

  const migrated = openInitializedDatabase(environment.databasePath);
  t.after(() => migrated.close());
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(migrated.prepare('SELECT email FROM "user"').get().email, OWNER);
  assert.equal(
    migrated.prepare("SELECT id FROM session WHERE id = 'kept-session'").get().id,
    'kept-session',
  );
  assert.equal(
    migrated.prepare("SELECT name FROM display_session WHERE id = 'kept-screen'").get().name,
    'Kept TV',
  );
  assert.deepEqual(
    { ...migrated.prepare('SELECT period, theme, revision FROM workspace_settings').get() },
    { period: 'month', theme: 'dark', revision: 4 },
  );
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM workspace_store').get().n, 0);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM shopify_oauth_attempt').get().n, 0);
});

// ---- owner page client ---------------------------------------------------------------------------

function syntheticSnapshot({ shopName = 'Synthetic Beta Shop' } = {}) {
  const now = new Date();
  const hour = 3600 * 1000;
  const orders = [1, 2, 3].map((index) => ({
    id: `gid://shopify/Order/${index}`,
    name: `#${1000 + index}`,
    createdAt: new Date(now.getTime() - index * 30 * hour).toISOString(),
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'EUR' } },
  }));
  const raw = {
    shop: {
      name: shopName,
      myshopifyDomain: SYNTHETIC_STORE,
      currencyCode: 'EUR',
      ianaTimezone: 'Europe/Stockholm',
      plan: { publicDisplayName: 'Basic' },
    },
    since: new Date(now.getTime() - 130 * 24 * hour),
    until: now,
    orders,
    ordersComplete: true,
    variants: [],
    inventoryComplete: true,
  };
  const sync = {
    state: 'ok',
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    errorCode: null,
  };
  return { ...buildSnapshot(raw, now), sync };
}

function fakeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('the client accepts only well-formed connections and drops unusable snapshots', async () => {
  assert.equal(parseConnection({ state: 'bogus' }), null);
  assert.equal(parseConnection({ state: 'connected', store: 'not a store' }), null);
  assert.equal(parseConnection({ state: 'connected', store: 'Upper.myshopify.com' }), null);
  assert.equal(parseConnection({ state: 'connected', sync: { state: 'weird' } }), null);
  assert.deepEqual(parseConnection({ state: 'pilot_unavailable', canConnect: false }), {
    state: 'pilot_unavailable',
    store: '',
    canConnect: false,
    sync: null,
  });

  const snapshot = syntheticSnapshot();
  const connection = {
    state: 'connected',
    store: SYNTHETIC_STORE,
    canConnect: true,
    sync: { state: 'ok' },
  };
  const good = await loadShopifyStatus(fakeFetch(200, { connection, snapshot }).fetchImpl);
  assert.equal(good.ok, true);
  assert.equal(good.snapshot.shop.name, 'Synthetic Beta Shop');

  const broken = { ...snapshot, periods: { ...snapshot.periods, week: null } };
  const dropped = await loadShopifyStatus(
    fakeFetch(200, { connection, snapshot: broken }).fetchImpl,
  );
  assert.equal(dropped.ok, true);
  assert.equal(dropped.snapshot, null, 'an invalid snapshot is never rendered');

  const notConnected = await loadShopifyStatus(
    fakeFetch(200, { connection: { ...connection, state: 'not_connected' }, snapshot }).fetchImpl,
  );
  assert.equal(notConnected.snapshot, null, 'figures only while connected');
  assert.equal(
    (await loadShopifyStatus(fakeFetch(401, { error: 'unauthenticated' }).fetchImpl)).status,
    401,
  );
  assert.equal(
    (await loadShopifyStatus(fakeFetch(200, { connection: 5 }).fetchImpl)).error,
    'malformed',
  );
});

test('starting a connection sends only the canonical store and follows only a Shopify address', async () => {
  const authorize = `https://${SYNTHETIC_STORE}/admin/oauth/authorize?client_id=x&scope=read_all_orders,read_orders,read_products,read_inventory&redirect_uri=https%3A%2F%2Fbeta.example.test%2Fauth%2Fbeta%2Fshopify%2Fcallback&state=abc`;
  const callbackUrl = 'https://beta.example.test/auth/beta/shopify/callback';
  const ok = fakeFetch(200, { authorizationUrl: authorize });
  const started = await startShopifyConnection(
    { csrfToken: 'tok', storeText: ` ${SYNTHETIC_STORE.toUpperCase()} `, callbackUrl },
    ok.fetchImpl,
  );
  assert.deepEqual(started, { ok: true, authorizationUrl: authorize });
  assert.equal(ok.calls[0].url, '/api/beta/shopify/start');
  assert.deepEqual(JSON.parse(ok.calls[0].options.body), { store: SYNTHETIC_STORE });
  assert.equal(ok.calls[0].options.headers['X-CSRF-Token'], 'tok');
  assert.equal(ok.calls[0].options.credentials, 'same-origin');

  const never = fakeFetch(200, {});
  for (const text of ['', 'evil.example.com', 'https://x.myshopify.com', 'a b.myshopify.com']) {
    const refused = await startShopifyConnection(
      { csrfToken: 'tok', storeText: text, callbackUrl },
      never.fetchImpl,
    );
    assert.deepEqual(refused, { ok: false, error: 'invalid_store' });
  }
  assert.equal(never.calls.length, 0, 'invalid input never leaves the page');

  for (const unsafe of [
    'https://evil.example.com/admin/oauth/authorize',
    `http://${SYNTHETIC_STORE}/admin/oauth/authorize`,
    `https://${SYNTHETIC_STORE}/somewhere/else`,
    `${authorize}&scope=write_orders`,
    authorize.replace('read_all_orders,read_orders,read_products,read_inventory', 'write_orders'),
    authorize.replace('beta.example.test', 'evil.example.test'),
    'javascript:alert(1)',
    42,
  ]) {
    const result = await startShopifyConnection(
      { csrfToken: 'tok', storeText: SYNTHETIC_STORE, callbackUrl },
      fakeFetch(200, { authorizationUrl: unsafe }).fetchImpl,
    );
    assert.deepEqual(result, { ok: false, error: 'unsafe_authorize_url' }, String(unsafe));
  }
  const denied = await startShopifyConnection(
    { csrfToken: 'tok', storeText: SYNTHETIC_STORE, callbackUrl },
    fakeFetch(403, { error: 'pilot_unavailable' }).fetchImpl,
  );
  assert.deepEqual(denied, { ok: false, error: 'pilot_unavailable' });

  assert.deepEqual(
    await disconnectShopify({ csrfToken: 'tok' }, fakeFetch(200, { disconnected: true }).fetchImpl),
    { ok: true },
  );
  assert.equal(
    (await disconnectShopify({ csrfToken: 'tok' }, fakeFetch(200, {}).fetchImpl)).ok,
    false,
  );
});

test('the callback result in the address bar is read once and only if known', () => {
  assert.deepEqual(consumeShopifyReturn({ search: '?shopify=connected', pathname: '/' }), {
    result: 'connected',
    cleanedUrl: '/',
  });
  assert.deepEqual(
    consumeShopifyReturn({ search: '?a=1&shopify=failed', hash: '#x', pathname: '/' }),
    {
      result: 'failed',
      cleanedUrl: '/?a=1#x',
    },
  );
  assert.equal(consumeShopifyReturn({ search: '?shopify=%3Cscript%3E' }).result, '');
  assert.equal(consumeShopifyReturn({ search: '?shopify=connected&shopify=failed' }).result, '');
  assert.deepEqual(consumeShopifyReturn({ search: '' }), { result: '', cleanedUrl: null });
});

// ---- owner page views ----------------------------------------------------------------------------

function panel(store, overrides = {}) {
  return renderStorePanel({
    store,
    storeMessage: '',
    storeTone: 'info',
    shopifyReturn: '',
    confirmDisconnect: false,
    storeAction: '',
    ...overrides,
  });
}

const CONNECTED = {
  status: 'ready',
  connection: {
    state: 'connected',
    store: SYNTHETIC_STORE,
    canConnect: true,
    sync: { state: 'ok' },
  },
  snapshot: syntheticSnapshot(),
};

test('every connection state has an honest panel, and only the connectable ones offer a form', () => {
  const setup = panel({
    status: 'ready',
    connection: { state: 'setup_required', store: '', canConnect: false, sync: null },
    snapshot: null,
  });
  assert.match(setup, /data-store-state="setup_required"/);
  assert.match(setup, /no Shopify app configuration/);
  assert.equal(/<form|<input/.test(setup), false);

  const pilot = panel({
    status: 'ready',
    connection: { state: 'pilot_unavailable', store: '', canConnect: false, sync: null },
    snapshot: null,
  });
  assert.match(pilot, /only a pilot owner/);
  assert.equal(/<form|<input/.test(pilot), false);

  const none = panel({
    status: 'ready',
    connection: { state: 'not_connected', store: SYNTHETIC_STORE, canConnect: true, sync: null },
    snapshot: null,
  });
  assert.match(none, /data-form="connect-shopify"/);
  assert.match(none, new RegExp(`value="${SYNTHETIC_STORE}"`));
  assert.match(none, /Connect Shopify/);
  assert.match(none, /read-only/);

  const reconnect = panel({
    status: 'ready',
    connection: {
      state: 'reconnect_required',
      store: SYNTHETIC_STORE,
      canConnect: true,
      sync: null,
    },
    snapshot: null,
  });
  assert.match(reconnect, /Reconnect Shopify/);
  assert.match(reconnect, /Figures are hidden/);

  const syncing = panel({
    ...CONNECTED,
    snapshot: null,
    connection: { ...CONNECTED.connection, sync: { state: 'loading' } },
  });
  assert.match(syncing, /first read from Shopify is running/);

  const fresh = panel(CONNECTED);
  assert.match(fresh, /Figures updated/);
  assert.match(fresh, /data-action="disconnect-shopify-ask"/);
  assert.equal(fresh.includes('disconnect-shopify-confirm'), false, 'no one-click disconnect');
  const confirming = panel(CONNECTED, { confirmDisconnect: true });
  assert.match(confirming, /disconnect-shopify-confirm/);
  assert.match(confirming, /does not uninstall the app/);

  const stale = panel({
    ...CONNECTED,
    connection: { ...CONNECTED.connection, sync: { state: 'stale' } },
  });
  assert.match(stale, /last successful figures/);
  assert.match(stale, /may be out of date/);
});

test('the return from Shopify is only believed when the server agrees', () => {
  const disconnected = {
    status: 'ready',
    connection: { state: 'not_connected', store: SYNTHETIC_STORE, canConnect: true, sync: null },
    snapshot: null,
  };
  assert.equal(
    panel(disconnected, { shopifyReturn: 'connected' }).includes('approved the connection'),
    false,
  );
  assert.match(panel(CONNECTED, { shopifyReturn: 'connected' }), /approved the connection/);
  const failed = panel(disconnected, { shopifyReturn: 'failed' });
  assert.match(failed, /did not finish/);
  assert.match(failed, /role="alert"/);
});

test('store text is escaped and no credential detail can appear in the panel', () => {
  const hostile = panel(
    {
      status: 'ready',
      connection: { state: 'not_connected', store: SYNTHETIC_STORE, canConnect: true, sync: null },
      snapshot: null,
      draft: '"><script>alert(1)</script>',
    },
    { storeMessage: '<img src=x onerror=alert(1)>', storeTone: 'error' },
  );
  assert.equal(hostile.includes('<script>'), false);
  assert.equal(hostile.includes('<img src=x'), false);
  const loading = panel({ status: 'error', error: 'offline', connection: null, snapshot: null });
  assert.match(loading, /Could not reach the server/);
  assert.match(loading, /refresh-store/);
});

test('the owner board shows real-shaped figures with no demo, live-page or TV controls', () => {
  const session = {
    owner: { email: OWNER },
    workspace: { name: 'My MetricTV', revision: 0, settings: { period: 'week', theme: 'light' } },
    storeConnection: { state: 'connected' },
    csrfToken: 'owner-csrf-token',
  };
  const state = {
    session,
    message: '',
    tone: 'info',
    screens: { status: 'ready', items: [] },
    confirmRevokeId: '',
    screenMessage: '',
    screenTone: 'info',
    store: { ...CONNECTED, snapshot: syntheticSnapshot({ shopName: '<b>Shop</b>' }) },
  };
  const html = renderOwner(state);
  assert.match(html, /class="board/);
  assert.match(html, /Order value/);
  assert.equal(html.includes('<b>Shop</b>'), false, 'shop name is escaped');
  assert.match(html, /owner-page/);
  assert.equal(html.includes('href="#/tv"'), false, 'no TV route on this page');
  assert.equal(html.includes('data-action="definition"'), false);
  assert.match(html, /Order value is the sum of Shopify currentTotalPriceSet/);
  assert.match(html, /<select id="period"/);
  assert.equal(html.includes('owner-csrf-token'), false);
  assert.equal(html.includes('live.html'), false);

  const disconnected = renderOwner({
    ...state,
    store: {
      status: 'ready',
      connection: {
        state: 'reconnect_required',
        store: SYNTHETIC_STORE,
        canConnect: true,
        sync: null,
      },
      snapshot: null,
    },
  });
  assert.equal(disconnected.includes('class="board-heading"'), false, 'figures vanish with access');
});

// ---- TV projection -------------------------------------------------------------------------------

test('the display projection keeps figures and a bare order feed, never links or store identity', () => {
  const snapshot = syntheticSnapshot();
  const projected = projectBoardForDisplay(snapshot, {
    state: 'ok',
    lastSuccessAt: snapshot.fetchedAt,
    errorCode: 'x',
  });
  // Orders reach the TV with number, time, amount and status only.
  assert.equal(projected.recentOrders.length, snapshot.recentOrders.length);
  assert.ok(projected.recentOrders.length > 0, 'the synthetic snapshot has orders');
  for (const order of projected.recentOrders) {
    assert.deepEqual(Object.keys(order).sort(), [
      'amountCents',
      'createdAt',
      'fulfillmentStatus',
      'number',
      'paymentStatus',
    ]);
  }
  assert.equal(projected.recentOrders[0].number, snapshot.recentOrders[0].number);
  assert.deepEqual(projected.sync, { state: 'ok', lastSuccessAt: snapshot.fetchedAt });
  assert.equal(projected.shop.plan, null);
  const text = JSON.stringify(projected);
  for (const forbidden of [SYNTHETIC_STORE, 'myshopify', 'gid://', 'admin.shopify.com', '"url"']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.ok(projected.periods.week);
});

function pairedDisplay(board) {
  return {
    screen: { name: 'Office TV' },
    settings: { period: 'week', theme: 'light' },
    storeConnection: { state: 'connected', sync: board.sync },
    board,
  };
}

test('the TV puts latest orders beside the chart, with alerts, and no brand bar', () => {
  const snapshot = syntheticSnapshot();
  // The server sends at most three grouped alerts.
  const alerts = [1, 2, 3].map((index) => ({
    id: `alert-${index}`,
    title: `Alert ${index}`,
    description: 'Low stock',
  }));
  const board = projectBoardForDisplay({ ...snapshot, attention: alerts }, snapshot.sync);
  const html = renderPaired({
    display: pairedDisplay(board),
    notice: '',
    now: Date.parse(snapshot.fetchedAt),
  });

  assert.match(html, /board-main with-orders/);
  assert.match(html, /Latest orders/);
  assert.match(html, new RegExp(snapshot.recentOrders[0].number));
  assert.equal(/>Payment</.test(html), false);
  assert.equal(/tv-topbar/.test(html), false, 'the brand bar gives its height to the board');
  assert.match(html, /Alert 3/);
  assert.match(html, /<span class="count">3<\/span>/);
});

// ---- the real process ----------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const processOptions = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

function runNode(args, env, { until } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process timed out: ${output}`));
    }, 15_000);
    const onData = (chunk) => {
      output += chunk;
      if (until && output.includes(until)) {
        clearTimeout(timer);
        resolve({ child, output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!until) resolve({ code, output });
    });
  });
}

test(
  'the real beta process refuses partial Shopify settings and starts with complete ones',
  processOptions,
  async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const port = await findFreePort();
    const secret = 'proc-secret-'.padEnd(48, 'z');
    const base = {
      PATH: process.env.PATH,
      BETA_DB_PATH: path.join(directory, 'private', 'beta.sqlite'),
      BETA_AUTH_SECRET: secret,
      BETA_ORIGIN: `http://127.0.0.1:${port}`,
      BETA_PORT: String(port),
    };
    const init = await runNode(
      [path.join(PROJECT_ROOT, 'scripts', 'beta-admin.mjs'), 'init'],
      base,
    );
    assert.equal(init.code, 0, init.output);
    const server = path.join(PROJECT_ROOT, 'server', 'beta', 'beta-server.mjs');

    const partial = await runNode([server], {
      ...base,
      BETA_SHOPIFY_CLIENT_ID: 'synthetic_client_id_0001',
      BETA_SHOPIFY_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    });
    assert.equal(partial.code, 1, 'incomplete settings stop the server');
    assert.match(partial.output, /invalid_connection_config/);
    assert.equal(partial.output.includes(SYNTHETIC_CLIENT_SECRET), false);
    assert.equal(partial.output.includes('synthetic_client_id_0001'), false);

    const grants = path.join(directory, 'grants');
    const complete = {
      ...base,
      ...validEnvironment(grants),
      BETA_SHOPIFY_OWNER_EMAIL: OWNER,
    };
    const running = await runNode([server], complete, { until: 'Shopify store connection' });
    t.after(() => running.child.kill('SIGKILL'));
    assert.match(running.output, /Shopify store connection: configured/);
    for (const secretValue of [SYNTHETIC_CLIENT_SECRET, KEY, grants]) {
      assert.equal(running.output.includes(secretValue), false);
    }
    const anonymous = await httpRequest({
      origin: base.BETA_ORIGIN,
      pathname: '/api/beta/shopify',
    });
    assert.equal(anonymous.status, 401, 'owner session required');
    const callback = await httpRequest({
      origin: base.BETA_ORIGIN,
      pathname: '/auth/beta/shopify/callback?state=x',
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/?shopify=failed');
  },
);
