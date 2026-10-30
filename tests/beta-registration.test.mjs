// Opt-in self-service registration over real HTTP, real Better Auth and real SQLite.
// Mail delivery is the synthetic in-memory transport from beta-helpers.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../server/accounts/auth.mjs';
import { openInitializedDatabase } from '../server/accounts/accounts.mjs';
import { createBetaServer } from '../server/beta/beta-server.mjs';
import {
  createRegistrationPolicy,
  loadRegistrationConfig,
} from '../server/accounts/registration.mjs';
import { createBetaShopifyService } from '../server/shopify/connection-service.mjs';
import {
  createBetaEnvironment,
  createBrowser,
  createMemoryMailTransport,
  curlAvailable,
  signInOwner,
  startBetaServer,
} from './beta-helpers.mjs';

const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };
const ALICE = 'alice@example.test';

function countUsers(database) {
  return database.prepare('SELECT COUNT(*) AS total FROM "user"').get().total;
}

/** Starts the real server with self-registration enabled at the given cap. */
async function startRegistering(t, environment, maxAccounts) {
  const mailTransport = createMemoryMailTransport();
  const database = openInitializedDatabase(environment.databasePath);
  const registration = createRegistrationPolicy({
    database,
    config: { enabled: true, maxAccounts },
  });
  const auth = createAuth({
    database,
    secret: environment.secret,
    origin: environment.origin,
    mailTransport,
    registration,
  });
  const server = createBetaServer({
    auth,
    database,
    config: { origin: environment.origin, secret: environment.secret },
    mailTransport,
    registration,
    shopify: createBetaShopifyService({
      database,
      config: { status: 'setup_required' },
      origin: environment.origin,
    }),
  });
  await new Promise((resolve) => server.listen(environment.port, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  });
  return { database, mailTransport, origin: environment.origin };
}

test('registration config is closed by default and validates the cap', () => {
  assert.deepEqual(loadRegistrationConfig({}), { enabled: false, maxAccounts: 0 });
  assert.throws(() => loadRegistrationConfig({ BETA_SELF_REGISTRATION: 'yes' }));
  assert.throws(() => loadRegistrationConfig({ BETA_SELF_REGISTRATION: 'enabled' }));
  assert.throws(() =>
    loadRegistrationConfig({
      BETA_SELF_REGISTRATION: 'enabled',
      BETA_REGISTRATION_MAX_ACCOUNTS: '0',
    }),
  );
  assert.deepEqual(
    loadRegistrationConfig({
      BETA_SELF_REGISTRATION: 'enabled',
      BETA_REGISTRATION_MAX_ACCOUNTS: '25',
    }),
    { enabled: true, maxAccounts: 25 },
  );
});

test('by default registration is closed and strangers cannot create accounts', http, async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [ALICE] });
  const handle = await startBetaServer(t, environment);
  const browser = createBrowser(handle.origin);

  const status = await browser.request('/api/beta/registration');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { enabled: false, available: false });

  const sent = await browser.requestCode('new@example.test');
  assert.equal(sent.status, 200);
  assert.equal(handle.mailTransport.messages.length, 0, 'no code is mailed to a stranger');
  const verified = await browser.verifyCode('new@example.test', '123456');
  assert.equal(verified.status, 400);
  assert.equal(countUsers(handle.database), 1);

  // The invited owner still signs in as before.
  const { session } = await signInOwner(handle, ALICE);
  assert.equal(session.owner.email, ALICE);
});

test('a new address becomes an account only after the correct code', http, async (t) => {
  const environment = await createBetaEnvironment(t);
  const handle = await startRegistering(t, environment, 5);
  const email = 'newcomer@example.test';
  const browser = createBrowser(handle.origin);

  const status = await browser.request('/api/beta/registration');
  assert.deepEqual(status.json, { enabled: true, available: true });
  assert.equal(JSON.stringify(status.json).includes('5'), false, 'the cap is not published');

  assert.equal((await browser.requestCode(email)).status, 200);
  assert.equal(countUsers(handle.database), 0, 'requesting a code creates no account');

  const wrong = await browser.verifyCode(email, '000000');
  assert.equal(wrong.status, 400);
  assert.equal(countUsers(handle.database), 0, 'a wrong code creates no account');
  assert.equal((await browser.loadSession()).status, 401);

  const code = handle.mailTransport.lastCodeFor(email);
  const right = await browser.verifyCode(email, code);
  assert.equal(right.status, 200);
  assert.equal(countUsers(handle.database), 1);
  const session = await browser.loadSession();
  assert.equal(session.status, 200);
  assert.equal(session.json.owner.email, email);
  const row = handle.database.prepare('SELECT emailVerified AS verified FROM "user"').get();
  assert.equal(row.verified, 1);
});

test('the account cap holds; existing owners still sign in at the cap', http, async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [ALICE] });
  const handle = await startRegistering(t, environment, 2);

  const first = createBrowser(handle.origin);
  await first.requestCode('one@example.test');
  const firstCode = handle.mailTransport.lastCodeFor('one@example.test');
  assert.equal((await first.verifyCode('one@example.test', firstCode)).status, 200);
  assert.equal(countUsers(handle.database), 2);

  const status = await first.request('/api/beta/registration');
  assert.deepEqual(status.json, { enabled: true, available: false });

  // A third address gets no mail and no account.
  const mailBefore = handle.mailTransport.messages.length;
  const late = createBrowser(handle.origin);
  assert.equal((await late.requestCode('late@example.test')).status, 200);
  assert.equal(handle.mailTransport.messages.length, mailBefore);
  assert.equal((await late.verifyCode('late@example.test', '123456')).status, 400);
  assert.equal(countUsers(handle.database), 2);

  // Existing accounts, invited or self-registered, are unaffected.
  const returning = createBrowser(handle.origin);
  assert.equal((await returning.requestCode(ALICE)).status, 200);
  const aliceCode = handle.mailTransport.lastCodeFor(ALICE);
  assert.equal((await returning.verifyCode(ALICE, aliceCode)).status, 200);
  assert.equal((await returning.loadSession()).json.owner.email, ALICE);
});

test('concurrent verifications cannot exceed the cap', http, async (t) => {
  const environment = await createBetaEnvironment(t);
  const handle = await startRegistering(t, environment, 2);
  const emails = ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test'];
  const browsers = emails.map(() => createBrowser(handle.origin));
  for (const [index, email] of emails.entries()) await browsers[index].requestCode(email);
  await Promise.all(
    emails.map((email, index) =>
      browsers[index].verifyCode(email, handle.mailTransport.lastCodeFor(email)),
    ),
  );
  assert.equal(countUsers(handle.database), 2);
});

test('new-address code requests are bounded per client', http, async (t) => {
  const environment = await createBetaEnvironment(t);
  const handle = await startRegistering(t, environment, 100);
  const browser = createBrowser(handle.origin);
  const statuses = [];
  for (let index = 0; index < 7; index += 1) {
    const result = await browser.requestCode(`user${index}@example.test`);
    statuses.push(result.status);
  }
  assert.ok(statuses.includes(429));
  assert.ok(handle.mailTransport.messages.length <= 5);
});
