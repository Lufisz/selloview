// Workspace-scoped Shopify OAuth for the beta, over real HTTP (curl) against the real beta server.
// Every Shopify answer comes from the SYNTHETIC fixture in synthetic-shopify.mjs: these tests
// prove protocol, binding and failure handling, not a live Shopify installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createBetaEnvironment,
  BROWSER_AGENT,
  createBrowser,
  curlAvailable,
  httpRequest,
  signInOwner,
  startBetaServer,
} from './beta-helpers.mjs';
import { isUsableSnapshot } from '../public/snapshot-validation.js';
import {
  ALICE,
  BOB,
  CALLBACK_PATH,
  SYNTHETIC_STORE,
  beginAuthorization,
  connectOwner,
  createScenario,
  pairTv,
  signedCallbackQuery,
  waitFor,
  waitForSnapshot,
} from './beta-shopify-helpers.mjs';

const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };
const FAILED = '/?shopify=failed';
const CONNECTED = '/?shopify=connected';

function sessionCookieNames(browser) {
  return [...browser.cookies.keys()].filter((name) => name.includes('session_token'));
}

async function assertNothingStored(scenario, email) {
  assert.deepEqual(await scenario.grantFiles(), []);
  assert.equal(scenario.link(email), null);
}

test(
  'without Shopify settings the beta reports setup required and never calls Shopify',
  http,
  async (t) => {
    const environment = await createBetaEnvironment(t, { invites: [ALICE] });
    const handle = await startBetaServer(t, environment);
    const { browser, session } = await signInOwner(handle, ALICE);
    assert.deepEqual(session.storeConnection, { state: 'setup_required', canConnect: false });

    const status = await browser.shopifyStatus();
    assert.deepEqual(status.json, {
      connection: { state: 'setup_required', canConnect: false },
      snapshot: null,
    });
    const started = await browser.startShopify(SYNTHETIC_STORE);
    assert.equal(started.status, 503);
    assert.deepEqual(started.json, { error: 'setup_required' });
    const disconnected = await browser.disconnectShopify();
    assert.equal(disconnected.status, 503);
    const callback = await browser.shopifyCallback(signedCallbackQuery({ state: '1234' }));
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), FAILED);
  },
);

test(
  'the pilot owner connects through OAuth with no SameSite=Strict cookie on the callback',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { browser } = await scenario.signIn(ALICE);

    const before = await browser.shopifyStatus();
    assert.deepEqual(before.json, {
      connection: { state: 'not_connected', store: SYNTHETIC_STORE, canConnect: true },
      snapshot: null,
    });

    const { started, state } = await beginAuthorization(browser);
    const authorizeUrl = new URL(started.json.authorizationUrl);
    assert.equal(authorizeUrl.protocol, 'https:');
    assert.equal(authorizeUrl.host, SYNTHETIC_STORE);
    assert.equal(authorizeUrl.pathname, '/admin/oauth/authorize');
    assert.equal(
      authorizeUrl.searchParams.get('scope'),
      'read_all_orders,read_orders,read_products,read_inventory',
    );
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      `${scenario.environment.origin}${CALLBACK_PATH}`,
    );
    assert.deepEqual(Object.keys(started.json), ['authorizationUrl']);

    // Three short-lived cookies, all scoped to the callback path, none named like the private ones.
    const setCookies = started.headers.getSetCookie();
    assert.equal(setCookies.length, 3);
    for (const setCookie of setCookies) {
      assert.match(setCookie, new RegExp(`Path=${CALLBACK_PATH}(;|$)`));
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.equal(
        /shopify_app_state/.test(setCookie),
        false,
        'no collision with the private flow',
      );
    }

    // What the browser sends when Shopify redirects back: cross-site, so no Strict session cookie.
    const sent = browser.cookieHeader({ pathname: CALLBACK_PATH, crossSite: true });
    for (const name of sessionCookieNames(browser)) assert.equal(sent.includes(name), false);
    assert.equal(sessionCookieNames(browser).length > 0, true);
    const sessionAttributes = browser.attributes.get(sessionCookieNames(browser)[0]);
    assert.equal(sessionAttributes.sameSite.toLowerCase(), 'strict');
    // ...and the owner cookie is not sent to the callback by path either.

    const callback = await browser.shopifyCallback(signedCallbackQuery({ state }));
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), CONNECTED);
    for (const setCookie of callback.headers.getSetCookie()) assert.match(setCookie, /Max-Age=0/);
    assert.equal(scenario.upstream.state.tokenCalls.length, 1);
    assert.equal(scenario.upstream.state.tokenCalls[0].body.code, 'synthetic_code');
    assert.equal(scenario.openAttempts(), 0, 'the attempt was consumed');

    // The grant is stored encrypted under the workspace, with private permissions.
    const workspaceId = scenario.workspaceId(ALICE);
    assert.deepEqual(await scenario.grantFiles(), [`${workspaceId}.grant.json`]);
    const grantPath = path.join(scenario.tokenDirectory, `${workspaceId}.grant.json`);
    assert.equal((await fs.stat(grantPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(scenario.tokenDirectory)).mode & 0o777, 0o700);
    const fileText = await fs.readFile(grantPath, 'utf8');
    for (const secret of ['synthetic_access_1', 'synthetic_refresh_1', SYNTHETIC_STORE]) {
      assert.equal(fileText.includes(secret), false, `grant file must not contain ${secret}`);
    }
    assert.equal(scenario.link(ALICE).state, 'connected');

    // The owner dashboard receives the real collector's validated snapshot.
    const connected = await waitForSnapshot(browser);
    assert.equal(connected.json.connection.state, 'connected');
    assert.equal(isUsableSnapshot(connected.json.snapshot), true);
    assert.equal(connected.json.snapshot.shop.domain, SYNTHETIC_STORE);
    assert.equal(connected.json.snapshot.coverage.historyDays, 130);
    assert.equal(connected.json.snapshot.recentOrders.length, 8);
    for (const name of ['shop', 'orders', 'inventory']) {
      assert.equal(
        scenario.upstream.queriesRun(
          name === 'shop'
            ? 'DashboardShop'
            : name === 'orders'
              ? 'DashboardOrders'
              : 'DashboardInventory',
        ) >= 1,
        true,
        name,
      );
    }

    // No credential detail reaches any response.
    const everything = [before.text, started.text, callback.text, connected.text].join('\n');
    for (const secret of [
      'synthetic_access_',
      'synthetic_refresh_',
      'client_secret',
      'accessToken',
    ]) {
      assert.equal(everything.includes(secret), false, secret);
    }
  },
);

