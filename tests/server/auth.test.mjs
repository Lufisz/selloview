// Invite-only owner authentication against the real Better Auth library and real SQLite files.
// Mail delivery is the expressly synthetic in-memory transport from tests/helpers/app-server.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../../server/accounts/auth.mjs';
import { openInitializedDatabase } from '../../server/accounts/accounts.mjs';
import { DeliveryError, unconfiguredTransport } from '../../server/accounts/mail-transport.mjs';
import {
  createAppEnvironment,
  createBrowser,
  createFailingMailTransport,
  createMemoryMailTransport,
  curlAvailable,
  signInOwner,
  startAppServer,
} from '../helpers/app-server.mjs';

// Real HTTP needs a client outside this process (see tests/helpers/app-server.mjs).
const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

const ALICE = 'alice@example.test';
const STRANGER = 'stranger@example.test';

function countRows(database, table) {
  return database.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get().total;
}

test(
  'an invited owner signs in with a code, sees their workspace and signs out',
  http,
  async (t) => {
    const environment = await createAppEnvironment(t, { invites: [ALICE] });
    const handle = await startAppServer(t, environment);
    const browser = createBrowser(handle.origin);

    const before = await browser.loadSession();
    assert.equal(before.status, 401);

    const sent = await browser.requestCode(ALICE);
    assert.equal(sent.status, 200);
    assert.equal(handle.mailTransport.messages.length, 1);
    const code = handle.mailTransport.lastCodeFor(ALICE);
    assert.match(code, /^\d{6}$/);
    assert.equal(sent.text.includes(code), false, 'the code is never returned to the browser');

    const storedValues = handle.database.prepare('SELECT value FROM verification').all();
    assert.ok(storedValues.length > 0);
    for (const row of storedValues) {
      assert.equal(row.value.includes(code), false, 'the code is stored hashed, not in plain text');
    }

    const signedIn = await browser.verifyCode(ALICE, code);
    assert.equal(signedIn.status, 200);
    assert.deepEqual(signedIn.json, { ok: true });
    assert.equal(signedIn.text.includes('token'), false, 'no session token in the response body');

    const session = await browser.loadSession();
    assert.equal(session.status, 200);
    assert.equal(session.json.owner.email, ALICE);
    assert.deepEqual(session.json.storeConnection, { state: 'setup_required', canConnect: false });
    assert.deepEqual(session.json.workspace.settings, { period: 'week', theme: 'light' });
    assert.equal(Object.hasOwn(session.json, 'metrics'), false);
    assert.equal(session.text.includes(code), false);

    const cookie = [...browser.cookies.keys()][0];
    const loggedOut = await browser.signOut();
    assert.equal(loggedOut.status, 200);
    assert.equal((await browser.loadSession()).status, 401);

    // The old cookie value no longer works even if a browser kept it: the session row is gone.
    assert.ok(cookie.includes('session_token'));
    assert.equal(countRows(handle.database, 'session'), 0);
  },
);

test('session cookie is HttpOnly, SameSite=Strict and expires', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const handle = await startAppServer(t, environment);
  const browser = createBrowser(handle.origin);
  await browser.requestCode(ALICE);
  const response = await browser.verifyCode(ALICE, handle.mailTransport.lastCodeFor(ALICE));
  const cookie = response.headers.getSetCookie().find((entry) => entry.includes('session_token'));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=604800/);
});

