// Beta HTTP boundaries: origin and CSRF checks, bounded input, owner isolation, restart
// persistence and separation from the demo server. Real HTTP via curl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoHandler } from '../server.mjs';
import {
  createBetaEnvironment,
  createBrowser,
  curlAvailable,
  httpRequest,
  signInOwner,
  startBetaServer,
} from './beta-helpers.mjs';

// Real HTTP needs a client outside this process (see tests/beta-helpers.mjs).
const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

async function twoSignedInOwners(t) {
  const environment = await createBetaEnvironment(t, { invites: [ALICE, BOB] });
  const handle = await startBetaServer(t, environment);
  const alice = await signInOwner(handle, ALICE);
  const bob = await signInOwner(handle, BOB);
  return { environment, handle, alice, bob };
}

test(
  'two owners get separate workspaces and settings, even when saving at once',
  http,
  async (t) => {
    const { handle, alice, bob } = await twoSignedInOwners(t);
    assert.notEqual(alice.session.workspace.name, undefined);
    const workspaceRows = handle.database.prepare('SELECT id, owner_user_id FROM workspace').all();
    assert.equal(workspaceRows.length, 2);
    assert.notEqual(workspaceRows[0].id, workspaceRows[1].id);

    const [aliceSaved, bobSaved] = await Promise.all([
      alice.browser.saveSettings({ theme: 'dark', period: 'month' }, 0),
      bob.browser.saveSettings({ theme: 'light', period: 'today' }, 0),
    ]);
    assert.equal(aliceSaved.status, 200);
    assert.equal(bobSaved.status, 200);

    const aliceView = (await alice.browser.loadSession()).json;
    const bobView = (await bob.browser.loadSession()).json;
    assert.equal(aliceView.owner.email, ALICE);
    assert.deepEqual(aliceView.workspace.settings, { period: 'month', theme: 'dark' });
    assert.equal(bobView.owner.email, BOB);
    assert.deepEqual(bobView.workspace.settings, { period: 'today', theme: 'light' });
  },
);

test('a caller cannot choose or reach another workspace', http, async (t) => {
  const { alice, bob } = await twoSignedInOwners(t);

  for (const extraKey of ['workspaceId', 'ownerId', 'userId', 'email']) {
    const attempt = await alice.browser.request('/api/beta/settings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': alice.browser.csrfToken },
      body: { settings: { theme: 'dark' }, revision: 0, [extraKey]: bob.session.owner.email },
    });
    assert.equal(attempt.status, 400, extraKey);
  }

  // Bob's CSRF token is bound to Bob's session and is useless on Alice's.
  const crossed = await alice.browser.saveSettings({ theme: 'dark' }, 0, {
    'X-CSRF-Token': bob.browser.csrfToken,
  });
  assert.equal(crossed.status, 403);

  const bobView = (await bob.browser.loadSession()).json;
  assert.deepEqual(bobView.workspace.settings, { period: 'week', theme: 'light' });
  assert.equal(bobView.workspace.revision, 0);
});

test('stale revisions are rejected and show the saved choice', http, async (t) => {
  const { alice } = await twoSignedInOwners(t);
  assert.equal((await alice.browser.saveSettings({ theme: 'dark' }, 0)).status, 200);
  const stale = await alice.browser.saveSettings({ theme: 'light' }, 0);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.settings.theme, 'dark');
  assert.equal(stale.json.revision, 1);
});

test('settings reject invalid values and shapes', http, async (t) => {
  const { alice } = await twoSignedInOwners(t);
  const invalidPayloads = [
    { settings: { theme: 'neon' }, revision: 0 },
    { settings: { period: 'forever' }, revision: 0 },
    { settings: {}, revision: 0 },
    { settings: { theme: 'dark', extra: 1 }, revision: 0 },
    { settings: { theme: 'dark' }, revision: -1 },
    { settings: { theme: 'dark' }, revision: '0' },
    { settings: 'dark', revision: 0 },
  ];
  for (const payload of invalidPayloads) {
    const result = await alice.browser.request('/api/beta/settings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': alice.browser.csrfToken },
      body: payload,
    });
    assert.equal(result.status, 400, JSON.stringify(payload));
  }
  const view = (await alice.browser.loadSession()).json;
  assert.equal(view.workspace.revision, 0);
});