test('a replayed callback and a replayed state fail', http, async (t) => {
  const scenario = await createScenario(t);
  const { browser } = await scenario.signIn(ALICE);
  const { state } = await beginAuthorization(browser);
  // The browser keeps the cookies until the first answer clears them; a replay may still send them.
  const sentCookies = browser.cookieHeader({ pathname: CALLBACK_PATH, crossSite: true });
  const query = signedCallbackQuery({ state });
  const first = await browser.shopifyCallback(query);
  assert.equal(first.headers.get('location'), CONNECTED);

  // A replaying client sends exactly the cookies it captured, not whatever the jar now holds.
  const replay = await httpRequest({
    origin: scenario.environment.origin,
    pathname: `${CALLBACK_PATH}?${query}`,
    headerLines: [`User-Agent: ${BROWSER_AGENT}`, `Cookie: ${sentCookies}`],
  });
  assert.equal(replay.headers.get('location'), FAILED);
  assert.equal(scenario.upstream.state.tokenCalls.length, 1, 'no second code exchange');
});

test(
  'callbacks with a bad signature, shop, cookie, query or timing never connect',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { browser } = await scenario.signIn(ALICE);

    const attempts = [
      {
        label: 'forged HMAC',
        query: (state) => signedCallbackQuery({ state, secret: 'another_secret_value_0000' }),
      },
      {
        label: 'other shop',
        query: (state) => signedCallbackQuery({ state, shop: 'other-store.myshopify.com' }),
      },
      {
        label: 'extra client-supplied tenant field',
        query: (state) => signedCallbackQuery({ state, extra: { workspace: 'someone-else' } }),
      },
      {
        label: 'duplicated state',
        query: (state) => `${signedCallbackQuery({ state })}&state=${state}`,
      },
      {
        label: 'unsigned query',
        query: (state) => `code=x&shop=${SYNTHETIC_STORE}&state=${state}`,
      },
      {
        label: 'authorization error from Shopify',
        query: (state) => `error=access_denied&state=${state}`,
      },
    ];
    for (const attempt of attempts) {
      const { state } = await beginAuthorization(browser);
      const result = await browser.shopifyCallback(attempt.query(state));
      assert.equal(result.headers.get('location'), FAILED, attempt.label);
      await assertNothingStored(scenario, ALICE);
    }
    assert.equal(scenario.upstream.state.tokenCalls.length, 0, 'no code was ever exchanged');
  },
);

