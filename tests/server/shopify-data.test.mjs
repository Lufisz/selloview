// Workspace-scoped Shopify data: owner dashboard, paired TVs, cache reuse, renewal,
// revocation, restart and disconnect. Real app server and collector over curl; Shopify's
// answers are the SYNTHETIC fixture in synthetic-shopify.mjs, so none of this proves a live
// installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { curlAvailable } from '../helpers/app-server.mjs';
import { createTokenStore } from '../../server/shopify/token-store.mjs';
import { isUsableSnapshot } from '../../public/shared/snapshot-validation.js';
import { renderPaired } from '../../public/tv/tv-view.js';
import {
  ALICE,
  BOB,
  SYNTHETIC_STORE,
  connectOwner,
  createScenario,
  pairTv,
  waitFor,
  waitForSnapshot,
} from '../helpers/shopify-scenario.mjs';
import { SYNTHETIC_CLIENT_ID } from '../helpers/synthetic-shopify.mjs';
import { createBrowser } from '../helpers/app-server.mjs';

const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };
const THREE_MINUTES_MS = 3 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

async function connectedAlice(t) {
  const scenario = await createScenario(t);
  const alice = await scenario.signIn(ALICE);
  await connectOwner(alice.browser);
  const snapshot = await waitForSnapshot(alice.browser);
  return { scenario, alice, snapshot };
}

test(
  'a paired TV gets display-only figures and a bare order feed, and no store identity or admin links',
  http,
  async (t) => {
    const { scenario, alice } = await connectedAlice(t);
    const tv = await pairTv(scenario.handle, alice.browser);
    const display = await tv.loadDisplay();
    assert.equal(display.status, 200);
    assert.equal(display.json.storeConnection.state, 'connected');
    assert.equal(display.json.storeConnection.sync.state, 'ok');

    const { board } = display.json;
    assert.equal(isUsableSnapshot(board, { requireStoreDomain: false }), true);
    assert.equal(isUsableSnapshot(board), false, 'the TV payload has no store domain at all');
    assert.equal(board.shop.name, 'Synthetic Shop');
    assert.deepEqual(Object.keys(board.shop).sort(), [
      'currency',
      'logoVersion',
      'name',
      'plan',
      'timeZone',
    ]);
    assert.ok(board.recentOrders.length > 0, 'the TV gets the latest orders');
    for (const order of board.recentOrders) {
      assert.deepEqual(Object.keys(order).sort(), [
        'amountCents',
        'createdAt',
        'fulfillmentStatus',
        'number',
        'paymentStatus',
      ]);
    }
    for (const item of board.attention) {
      assert.deepEqual(Object.keys(item).sort(), ['description', 'id', 'title']);
    }
    assert.ok(board.periods.week.current.orders > 0, 'real figures from the collector, not zeros');

    for (const forbidden of [
      SYNTHETIC_STORE,
      'myshopify',
      'admin.shopify.com',
      'gid://',
      'synthetic_access',
      'synthetic_refresh',
      ALICE,
      alice.session.csrfToken,
      scenario.workspaceId(ALICE),
      '"url"',
    ]) {
      assert.equal(display.text.includes(forbidden), false, forbidden);
    }

    // Period and theme chosen by the owner reach the TV together with the figures.
    const saved = await alice.browser.saveSettings({ period: 'month', theme: 'dark' }, 0);
    assert.equal(saved.status, 200);
    const updated = await tv.loadDisplay();
    assert.deepEqual(updated.json.settings, { period: 'month', theme: 'dark' });
    const html = renderPaired({
      display: updated.json,
      notice: '',
      now: Date.parse(updated.json.serverTime),
    });
    assert.match(html, /Synthetic Shop/);
    assert.match(html, /dark-board/);
    assert.match(html, /Last 30 full days|Order value/);
    assert.match(html, /Latest orders/, 'orders sit beside the chart on the TV');
    assert.match(html, /with-orders/);
    assert.equal(/>Payment</.test(html), false, 'the TV order list has no payment column');
    assert.equal(/href="[^#"][^"]*"/.test(html.replace(/href="\/(tv)?"/g, '')), false, 'no links');
    assert.equal(/data-action|<select|<button|<input/.test(html), false, 'no controls');
  },
);