test(
  'state-changing requests need the exact origin, JSON and a session CSRF token',
  http,
  async (t) => {
    const { alice, handle } = await twoSignedInOwners(t);
    const { browser } = alice;
    const settingsBody = { settings: { theme: 'dark' }, revision: 0 };

    const wrongOrigin = await browser.saveSettings({ theme: 'dark' }, 0, {
      Origin: 'https://evil.example',
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.json.error, 'invalid_origin');

    const sameHostDifferentPort = await browser.saveSettings({ theme: 'dark' }, 0, {
      Origin: `http://127.0.0.1:${Number(new URL(handle.origin).port) + 1}`,
    });
    assert.equal(sameHostDifferentPort.status, 403);

    const noOrigin = await httpRequest({
      origin: handle.origin,
      pathname: '/api/beta/settings',
      method: 'POST',
      headerLines: [
        'Content-Type: application/json',
        `Cookie: ${browser.cookieHeader()}`,
        `X-CSRF-Token: ${browser.csrfToken}`,
      ],
      body: JSON.stringify(settingsBody),
    });
    assert.equal(noOrigin.status, 403);

    const duplicateOrigin = await httpRequest({
      origin: handle.origin,
      pathname: '/api/beta/settings',
      method: 'POST',
      headerLines: [
        'Content-Type: application/json',
        `Origin: ${handle.origin}`,
        'Origin: https://evil.example',
        `Cookie: ${browser.cookieHeader()}`,
        `X-CSRF-Token: ${browser.csrfToken}`,
      ],
      body: JSON.stringify(settingsBody),
    });
    assert.equal(duplicateOrigin.status, 403);

    const crossSiteFetch = await browser.saveSettings({ theme: 'dark' }, 0, {
      'Sec-Fetch-Site': 'cross-site',
    });
    assert.equal(crossSiteFetch.status, 403);

    const formContentType = await browser.request('/api/beta/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': browser.csrfToken,
      },
      rawBody: 'theme=dark',
    });
    assert.equal(formContentType.status, 415);

    const missingToken = await browser.request('/api/beta/settings', {
      method: 'POST',
      body: settingsBody,
    });
    assert.equal(missingToken.status, 403);
    assert.equal(missingToken.json.error, 'invalid_csrf');

    const forgedToken = await browser.saveSettings({ theme: 'dark' }, 0, {
      'X-CSRF-Token': 'forged',
    });
    assert.equal(forgedToken.status, 403);

    const unauthenticated = await createBrowser(handle.origin).request('/api/beta/settings', {
      method: 'POST',
      body: settingsBody,
      headers: { 'X-CSRF-Token': browser.csrfToken },
    });
    assert.equal(unauthenticated.status, 401);

    // None of the rejected attempts changed anything.
    assert.equal((await browser.loadSession()).json.workspace.revision, 0);
  },
);

test('sign-in and sign-out also enforce origin, CSRF and body limits', http, async (t) => {
  const { alice, handle } = await twoSignedInOwners(t);
  const anonymous = createBrowser(handle.origin);

  const foreignSignIn = await anonymous.request('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: { email: ALICE, type: 'sign-in' },
  });
  assert.equal(foreignSignIn.status, 403);

  const foreignSignOut = await alice.browser.request('/api/auth/sign-out', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'X-CSRF-Token': alice.browser.csrfToken },
    body: {},
  });
  assert.equal(foreignSignOut.status, 403);

  const noTokenSignOut = await alice.browser.request('/api/auth/sign-out', {
    method: 'POST',
    body: {},
  });
  assert.equal(noTokenSignOut.status, 403);
  assert.equal((await alice.browser.loadSession()).status, 200, 'still signed in');

  const oversized = await anonymous.request('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    rawBody: JSON.stringify({ email: `${'a'.repeat(5000)}@example.test`, type: 'sign-in' }),
  });
  assert.equal(oversized.status, 413);

  const malformed = await anonymous.request('/api/auth/sign-in/email-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    rawBody: '{not json',
  });
  assert.equal(malformed.status, 400);

  const shortCode = await anonymous.verifyCode(ALICE, '12');
  assert.equal(shortCode.status, 400);

  const wrongMethod = await anonymous.request('/api/auth/sign-out');
  assert.equal(wrongMethod.status, 405);
});

test('requests for another Host header are refused', http, async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [ALICE] });
  const handle = await startBetaServer(t, environment);
  const result = await httpRequest({
    origin: handle.origin,
    pathname: '/beta.html',
    headerLines: ['Host: evil.example'],
  });
  assert.equal(result.status, 400);
});