test('an https origin makes the session cookie Secure with a __Secure- prefix', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const httpsOrigin = 'https://selloview.example.test';
  const transport = createMemoryMailTransport();
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  const auth = createAuth({
    database,
    secret: environment.secret,
    origin: httpsOrigin,
    mailTransport: transport,
  });
  // Calls Better Auth's real handler directly: no socket is needed to inspect cookie attributes.
  const post = (pathname, body) =>
    auth.handler(
      new Request(`${httpsOrigin}/api/auth${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: httpsOrigin },
        body: JSON.stringify(body),
      }),
    );
  const sent = await post('/email-otp/send-verification-otp', { email: ALICE, type: 'sign-in' });
  assert.equal(sent.status, 200);
  const signedIn = await post('/sign-in/email-otp', {
    email: ALICE,
    otp: transport.lastCodeFor(ALICE),
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.getSetCookie().find((entry) => entry.includes('session_token'));
  assert.match(cookie, /^__Secure-metrictv_beta\.session_token=/);
  assert.match(cookie, /; Secure/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('a code works once: replay, wrong code and expiry are all refused', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const handle = await startAppServer(t, environment);

  const first = createBrowser(handle.origin);
  await first.requestCode(ALICE);
  const code = handle.mailTransport.lastCodeFor(ALICE);
  assert.equal((await first.verifyCode(ALICE, code)).status, 200);

  const replay = createBrowser(handle.origin);
  const replayed = await replay.verifyCode(ALICE, code);
  assert.equal(replayed.status, 400);
  assert.equal(replayed.json.error, 'invalid_code');
  assert.equal((await replay.loadSession()).status, 401);

  const expiring = createBrowser(handle.origin);
  await expiring.requestCode(ALICE);
  const expiringCode = handle.mailTransport.lastCodeFor(ALICE);
  const sample = handle.database.prepare('SELECT expiresAt FROM verification').get();
  const longAgo = typeof sample.expiresAt === 'number' ? 946684800000 : '2000-01-01T00:00:00.000Z';
  handle.database.prepare('UPDATE verification SET expiresAt = ?').run(longAgo);
  const expired = await expiring.verifyCode(ALICE, expiringCode);
  assert.equal(expired.status, 400);
  assert.equal((await expiring.loadSession()).status, 401);
});

test('too many wrong attempts invalidate the code even for the right value', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const handle = await startAppServer(t, environment);
  const browser = createBrowser(handle.origin);
  await browser.requestCode(ALICE);
  const code = handle.mailTransport.lastCodeFor(ALICE);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await browser.verifyCode(ALICE, wrong)).status, 400);
  }
  assert.equal((await browser.verifyCode(ALICE, code)).status, 400);
  assert.equal((await browser.loadSession()).status, 401);
});

test('an email that was never invited gets no code and no account', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const handle = await startAppServer(t, environment);
  const browser = createBrowser(handle.origin);
  const usersBefore = countRows(handle.database, 'user');

  const sent = await browser.requestCode(STRANGER);
  assert.equal(sent.status, 200, 'the response does not reveal who is invited');
  assert.equal(handle.mailTransport.messages.length, 0);

  for (const guess of ['123456', '000000']) {
    const attempt = await browser.verifyCode(STRANGER, guess);
    assert.equal(attempt.status, 400);
  }
  assert.equal(countRows(handle.database, 'user'), usersBefore);
  assert.equal(countRows(handle.database, 'session'), 0);
  assert.equal((await browser.loadSession()).status, 401);
});

test(
  'sign-up and other account endpoints are unavailable over HTTP and inside the library',
  http,
  async (t) => {
    const environment = await createAppEnvironment(t, { invites: [ALICE] });
    const handle = await startAppServer(t, environment);
    const { browser } = await signInOwner(handle, ALICE);
    const usersBefore = countRows(handle.database, 'user');

    const blockedPaths = [
      '/api/auth/sign-up/email',
      '/api/auth/sign-in/email',
      '/api/auth/get-session',
      '/api/auth/update-user',
      '/api/auth/change-email',
      '/api/auth/link-social',
      '/api/auth/list-accounts',
      '/api/auth/list-sessions',
      '/api/auth/revoke-sessions',
      '/api/auth/email-otp/check-verification-otp',
      '/api/auth/email-otp/change-email',
      '/api/auth/email-otp/request-email-change',
      '/api/auth/email-otp/reset-password',
    ];
    for (const pathname of blockedPaths) {
      const result = await browser.request(pathname, {
        method: 'POST',
        body: {
          email: 'new@example.test',
          password: 'correct horse battery',
          name: 'x',
          newEmail: 'n@example.test',
        },
        headers: { 'X-CSRF-Token': browser.csrfToken },
      });
      assert.equal(result.status, 404, pathname);
    }

    // Bypass the HTTP wrapper: the library itself must also refuse.
    const direct = await handle.auth.handler(
      new Request(`${handle.origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: handle.origin },
        body: JSON.stringify({
          email: 'new@example.test',
          password: 'correct horse battery',
          name: 'x',
        }),
      }),
    );
    assert.equal(direct.status, 404);
    assert.equal(countRows(handle.database, 'user'), usersBefore);

    // A runtime auth instance cannot create users even via its internal adapter.
    const { internalAdapter } = await handle.auth.$context;
    let created = null;
    try {
      created = await internalAdapter.createUser({ email: 'sneaky@example.test', name: '' });
    } catch {
      created = null;
    }
    assert.ok(!created?.id, 'runtime auth must not create users');
    assert.equal(countRows(handle.database, 'user'), usersBefore);
  },
);

test('extra sign-in fields cannot set profile data or sign up', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const handle = await startAppServer(t, environment);
  const browser = createBrowser(handle.origin);
  await browser.requestCode(ALICE);
  const code = handle.mailTransport.lastCodeFor(ALICE);
  const result = await browser.request('/api/auth/sign-in/email-otp', {
    method: 'POST',
    body: { email: ALICE, otp: code, name: 'Injected', image: 'https://evil.example/x.png' },
  });
  assert.equal(result.status, 400);
  const row = handle.database.prepare('SELECT name, image FROM "user" WHERE email = ?').get(ALICE);
  assert.equal(row.name, '');
  assert.equal(row.image, null);
});