test('the binding and SDK state cookies are all required and must be genuine', http, async (t) => {
  const scenario = await createScenario(t);
  const { browser } = await scenario.signIn(ALICE);
  const names = (candidate) => [...browser.cookies.keys()].find((name) => name.includes(candidate));

  async function attemptWithCookies(mutate) {
    const { state } = await beginAuthorization(browser);
    const bindingName = names('oauth_bind');
    const stateName = names('oauth_state');
    const signatureName = names('oauth_state.sig');
    const jar = new Map(
      [bindingName, stateName, signatureName].map((name) => [name, browser.cookies.get(name)]),
    );
    mutate(jar, { bindingName, stateName, signatureName });
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    return httpRequest({
      origin: scenario.environment.origin,
      pathname: `${CALLBACK_PATH}?${signedCallbackQuery({ state })}`,
      headerLines: [`User-Agent: ${BROWSER_AGENT}`, ...(cookie ? [`Cookie: ${cookie}`] : [])],
    });
  }

  const cases = {
    'no cookies at all': (jar) => jar.clear(),
    'missing binding cookie': (jar, c) => jar.delete(c.bindingName),
    'wrong binding cookie': (jar, c) => jar.set(c.bindingName, 'A'.repeat(43)),
    'missing state cookie': (jar, c) => jar.delete(c.stateName),
    'missing signature cookie': (jar, c) => jar.delete(c.signatureName),
    'tampered signature': (jar, c) => jar.set(c.signatureName, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const result = await attemptWithCookies(mutate);
    assert.equal(result.headers.get('location'), FAILED, label);
    await assertNothingStored(scenario, ALICE);
  }
  assert.equal(scenario.upstream.state.tokenCalls.length, 0);
});

test('an expired attempt cannot be completed', http, async (t) => {
  const scenario = await createScenario(t);
  const { browser } = await scenario.signIn(ALICE);
  const { state } = await beginAuthorization(browser);
  scenario.clock.offsetMs = 6 * 60 * 1000;
  const result = await browser.shopifyCallback(signedCallbackQuery({ state }));
  assert.equal(result.headers.get('location'), FAILED);
  await assertNothingStored(scenario, ALICE);
  assert.equal(scenario.upstream.state.tokenCalls.length, 0);
});

test('a token response with other scopes is refused and nothing is stored', http, async (t) => {
  const scenario = await createScenario(t);
  const { browser } = await scenario.signIn(ALICE);
  scenario.upstream.state.scope =
    'read_all_orders,read_orders,read_products,read_inventory,write_orders';
  const { state } = await beginAuthorization(browser);
  const result = await browser.shopifyCallback(signedCallbackQuery({ state }));
  assert.equal(result.headers.get('location'), FAILED);
  await assertNothingStored(scenario, ALICE);
  assert.equal((await browser.shopifyStatus()).json.connection.state, 'not_connected');
});

test(
  'signing out, or revoking the owner, while Shopify approval is pending cancels the finish',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const first = await scenario.signIn(ALICE);

    const { state } = await beginAuthorization(first.browser);
    const signOut = await first.browser.signOut();
    assert.equal(signOut.status, 200);
    const afterSignOut = await first.browser.shopifyCallback(signedCallbackQuery({ state }));
    assert.equal(afterSignOut.headers.get('location'), FAILED);
    await assertNothingStored(scenario, ALICE);
    assert.equal(scenario.upstream.state.tokenCalls.length, 0, 'the code was never exchanged');

    // Operator revocation (beta:revoke) removes every session, which has the same effect.
    const second = await scenario.signIn(ALICE);
    const pending = await beginAuthorization(second.browser);
    scenario.handle.database.prepare('DELETE FROM session').run();
    const afterRevoke = await second.browser.shopifyCallback(
      signedCallbackQuery({ state: pending.state }),
    );
    assert.equal(afterRevoke.headers.get('location'), FAILED);
    await assertNothingStored(scenario, ALICE);
  },
);

test(
  'signing out while the code exchange is in flight leaves no connection behind',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { browser } = await scenario.signIn(ALICE);
    const { state } = await beginAuthorization(browser);

    const release = scenario.upstream.hold('token');
    const inFlight = browser.shopifyCallback(signedCallbackQuery({ state }));
    await waitFor(() => scenario.upstream.state.tokenCalls.length === 1, {
      label: 'exchange start',
    });
    assert.equal((await browser.signOut()).status, 200);
    release();

    const result = await inFlight;
    assert.equal(result.headers.get('location'), FAILED);
    await assertNothingStored(scenario, ALICE);
  },
);