test(
  'a paired TV shows the store logo, served by MetricTV, and nobody else can fetch it',
  http,
  async (t) => {
    const { scenario, alice } = await connectedAlice(t);
    const tv = await pairTv(scenario.handle, alice.browser);

    // The logo is read in the background after the first display poll.
    let display;
    await waitFor(
      async () => {
        display = await tv.loadDisplay();
        return typeof display.json.board?.shop.logoVersion === 'string';
      },
      { label: 'logo version' },
    );
    const { logoVersion } = display.json.board.shop;
    assert.match(logoVersion, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(
      display.text.includes('cdn.shopify.com'),
      false,
      'no Shopify address reaches the TV',
    );

    const html = renderPaired({ display: display.json, notice: '', now: Date.now() });
    assert.match(
      html,
      new RegExp(`<img class="board-logo" src="/api/display/logo\\?v=${logoVersion}"`),
    );
    assert.match(html, /alt="Synthetic Shop"/, 'the name stays available to screen readers');

    const logo = await tv.loadLogo(`?v=${logoVersion}`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal(logo.headers.get('cache-control'), 'private, max-age=86400');
    assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
    assert.match(logo.text, /synthetic logo$/);

    // Without a display cookie: refused, like the display data itself.
    const stranger = createBrowser(scenario.handle.origin);
    assert.equal((await stranger.loadLogo()).status, 401);
  },
);

test(
  'two TVs of one workspace share one collector; other workspaces and unlinked ones cost nothing',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const alice = await scenario.signIn(ALICE);
    const bob = await scenario.signIn(BOB);
    const aliceTv = await pairTv(scenario.handle, alice.browser, 'Alice one');
    const secondAliceTv = await pairTv(scenario.handle, alice.browser, 'Alice two');
    const bobTv = await pairTv(scenario.handle, bob.browser, 'Bob TV');

    // Nothing is linked yet: no screen may cause any Shopify traffic.
    for (const tv of [aliceTv, secondAliceTv, bobTv]) {
      const display = await tv.loadDisplay();
      assert.equal(
        display.json.storeConnection.state === 'owner_not_allowed' ||
          display.json.storeConnection.state === 'not_connected',
        true,
      );
      assert.equal('board' in display.json, false);
    }
    assert.equal(scenario.upstream.state.graphqlCalls.length, 0);
    assert.equal(scenario.upstream.state.tokenCalls.length, 0);

    await connectOwner(alice.browser);
    await waitForSnapshot(alice.browser);
    const callsAfterFirstSnapshot = scenario.upstream.state.graphqlCalls.length;
    assert.equal(scenario.upstream.queriesRun('DashboardShop'), 1);

    for (let round = 0; round < 3; round += 1) {
      for (const tv of [aliceTv, secondAliceTv]) {
        const display = await tv.loadDisplay();
        assert.equal(display.json.storeConnection.state, 'connected');
        assert.ok(display.json.board);
      }
      const bobDisplay = await bobTv.loadDisplay();
      assert.equal(bobDisplay.json.storeConnection.state, 'owner_not_allowed');
      assert.equal('board' in bobDisplay.json, false);
    }
    assert.equal(scenario.upstream.state.graphqlCalls.length, callsAfterFirstSnapshot);
    const first = (await aliceTv.loadDisplay()).json.board.fetchedAt;
    const second = (await secondAliceTv.loadDisplay()).json.board.fetchedAt;
    assert.equal(first, second, 'both screens show the same cached read');
  },
);

test(
  'expiring access renews, the rotated grant survives a restart, and the wrong key fails closed',
  http,
  async (t) => {
    const { scenario, alice } = await connectedAlice(t);
    assert.equal(scenario.upstream.state.tokenCalls.length, 1);

    scenario.clock.offsetMs = TWO_HOURS_MS;
    const callsBefore = scenario.upstream.state.graphqlCalls.length;
    await alice.browser.shopifyStatus();
    await waitFor(() => scenario.upstream.state.tokenCalls.length === 2, {
      label: 'token renewal',
    });
    assert.equal(scenario.upstream.state.tokenCalls[1].kind, 'refresh');
    assert.equal(scenario.upstream.state.tokenCalls[1].body.refresh_token, 'synthetic_refresh_1');
    await waitFor(() => scenario.upstream.state.graphqlCalls.length >= callsBefore + 3, {
      label: 'renewed collection',
    });
    const lastCall = scenario.upstream.state.graphqlCalls.at(-1);
    assert.equal(lastCall.accessToken, 'synthetic_access_2');

    // Restart: no new authorization, and the rotated refresh token was persisted before use.
    await scenario.restart();
    // The owner's browser keeps its session across the restart.
    const restarted = await waitForSnapshot(alice.browser);
    assert.equal(restarted.json.connection.state, 'connected');
    assert.equal(scenario.upstream.state.tokenCalls.length, 2, 'no extra exchange or renewal');
    assert.equal(scenario.upstream.state.graphqlCalls.at(-1).accessToken, 'synthetic_access_2');

    // A different encryption key cannot read the grant: reconnect is required, nothing is read.
    const callsBeforeWrongKey = scenario.upstream.state.graphqlCalls.length;
    await scenario.restart({ key: crypto.randomBytes(32).toString('base64') });
    const status = await alice.browser.shopifyStatus();
    assert.equal(status.json.connection.state, 'reconnect_required');
    assert.equal(status.json.snapshot, null);
    await alice.browser.loadSession();
    const tv = await pairTv(scenario.handle, alice.browser);
    const display = await tv.loadDisplay();
    assert.equal(display.json.storeConnection.state, 'reconnect_required');
    assert.equal('board' in display.json, false);
    assert.equal(scenario.upstream.state.graphqlCalls.length, callsBeforeWrongKey);
    assert.equal((await scenario.grantFiles()).length, 1, 'the unreadable file is left alone');

    // The right key brings it back without any new approval.
    await scenario.restart();
    assert.equal((await waitForSnapshot(alice.browser)).json.connection.state, 'connected');
  },
);

test(
  'revoked access clears every figure, survives a restart and can be reconnected',
  http,
  async (t) => {
    const { scenario, alice } = await connectedAlice(t);
    const tv = await pairTv(scenario.handle, alice.browser);
    assert.ok((await tv.loadDisplay()).json.board);

    scenario.upstream.state.graphqlOverride = () => ({ status: 401, json: { errors: 'revoked' } });
    scenario.clock.offsetMs = THREE_MINUTES_MS;
    await alice.browser.shopifyStatus();
    await waitFor(
      async () =>
        (await alice.browser.shopifyStatus()).json.connection.state === 'reconnect_required',
      { label: 'revocation noticed' },
    );
    const status = await alice.browser.shopifyStatus();
    assert.equal(status.json.snapshot, null);
    const display = await tv.loadDisplay();
    assert.equal(display.json.storeConnection.state, 'reconnect_required');
    assert.equal('board' in display.json, false, 'the TV clears its figures when access ends');
    assert.deepEqual(await scenario.grantFiles(), []);
    assert.equal(scenario.link(ALICE).state, 'reconnect_required');

    await scenario.restart();
    const again = alice;
    assert.equal((await again.browser.shopifyStatus()).json.connection.state, 'reconnect_required');

    scenario.upstream.state.graphqlOverride = null;
    const reconnectCalls = scenario.upstream.state.tokenCalls.length;
    await connectOwner(again.browser);
    assert.equal(scenario.upstream.state.tokenCalls.length, reconnectCalls + 1);
    const reconnected = await waitForSnapshot(again.browser);
    assert.equal(reconnected.json.connection.state, 'connected');
    assert.equal(scenario.link(ALICE).state, 'connected');
  },
);

test(
  'a refresh token Shopify refuses ends the connection instead of retrying forever',
  http,
  async (t) => {
    const { scenario, alice } = await connectedAlice(t);
    scenario.upstream.state.tokenOverride = (kind) =>
      kind === 'refresh' ? { status: 400, json: { error: 'invalid_grant' } } : undefined;
    scenario.clock.offsetMs = TWO_HOURS_MS;
    await alice.browser.shopifyStatus();
    await waitFor(
      async () =>
        (await alice.browser.shopifyStatus()).json.connection.state === 'reconnect_required',
      { label: 'refresh refusal noticed' },
    );
    assert.deepEqual(await scenario.grantFiles(), []);
  },
);

test(
  'a failing refresh keeps the last figures but labels them stale on the owner page and the TV',
  http,
  async (t) => {
    const { scenario, alice } = await connectedAlice(t);
    const tv = await pairTv(scenario.handle, alice.browser);
    scenario.upstream.state.graphqlOverride = () => ({ status: 500, json: {} });
    scenario.clock.offsetMs = 6 * 60 * 1000;
    await alice.browser.shopifyStatus();

    const stale = await waitFor(
      async () => {
        const status = await alice.browser.shopifyStatus();
        return status.json.connection.sync.state === 'stale' ? status : null;
      },
      { label: 'stale state' },
    );
    assert.ok(stale.json.snapshot, 'the last good figures stay, honestly labelled');
    assert.equal(stale.json.connection.sync.errorCode, 'api_error');

    const display = await tv.loadDisplay();
    assert.equal(display.json.board.sync.state, 'stale');
    const html = renderPaired({
      display: display.json,
      notice: '',
      now: Date.parse(display.json.serverTime),
    });
    assert.match(html, /Connection interrupted/);
    assert.match(html, /last successful figures/);
  },
);

test('a failed refresh is logged with the workspace and a safe code only', http, async (t) => {
  const { scenario, alice } = await connectedAlice(t);
  const logged = [];
  t.mock.method(console, 'error', (line) => logged.push(line));
  scenario.upstream.state.graphqlOverride = () => ({ status: 500, json: {} });
  scenario.clock.offsetMs = THREE_MINUTES_MS;
  await alice.browser.shopifyStatus();

  await waitFor(() => logged.length > 0, { label: 'the failed refresh is logged' });

  const entry = JSON.parse(logged[0]);
  assert.equal(entry.event, 'refresh_failed');
  assert.equal(entry.workspaceId, scenario.workspaceId(ALICE));
  assert.equal(entry.code, 'api_error');
  assert.deepEqual(Object.keys(entry).sort(), ['code', 'error', 'event', 'time', 'workspaceId']);
  assert.equal(logged[0].includes(ALICE), false, 'no owner email');
  assert.equal(logged[0].includes('synthetic-store'), false, 'no store name');
});

test(
  'disconnect removes the grant, clears every screen and cannot be undone by late work',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const alice = await scenario.signIn(ALICE);

    // A collection is in flight when the owner disconnects.
    const releaseGraphql = scenario.upstream.hold('graphql');
    await connectOwner(alice.browser);
    const tv = await pairTv(scenario.handle, alice.browser);
    await waitFor(() => scenario.upstream.state.graphqlCalls.length === 1, {
      label: 'collection start',
    });
    const disconnected = await alice.browser.disconnectShopify();
    assert.equal(disconnected.status, 200);
    assert.deepEqual(disconnected.json, { disconnected: true });
    releaseGraphql();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const status = await alice.browser.shopifyStatus();
    assert.equal(status.json.connection.state, 'not_connected');
    assert.equal(status.json.snapshot, null, 'the old result was dropped');
    const display = await tv.loadDisplay();
    assert.equal(display.json.storeConnection.state, 'not_connected');
    assert.equal('board' in display.json, false);
    assert.deepEqual(await scenario.grantFiles(), []);
    assert.equal(scenario.link(ALICE), null);

    // The same, with a token renewal in flight.
    await connectOwner(alice.browser);
    await waitForSnapshot(alice.browser);
    const releaseToken = scenario.upstream.hold('token');
    scenario.clock.offsetMs = TWO_HOURS_MS;
    await alice.browser.shopifyStatus();
    await waitFor(() => scenario.upstream.state.tokenCalls.at(-1).kind === 'refresh', {
      label: 'renewal start',
    });
    assert.equal((await alice.browser.disconnectShopify()).status, 200);
    releaseToken();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await scenario.grantFiles(), [], 'a late renewal cannot bring the grant back');
    assert.equal((await alice.browser.shopifyStatus()).json.connection.state, 'not_connected');

    // The store is free again, so a later reconnect works.
    await connectOwner(alice.browser);
    assert.equal(scenario.link(ALICE).state, 'connected');
  },
);

