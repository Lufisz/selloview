// The start of the connect flow, with the SDK replaced by a synthetic stand-in: nothing here
// contacts Shopify. The OAuth suite covers the whole round trip over HTTP; this file covers what
// the flow does when the SDK refuses, fails or answers with anything but the fixed redirect.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openInitializedDatabase } from '../../server/accounts/accounts.mjs';
import { SHOPIFY_CALLBACK_PATH, createConnectFlow } from '../../server/shopify/connect-flow.mjs';
import { STATE_COOKIE_NAMES } from '../../server/shopify/sdk.mjs';
import { REQUIRED_SCOPES } from '../../server/shopify/token-store.mjs';
import { createAppEnvironment } from '../helpers/app-server.mjs';
import { SYNTHETIC_CLIENT_ID, SYNTHETIC_STORE } from '../helpers/synthetic-shopify.mjs';

const OWNER_EMAIL = 'owner@example.test';
const ORIGIN = 'https://selloview.test.example';

// What the SDK answers to a start: a redirect to Shopify's authorize URL for our app and store,
// and the two signed cookies that go with its state.
function authorizationRedirect({
  host = SYNTHETIC_STORE,
  withStateCookies = true,
  status = 302,
} = {}) {
  const location = new URL(`https://${host}/admin/oauth/authorize`);
  location.searchParams.set('client_id', SYNTHETIC_CLIENT_ID);
  location.searchParams.set('scope', REQUIRED_SCOPES.join(','));
  location.searchParams.set('redirect_uri', `${ORIGIN}${SHOPIFY_CALLBACK_PATH}`);
  location.searchParams.set('state', 'synthetic-state-1');
  const headers = new Headers({ location: location.href });
  if (withStateCookies) {
    for (const cookieName of STATE_COOKIE_NAMES) {
      headers.append('set-cookie', `${cookieName}=synthetic-value; Path=/; HttpOnly`);
    }
  }
  return new Response(null, { status, headers });
}

async function startFlowWith(t, sdkAnswer) {
  const environment = await createAppEnvironment(t, { invites: [OWNER_EMAIL] });
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  const owner = database
    .prepare(
      `SELECT workspace.id AS workspaceId, "user".id AS userId FROM workspace
         JOIN "user" ON "user".id = workspace.owner_user_id WHERE "user".email = ?`,
    )
    .get(OWNER_EMAIL);
  const flow = createConnectFlow({
    database,
    config: { store: SYNTHETIC_STORE, clientId: SYNTHETIC_CLIENT_ID },
    origin: ORIGIN,
    isReady: true,
    isAllowedOwner: () => true,
    shopify: { auth: { begin: async () => sdkAnswer() } },
    boundedFetch: async () => {
      throw new Error('the SDK stand-in makes no requests');
    },
    runtimes: null,
    now: Date.now,
  });
  const begin = () =>
    flow.begin({
      workspaceId: owner.workspaceId,
      owner: { id: owner.userId, email: OWNER_EMAIL },
      sessionId: 'synthetic-session',
      userAgent: 'Mozilla/5.0 (synthetic)',
      store: SYNTHETIC_STORE,
    });
  const countAttempts = () =>
    database.prepare('SELECT COUNT(*) AS total FROM shopify_oauth_attempt').get().total;
  return { begin, countAttempts };
}

test('a start with the expected SDK answer hands out the store URL and three private cookies', async (t) => {
  const { begin, countAttempts } = await startFlowWith(t, () => authorizationRedirect());

  const result = await begin();

  assert.equal(result.status, 'ok');
  assert.equal(new URL(result.authorizationUrl).host, SYNTHETIC_STORE);
  assert.equal(result.cookies.length, 3);
  for (const cookie of result.cookies) {
    assert.match(cookie, /^__Secure-metrictv_beta_oauth_/);
    assert.match(cookie, /; Path=\/auth\/beta\/shopify\/callback; HttpOnly; SameSite=Lax;/);
    assert.match(cookie, /; Secure$/);
  }
  assert.equal(countAttempts(), 1);
});

const UNUSABLE_ANSWERS = {
  'the SDK throws': () => {
    throw new Error('synthetic SDK failure');
  },
  'it answers with a page instead of a redirect': () => authorizationRedirect({ status: 200 }),
  'it redirects to another host': () => authorizationRedirect({ host: 'evil.example' }),
  'it sends no state cookies': () => authorizationRedirect({ withStateCookies: false }),
};

for (const [description, sdkAnswer] of Object.entries(UNUSABLE_ANSWERS)) {
  test(`a start fails, and records no attempt, when ${description}`, async (t) => {
    const { begin, countAttempts } = await startFlowWith(t, sdkAnswer);

    assert.deepEqual(await begin(), { status: 'start_failed' });
    assert.equal(countAttempts(), 0);
  });
}

test('a start reports an unsupported client when the SDK refuses the browser', async (t) => {
  const { begin, countAttempts } = await startFlowWith(
    t,
    () => new Response(null, { status: 410 }),
  );

  assert.deepEqual(await begin(), { status: 'unsupported_client' });
  assert.equal(countAttempts(), 0);
});