test(
  "another owner never gets a connection, a board or a way in through someone else's attempt",
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const alice = await scenario.signIn(ALICE);
    const bob = await scenario.signIn(BOB);

    await bob.browser.loadSession();
    assert.deepEqual((await bob.browser.shopifyStatus()).json.connection, {
      state: 'pilot_unavailable',
      canConnect: false,
    });
    assert.equal(bob.session.storeConnection.state, 'pilot_unavailable');
    assert.equal(
      'store' in bob.session.storeConnection,
      false,
      'the store name is not shown to others',
    );
    const bobStart = await bob.browser.startShopify(SYNTHETIC_STORE);
    assert.equal(bobStart.status, 403);
    assert.deepEqual(bobStart.json, { error: 'pilot_unavailable' });
    assert.equal((await bob.browser.disconnectShopify()).status, 403);

    await connectOwner(alice.browser);
    await waitForSnapshot(alice.browser);

    // Bob still sees nothing, and neither does a TV paired to Bob.
    const bobStatus = await bob.browser.shopifyStatus();
    assert.equal(bobStatus.json.snapshot, null);
    assert.equal(bobStatus.text.includes('Synthetic Beta Shop'), false);
    const bobTv = await pairTv(scenario.handle, bob.browser, 'Bob TV');
    const bobDisplay = await bobTv.loadDisplay();
    assert.equal(bobDisplay.json.storeConnection.state, 'pilot_unavailable');
    assert.equal('board' in bobDisplay.json, false);
    assert.equal(bobDisplay.text.includes('Synthetic Beta Shop'), false);
    assert.equal(bobDisplay.text.includes(SYNTHETIC_STORE), false);

    // Only Alice's workspace is linked to the store.
    assert.equal(scenario.link(BOB), null);
    assert.equal(scenario.link(ALICE).shop, SYNTHETIC_STORE);

    // An attempt belongs to the session and workspace that started it. Re-pointing it at Bob's
    // session or workspace in the database makes the callback fail.
    const aliceAttempt = await beginAuthorization(alice.browser);
    scenario.handle.database
      .prepare('UPDATE shopify_oauth_attempt SET workspace_id = ?')
      .run(scenario.workspaceId(BOB));
    const mismatch = await alice.browser.shopifyCallback(
      signedCallbackQuery({ state: aliceAttempt.state }),
    );
    assert.equal(mismatch.headers.get('location'), FAILED);
    assert.equal(scenario.link(BOB), null);

    const secondAttempt = await beginAuthorization(alice.browser);
    const bobSessionId = scenario.handle.database
      .prepare(
        'SELECT session.id AS id FROM session JOIN "user" ON "user".id = session.userId WHERE "user".email = ?',
      )
      .get(BOB).id;
    scenario.handle.database
      .prepare('UPDATE shopify_oauth_attempt SET session_id = ?')
      .run(bobSessionId);
    const crossSession = await alice.browser.shopifyCallback(
      signedCallbackQuery({ state: secondAttempt.state }),
    );
    assert.equal(crossSession.headers.get('location'), FAILED);
    assert.equal(scenario.link(BOB), null);
  },
);

test(
  'one store belongs to one workspace: a second owner is refused and the first loses nothing',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const alice = await scenario.signIn(ALICE);
    await connectOwner(alice.browser);
    await waitForSnapshot(alice.browser);

    // The operator makes Bob the pilot owner while Alice's link still exists.
    await scenario.restart({ ownerEmail: BOB });
    const bob = await scenario.signIn(BOB);
    const refused = await bob.browser.startShopify(SYNTHETIC_STORE);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.json, { error: 'store_in_use' });
    assert.equal(scenario.link(BOB), null);

    // Alice is no longer the pilot owner, so her old link yields no data either.
    const aliceAgain = await scenario.signIn(ALICE);
    const status = await aliceAgain.browser.shopifyStatus();
    assert.equal(status.json.connection.state, 'pilot_unavailable');
    assert.equal(status.json.snapshot, null);
  },
);