test(
  'a disconnect that cannot remove the grant file says so, and the link and figures are gone anyway',
  http,
  async (t) => {
    const { scenario, alice } = await connectedAlice(t);

    // Fault injection: the disk refuses to remove the encrypted grant file.
    const realUnlink = fs.unlink;
    t.mock.method(fs, 'unlink', async (target) => {
      if (String(target).endsWith('.grant.json')) throw new Error('synthetic disk failure');
      return realUnlink(target);
    });

    const disconnected = await alice.browser.disconnectShopify();
    assert.equal(disconnected.status, 500);
    assert.deepEqual(disconnected.json, { error: 'disconnect_failed' });
    assert.equal(scenario.link(ALICE), null, 'the link is gone');
    const status = await alice.browser.shopifyStatus();
    assert.equal(status.json.connection.state, 'not_connected');
    assert.equal(status.json.snapshot, null, 'the figures are gone');
    assert.equal((await scenario.grantFiles()).length, 1, 'the encrypted file is left behind');
  },
);

test('a grant file is bound to its workspace, app and store', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(await fs.realpath(process.env.TMPDIR ?? '/tmp'), 'grant-bind-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.chmod(directory, 0o700);
  const key = crypto.randomBytes(32);
  const grant = {
    shop: SYNTHETIC_STORE,
    clientId: SYNTHETIC_CLIENT_ID,
    offline: true,
    scopes: ['read_all_orders', 'read_orders', 'read_products', 'read_inventory'],
    accessToken: 'synthetic_access_x',
    accessTokenExpiresAt: Date.now() + 3600_000,
    refreshToken: 'synthetic_refresh_x',
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    savedAt: Date.now(),
  };
  const options = { key, clientId: SYNTHETIC_CLIENT_ID, store: SYNTHETIC_STORE };
  const first = path.join(directory, 'first.grant.json');
  const second = path.join(directory, 'second.grant.json');
  const owner = createTokenStore({ ...options, filePath: first, workspaceId: 'workspace-a' });
  await owner.replace(grant, owner.epoch);
  await fs.copyFile(first, second);
  await fs.chmod(second, 0o600);

  const sameWorkspace = createTokenStore({
    ...options,
    filePath: second,
    workspaceId: 'workspace-a',
  });
  assert.equal((await sameWorkspace.load()).accessToken, 'synthetic_access_x');
  const otherWorkspace = createTokenStore({
    ...options,
    filePath: second,
    workspaceId: 'workspace-b',
  });
  await assert.rejects(otherWorkspace.load(), { code: 'token_store' });
  const privateFlow = createTokenStore({ ...options, filePath: second });
  await assert.rejects(privateFlow.load(), { code: 'token_store' });
});