test('code requests are rate limited and the limit survives a restart', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  let handle = await startAppServer(t, environment);
  const browser = createBrowser(handle.origin);
  const statuses = [];
  for (let request = 0; request < 4; request += 1) {
    statuses.push((await browser.requestCode(ALICE)).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(handle.mailTransport.messages.length, 3);
  assert.ok(countRows(handle.database, 'rateLimit') > 0, 'counters live in SQLite');

  await handle.close();
  handle = await startAppServer(t, environment);
  const afterRestart = await createBrowser(handle.origin).requestCode(ALICE);
  assert.equal(afterRestart.status, 429);
  assert.equal(handle.mailTransport.messages.length, 0);
});

test('code requests from one IPv6 /64 share one allowance', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const handle = await startAppServer(t, environment, { trustedIpHeader: 'x-test-client-ip' });
  const browser = createBrowser(handle.origin);
  const requestCodeFrom = (address) =>
    browser.request('/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      body: { email: ALICE, type: 'sign-in' },
      headers: { 'x-test-client-ip': address },
    });

  // Three code requests a minute per visitor, and three different hosts of one /64 are one visitor.
  const statuses = [];
  for (const host of [1, 2, 3, 4]) {
    statuses.push((await requestCodeFrom(`2001:db8:abcd:12::${host}`)).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal((await requestCodeFrom('2001:db8:abcd:13::1')).status, 200, 'the next /64');
});

test('without a mail provider every address is told so, and no code is stored', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const unconfigured = await startAppServer(t, environment, {
    mailTransport: unconfiguredTransport,
  });

  for (const email of [ALICE, STRANGER]) {
    const noMail = await createBrowser(unconfigured.origin).requestCode(email);
    assert.equal(noMail.status, 503);
    assert.equal(noMail.json.error, 'delivery_not_configured');
  }
  assert.equal(countRows(unconfigured.database, 'verification'), 0);
});

/** Asks for a code for an invited and an uninvited address while sending always fails. */
async function requestCodesWithBrokenProvider(t, sendSignInCode) {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const mailTransport = { configured: true, sendSignInCode };
  const handle = await startAppServer(t, environment, { mailTransport });
  const logged = [];
  t.mock.method(console, 'error', (line) => logged.push(line));

  const invited = await createBrowser(handle.origin).requestCode(ALICE);
  const stranger = await createBrowser(handle.origin).requestCode(STRANGER);
  return { invited, stranger, logged };
}

test(
  'a failing mail provider is logged without details and looks like success to the visitor',
  http,
  async (t) => {
    const { invited, stranger, logged } = await requestCodesWithBrokenProvider(t, async () => {
      throw new DeliveryError('delivery_rejected', `synthetic provider detail for ${ALICE}`);
    });

    assert.equal(invited.status, 200);
    assert.deepEqual(invited.json, stranger.json, 'the reply does not depend on the address');
    assert.equal(logged.length, 1, 'only the invited address had a code to send');
    const entry = JSON.parse(logged[0]);
    assert.equal(entry.event, 'code_delivery_failed');
    assert.equal(entry.code, 'delivery_rejected');
    assert.equal(entry.error, 'DeliveryError');
    assert.equal(logged[0].includes('synthetic'), false, 'no provider detail');
    assert.equal(logged[0].includes(ALICE), false, 'no address');
  },
);

test('an unexpected error while sending is logged by name only', http, async (t) => {
  const { sendSignInCode } = createFailingMailTransport();
  const { invited, logged } = await requestCodesWithBrokenProvider(t, sendSignInCode);

  assert.equal(invited.status, 200);
  assert.equal(logged.length, 1);
  const entry = JSON.parse(logged[0]);
  assert.equal(entry.event, 'code_delivery_failed');
  assert.equal(entry.code, 'unknown');
  assert.equal(entry.error, 'Error');
  assert.equal(logged[0].includes('synthetic'), false, 'no error message');
});

test(
  'a code request does not wait for the mail provider',
  { ...http, timeout: 20_000 },
  async (t) => {
    const environment = await createAppEnvironment(t, { invites: [ALICE] });
    const pendingSends = [];
    const stalled = {
      configured: true,
      sendSignInCode: ({ recipient }) =>
        new Promise((resolve) => pendingSends.push({ recipient, finish: resolve })),
    };
    const handle = await startAppServer(t, environment, { mailTransport: stalled });

    const invited = await createBrowser(handle.origin).requestCode(ALICE);
    const stranger = await createBrowser(handle.origin).requestCode(STRANGER);

    assert.equal(invited.status, 200);
    assert.deepEqual(invited.json, stranger.json);
    assert.deepEqual(
      pendingSends.map((send) => send.recipient),
      [ALICE],
      'the provider was still working on the invited address when the reply came',
    );
    for (const send of pendingSends) send.finish();
  },
);