test(
  'start and disconnect enforce owner session, CSRF, exact origin, JSON and the exact store',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { browser } = await scenario.signIn(ALICE);
    await browser.loadSession();
    const anonymous = createBrowser(scenario.handle.origin);

    const unauthenticated = await anonymous.startShopify(SYNTHETIC_STORE);
    assert.equal(unauthenticated.status, 401, 'no session: refused before anything starts');
    assert.equal((await anonymous.shopifyStatus()).status, 401);
    assert.equal((await anonymous.disconnectShopify()).status, 401);

    assert.equal(
      (await browser.startShopify(SYNTHETIC_STORE, { 'X-CSRF-Token': 'wrong' })).status,
      403,
    );
    assert.equal((await browser.startShopify(SYNTHETIC_STORE, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal(
      (await browser.startShopify(SYNTHETIC_STORE, { Origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal(
      (await browser.startShopify(SYNTHETIC_STORE, { 'Sec-Fetch-Site': 'cross-site' })).status,
      403,
    );
    assert.equal(
      (await browser.startShopify(SYNTHETIC_STORE, { 'Content-Type': 'text/plain' })).status,
      415,
    );
    assert.equal((await browser.disconnectShopify({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await browser.disconnectShopify({ 'X-CSRF-Token': 'wrong' })).status, 403);

    for (const badStore of [
      'Synthetic-Beta-Store.myshopify.com',
      ` ${SYNTHETIC_STORE}`,
      `https://${SYNTHETIC_STORE}`,
      `${SYNTHETIC_STORE}/admin`,
      'evil.example.com',
      '',
      42,
    ]) {
      const result = await browser.startShopify(badStore);
      assert.equal(result.status, 400, JSON.stringify(badStore));
    }
    const otherStore = await browser.startShopify('another-store.myshopify.com');
    assert.equal(otherStore.status, 403);
    assert.deepEqual(otherStore.json, { error: 'store_not_allowed' });

    const extraKeys = await browser.request('/api/beta/shopify/start', {
      method: 'POST',
      body: { store: SYNTHETIC_STORE, workspace: scenario.workspaceId(BOB) },
      headers: { 'X-CSRF-Token': browser.csrfToken },
    });
    assert.equal(extraKeys.status, 400);
    assert.equal(scenario.openAttempts(), 0, 'no refused request left an attempt behind');
    assert.equal(scenario.upstream.state.tokenCalls.length, 0);

    // Starting is rate limited per workspace.
    const codes = [];
    for (let index = 0; index < 8; index += 1) {
      codes.push((await browser.startShopify(SYNTHETIC_STORE)).status);
    }
    assert.deepEqual(codes.slice(0, 6), [200, 200, 200, 200, 200, 200]);
    assert.equal(codes[7], 429);
    assert.equal(scenario.openAttempts(), 1, 'a new start replaces the earlier attempt');
  },
);

test(
  'the removed single-store routes are not served, while the modules the beta pages import are',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const anonymous = createBrowser(scenario.handle.origin);
    for (const forbidden of [
      '/live.html',
      '/live.js',
      '/auth/shopify/callback',
      '/auth/shopify/start',
      '/api/snapshot',
      '/api/connection',
      '/api/settings',
      '/.env',
    ]) {
      const response = await anonymous.request(forbidden);
      assert.equal(response.status, 404, forbidden);
    }
    // Presentation modules the beta pages import are served.
    for (const allowed of [
      '/index.html',
      '/app.js',
      '/data.js',
      '/demo-view.js',
      '/board.js',
      '/live-board-model.js',
      '/snapshot-validation.js',
      '/shopify-authorize-url.js',
      '/beta-store-view.js',
      '/beta-shopify-client.js',
      '/beta-labels.js',
    ]) {
      const response = await anonymous.request(allowed);
      assert.equal(response.status, 200, allowed);
    }
    const wrongMethod = await anonymous.request(CALLBACK_PATH, { method: 'POST', body: {} });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await anonymous.request('/auth/beta/shopify/start')).status, 404);
  },
);

test(
  'the callback cookies cannot reach, or be reached from, the private OAuth path',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { browser } = await scenario.signIn(ALICE);
    await beginAuthorization(browser);
    // A browser applies Path matching: none of the beta flow cookies go to the private callback
    // path, and the private SDK cookie names are never used here.
    assert.equal(browser.cookieHeader({ pathname: '/auth/shopify/callback', crossSite: true }), '');
    assert.equal(
      browser.cookieHeader({ pathname: '/api/beta/shopify', crossSite: false }).includes('oauth'),
      false,
    );
    for (const name of browser.cookies.keys()) assert.notEqual(name, 'shopify_app_state');
  },
);