test(
  'sessions and workspaces survive a restart; a second invite creates nothing new',
  http,
  async (t) => {
    const environment = await createBetaEnvironment(t, { invites: [ALICE] });
    let handle = await startBetaServer(t, environment);
    const { browser, session } = await signInOwner(handle, ALICE);
    assert.equal((await browser.saveSettings({ theme: 'dark', period: 'days60' }, 0)).status, 200);
    const workspaceBefore = handle.database.prepare('SELECT id FROM workspace').get().id;
    await handle.close();

    const { inviteOwner, openInitializedDatabase } = await import('../server/beta/accounts.mjs');
    const database = openInitializedDatabase(environment.databasePath);
    const repeated = await inviteOwner({
      database,
      secret: environment.secret,
      origin: environment.origin,
      email: 'ALICE@example.test',
    });
    database.close();
    assert.equal(repeated.alreadyInvited, true);
    assert.equal(repeated.workspaceId, workspaceBefore);

    handle = await startBetaServer(t, environment);
    const afterRestart = await browser.loadSession();
    assert.equal(afterRestart.status, 200, 'the browser cookie is still a valid server session');
    assert.equal(afterRestart.json.owner.email, ALICE);
    assert.deepEqual(afterRestart.json.workspace.settings, { period: 'days60', theme: 'dark' });
    assert.equal(handle.database.prepare('SELECT COUNT(*) AS total FROM workspace').get().total, 1);
    assert.equal(handle.database.prepare('SELECT id FROM workspace').get().id, workspaceBefore);
    assert.ok(session.csrfToken, 'a fresh session view issues a CSRF token');
  },
);

test('revoked sessions stop working immediately', http, async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [ALICE] });
  const handle = await startBetaServer(t, environment);
  const { browser } = await signInOwner(handle, ALICE);
  assert.equal((await browser.loadSession()).status, 200);

  const { revokeOwnerSessions } = await import('../server/beta/accounts.mjs');
  await revokeOwnerSessions({
    database: handle.database,
    secret: environment.secret,
    origin: environment.origin,
    email: ALICE,
  });
  assert.equal((await browser.loadSession()).status, 401);
});

test('an expired session is refused', http, async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [ALICE] });
  const handle = await startBetaServer(t, environment);
  const { browser } = await signInOwner(handle, ALICE);
  const sample = handle.database.prepare('SELECT expiresAt FROM session').get();
  const longAgo = typeof sample.expiresAt === 'number' ? 946684800000 : '2000-01-01T00:00:00.000Z';
  handle.database.prepare('UPDATE session SET expiresAt = ?').run(longAgo);
  assert.equal((await browser.loadSession()).status, 401);
});

test(
  'the beta serves onboarding and a fictional demo, and answers nothing outside its allowlist',
  http,
  async (t) => {
    const environment = await createBetaEnvironment(t, { invites: [ALICE] });
    const handle = await startBetaServer(t, environment);
    const browser = createBrowser(handle.origin);

    for (const allowed of [
      '/',
      '/app',
      '/register',
      '/demo',
      '/landing.css',
      '/fonts/archivo-latin.woff2',
      '/beta.html',
      '/beta.js',
      '/beta.css',
      '/styles.css',
      '/index.html',
      '/data.js',
      '/app.js',
      '/demo-view.js',
    ]) {
      const result = await browser.request(allowed);
      assert.equal(result.status, 200, allowed);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.match(result.headers.get('content-security-policy'), /script-src 'self'/);
    }
    const font = await browser.request('/fonts/archivo-latin.woff2');
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal((await browser.request('/fonts/OFL.txt')).status, 404);
    assert.equal(
      (await browser.request('/fonts/archivo-latin.woff2/../../package.json')).status,
      404,
    );
    // Routes of the removed single-store server stay unanswered, next to the usual attack paths.
    for (const denied of [
      '/live.html',
      '/live.js',
      '/api/snapshot',
      '/api/settings',
      '/api/connection/status',
      '/api/beta/unknown',
      '/package.json',
      '/../package.json',
      '/.env',
    ]) {
      const result = await browser.request(denied);
      assert.ok([400, 404].includes(result.status), `${denied} -> ${result.status}`);
    }
    const landing = (await browser.request('/')).text;
    assert.match(landing, /Your Shopify store,<br\s*\/>on the big screen\./);
    assert.match(landing, /href="\/register"/);
    assert.match((await browser.request('/app')).text, /src="\/beta.js"/);
    assert.match((await browser.request('/register')).text, /src="\/beta.js"/);
    assert.match((await browser.request('/demo')).text, /src="\/app.js"/);
  },
);

test('the demo server does not present the beta files', async () => {
  const handler = createDemoHandler();
  for (const betaPath of ['/beta.html', '/beta.js', '/beta-client.js', '/beta.css']) {
    let status;
    const response = {
      writeHead(code) {
        status = code;
      },
      end() {},
    };
    await handler({ method: 'GET', url: betaPath }, response);
    assert.equal(status, 404, betaPath);
  }
});
