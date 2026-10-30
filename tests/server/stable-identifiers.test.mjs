// Identifiers that are stored on disk, registered outside this repository or held by open browser
// tabs. Renaming any of them signs owners out, unpairs TVs, orphans encrypted Shopify grants or
// breaks the Shopify app configuration, so they stay exactly as they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createAppEnvironment,
  curlAvailable,
  signInOwner,
  startAppServer,
} from '../helpers/app-server.mjs';
import {
  ALICE,
  CALLBACK_PATH,
  SYNTHETIC_STORE,
  beginAuthorization,
  connectOwner,
  createScenario,
  pairTv,
} from '../helpers/shopify-scenario.mjs';
import { SYNTHETIC_CLIENT_ID } from '../helpers/synthetic-shopify.mjs';

const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

test(
  'the owner session cookie keeps its name, so a deployment does not sign owners out',
  http,
  async (t) => {
    const environment = await createAppEnvironment(t, { invites: [ALICE] });
    const handle = await startAppServer(t, environment);
    const { browser } = await signInOwner(handle, ALICE);
    assert.ok(browser.cookies.has('metrictv_beta.session_token'));
  },
);

test(
  'the CSRF token is the HMAC of the session id under the "beta-csrf" label',
  http,
  async (t) => {
    const environment = await createAppEnvironment(t, { invites: [ALICE] });
    const handle = await startAppServer(t, environment);
    const { session } = await signInOwner(handle, ALICE);
    const { id: sessionId } = handle.database.prepare('SELECT id FROM session').get();
    const expected = crypto
      .createHmac('sha256', environment.secret)
      .update(`beta-csrf\n${sessionId}`)
      .digest('base64url');
    assert.equal(session.csrfToken, expected);
  },
);

test('TV cookies and the Shopify callback keep their names and paths', http, async (t) => {
  const scenario = await createScenario(t);
  const { browser } = await scenario.signIn(ALICE);

  const { started } = await beginAuthorization(browser);
  const redirectUri = new URL(started.json.authorizationUrl).searchParams.get('redirect_uri');
  assert.equal(new URL(redirectUri).pathname, '/auth/beta/shopify/callback');
  assert.equal(CALLBACK_PATH, '/auth/beta/shopify/callback');
  const oauthCookieNames = started.headers
    .getSetCookie()
    .map((setCookie) => setCookie.split('=')[0])
    .sort();
  assert.deepEqual(oauthCookieNames, [
    'metrictv_beta_oauth_bind',
    'metrictv_beta_oauth_state',
    'metrictv_beta_oauth_state.sig',
  ]);

  const tv = await pairTv(scenario.handle, browser);
  assert.ok(tv.cookies.has('metrictv_tv_display'));
  const challenge = (await tv.createTvChallenge()).headers.getSetCookie();
  assert.ok(challenge.some((setCookie) => setCookie.startsWith('metrictv_tv_challenge=')));
});

test(
  'a grant file is named after its workspace and decrypts with the documented binding',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { browser } = await scenario.signIn(ALICE);
    await connectOwner(browser);

    const workspaceId = scenario.workspaceId(ALICE);
    assert.deepEqual(await scenario.grantFiles(), [`${workspaceId}.grant.json`]);

    // Rebuilt by hand from the documented layout; a change here orphans every stored grant.
    const envelope = JSON.parse(
      await fs.readFile(path.join(scenario.tokenDirectory, `${workspaceId}.grant.json`), 'utf8'),
    );
    assert.equal(envelope.format, 'metrictv-shopify-token-store');
    assert.equal(envelope.version, 1);
    const associatedData =
      'metrictv-shopify-token-store/v1\n' +
      `client:${SYNTHETIC_CLIENT_ID}\n` +
      `store:${SYNTHETIC_STORE}\n` +
      `workspace:${workspaceId}`;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(scenario.key, 'base64'),
      Buffer.from(envelope.iv, 'base64'),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    assert.equal(JSON.parse(plain.toString('utf8')).shop, SYNTHETIC_STORE);
  },
);

test('the database schema version and table layout are unchanged', http, async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const handle = await startAppServer(t, environment);
  assert.equal(handle.database.prepare('PRAGMA user_version').get().user_version, 3);

  const tables = handle.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const expected of [
    'display_session',
    'pairing_challenge',
    'session',
    'shopify_oauth_attempt',
    'user',
    'workspace',
    'workspace_settings',
    'workspace_store',
  ]) {
    assert.ok(tables.includes(expected), `table ${expected} exists`);
  }
  const columns = tables.flatMap((table) =>
    handle.database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => column.name),
  );
  assert.equal(
    [...tables, ...columns].some((name) => /beta/i.test(name)),
    false,
  );
});
