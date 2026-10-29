// All Shopify responses in this file are SYNTHETIC test doubles injected through fetchImpl.
// Nothing here contacts Shopify, uses real credentials or proves a live OAuth installation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { loadConnectionConfig, createShopifyConnection } from '../server/shopify-connection.mjs';

const STORE = 'synthetic-test-store.myshopify.com';
const ORIGIN = 'https://metrictv.test.example';
const OWNER = 'owner@example.com';
const OTHER_OWNER = 'second-owner@example.com';
const CLIENT_ID = 'synthetic_client_id_0001';
const CLIENT_SECRET = 'synthetic_client_secret_value_0001';
const KEY = crypto.randomBytes(32).toString('base64');
const BROWSER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const SCOPE_TEXT = 'read_all_orders,read_orders,read_products,read_inventory';
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), 'metrictv-conn-'));

after(async () => {
  await fs.rm(SCRATCH, { recursive: true, force: true });
});

function oauthEnv(directory) {
  return {
    SHOPIFY_AUTH_MODE: 'oauth',
    SHOPIFY_CLIENT_ID: CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: CLIENT_SECRET,
    SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY,
    SHOPIFY_TOKEN_STORE_PATH: path.join(directory, 'private', 'grant.json'),
  };
}

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

/** Synthetic Shopify token endpoint. `respond(body, callIndex)` returns {status, json}. */
function createUpstream(respond) {
  const calls = [];
  async function fetchImpl(url, options) {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body });
    const { status = 200, json, delayMs = 0 } = await respond(body, calls.length);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return { fetchImpl, calls };
}

function signedCallbackQuery({
  state,
  shop = STORE,
  code = 'synthetic_code',
  timestamp,
  secret = CLIENT_SECRET,
  includeHost = true,
}) {
  const params = {
    code,
    host: Buffer.from('admin.shopify.com/store/x').toString('base64'),
    shop,
    state,
    timestamp: String(timestamp ?? Math.trunc(Date.now() / 1000)),
  };
  if (!includeHost) delete params.host;
  // Mirrors the SDK's canonical message: sorted keys, URLSearchParams percent-encoding.
  const sorted = Object.keys(params)
    .sort()
    .map((key) => [key, params[key]]);
  const message = new URLSearchParams(sorted).toString().replace(/\+/g, '%20');
  params.hmac = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return new URLSearchParams(params).toString();
}

async function createHarness({
  respond,
  directory,
  env,
  principalHeader = 'x-test-principal',
} = {}) {
  const dir = directory ?? (await fs.mkdtemp(path.join(SCRATCH, 'case-')));
  const config = loadConnectionConfig(env ?? oauthEnv(dir), { store: STORE, origin: ORIGIN });
  const upstream = createUpstream(respond ?? (() => ({ json: tokenResponse() })));
  const clock = { value: Date.now() };
  const changes = { count: 0, events: [] };
  const connection = createShopifyConnection({
    config,
    fetchImpl: upstream.fetchImpl,
    now: () => clock.value,
    onChange: async (event) => {
      changes.count += 1;
      changes.events.push(event);
    },
  });
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://x').pathname;
    const principal = request.headers[principalHeader];
    const handled = await connection.handle(request, response, { pathname, principal });
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });
  const socketPath = path.join(dir, `http-${crypto.randomBytes(3).toString('hex')}.sock`);
  await new Promise((resolve) => server.listen(socketPath, resolve));

  // Real HTTP over a unix socket (loopback TCP is unavailable in some sandboxes).
  function sendRequest({ method, requestPath, headers, payload, rawHeaders }) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath, method, path: requestPath, headers: rawHeaders ?? headers },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const responseHeaders = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
            }
            resolve({
              status: response.statusCode,
              headers: responseHeaders,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }

  async function call(
    method,
    requestPath,
    { principal = OWNER, headers = {}, body, raw, rawHeaders } = {},
  ) {
    const requestHeaders = {
      'x-test-principal': principal,
      'user-agent': BROWSER_AGENT,
      ...headers,
    };
    let payload = raw;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      requestHeaders['content-type'] ??= 'application/json';
    }
    const response = await sendRequest({
      method,
      requestPath,
      headers: requestHeaders,
      payload,
      rawHeaders,
    });
    let json = null;
    try {
      json = JSON.parse(response.text);
    } catch {
      json = null;
    }
    return { response, status: response.status, json, text: response.text };
  }

  async function csrfFor(principal = OWNER) {
    return (await connection.status(principal)).csrfToken;
  }

  async function postJson(requestPath, body, { principal = OWNER, headers = {} } = {}) {
    return call('POST', requestPath, {
      principal,
      body,
      headers: { origin: ORIGIN, 'x-csrf-token': await csrfFor(principal), ...headers },
    });
  }

  async function startAttempt(principal = OWNER) {
    // Spread attempts out so tests that start many do not hit the start rate limit.
    clock.value += 15_000;
    const started = await postJson('/auth/shopify/start', { store: STORE }, { principal });
    assert.equal(started.status, 200, started.text);
    const url = new URL(started.json.authorizationUrl);
    const cookies = started.response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    return { started, state: url.searchParams.get('state'), cookies };
  }

  async function callback(query, cookies, { principal = OWNER, method = 'GET' } = {}) {
    return call(method, `/auth/shopify/callback?${query}`, {
      principal,
      headers: { cookie: cookies },
    });
  }

  async function connect(principal = OWNER) {
    const { state, cookies } = await startAttempt(principal);
    const result = await callback(signedCallbackQuery({ state }), cookies, { principal });
    assert.equal(result.status, 303);
    assert.equal(result.response.headers.get('location'), '/?connection=connected#/connections');
    return result;
  }

  return {
    dir,
    config,
    connection,
    upstream,
    clock,
    changes,
    call,
    csrfFor,
    postJson,
    startAttempt,
    callback,
    connect,
    tokenFile: config.tokenStorePath,
    close: () => new Promise((resolve) => server.close(resolve)),
    newService: () =>
      createShopifyConnection({
        config,
        fetchImpl: upstream.fetchImpl,
        now: () => clock.value,
      }),
  };
}

let harness;
afterEach(async () => {
  if (harness) await harness.close();
  harness = undefined;
});

describe('loadConnectionConfig', () => {
  test('defaults to the CLI pilot and ignores oauth variables', () => {
    const config = loadConnectionConfig({}, { store: STORE, origin: ORIGIN });
    assert.deepEqual({ ...config }, { mode: 'cli', store: STORE, origin: ORIGIN });
    const explicitCli = loadConnectionConfig(
      { SHOPIFY_AUTH_MODE: 'cli', SHOPIFY_CLIENT_ID: '!' },
      { store: STORE, origin: ORIGIN },
    );
    assert.equal(explicitCli.mode, 'cli');
  });

  test('oauth without any settings is a safe setup-required state', () => {
    const config = loadConnectionConfig(
      { SHOPIFY_AUTH_MODE: 'oauth' },
      { store: STORE, origin: ORIGIN },
    );
    assert.deepEqual(
      { ...config },
      { mode: 'oauth', setupRequired: true, store: STORE, origin: ORIGIN },
    );
  });

  test('fails closed on unknown mode, partial, malformed and unsafe settings', async () => {
    const dir = await fs.mkdtemp(path.join(SCRATCH, 'cfg-'));
    const good = oauthEnv(dir);
    const bad = [
      { SHOPIFY_AUTH_MODE: 'OAuth' },
      { ...good, SHOPIFY_CLIENT_SECRET: '' },
      { ...good, SHOPIFY_CLIENT_ID: 'short' },
      { ...good, SHOPIFY_CLIENT_SECRET: 'has space in the secret value' },
      { ...good, SHOPIFY_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(16).toString('base64') },
      { ...good, SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY.replace(/=$/, '') },
      { ...good, SHOPIFY_TOKEN_ENCRYPTION_KEY: ` ${KEY}` },
      { ...good, SHOPIFY_TOKEN_STORE_PATH: 'relative/grant.json' },
      { ...good, SHOPIFY_TOKEN_STORE_PATH: `${dir}/../x/grant.json` },
      {
        ...good,
        SHOPIFY_TOKEN_STORE_PATH: path.resolve(import.meta.dirname, '..', 'data', 'grant.json'),
      },
      {
        ...good,
        SHOPIFY_TOKEN_STORE_PATH: path.resolve(import.meta.dirname, '..', '..tokens', 'grant.json'),
      },
      {
        ...good,
        SHOPIFY_TOKEN_STORE_PATH: path.resolve(import.meta.dirname, '..', 'public', 'grant.json'),
      },
    ];
    for (const env of bad) {
      assert.throws(
        () => loadConnectionConfig(env, { store: STORE, origin: ORIGIN }),
        (error) =>
          error.code === 'invalid_connection_config' &&
          !String(error.message).includes(CLIENT_SECRET),
      );
    }
    for (const origin of [
      'http://metrictv.test.example',
      'https://u:p@metrictv.test.example',
      'https://x.example/path',
      'nonsense',
    ]) {
      assert.throws(() => loadConnectionConfig(good, { store: STORE, origin }), {
        code: 'invalid_connection_config',
      });
    }
    assert.throws(() => loadConnectionConfig(good, { store: 'evil.example.com', origin: ORIGIN }), {
      code: 'invalid_store',
    });
  });

  test('secrets are not enumerable and do not appear in serialized config', async () => {
    const dir = await fs.mkdtemp(path.join(SCRATCH, 'cfg-'));
    const config = loadConnectionConfig(oauthEnv(dir), { store: STORE, origin: ORIGIN });
    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes(CLIENT_SECRET));
    assert.ok(!serialized.includes(KEY));
    assert.ok(!serialized.includes('private'));
    assert.equal(config.clientSecret, CLIENT_SECRET);
  });
});

describe('status and mode gating', () => {
  test('CLI pilot reports cli_pilot, no CSRF token, and rejects both POST actions with 409', async () => {
    harness = await createHarness({ env: {} });
    const status = await harness.call('GET', '/api/connection');
    assert.equal(status.status, 200);
    assert.equal(status.response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(status.json, {
      mode: 'cli',
      state: 'cli_pilot',
      store: STORE,
      scopes: ['read_all_orders', 'read_orders', 'read_products', 'read_inventory'],
      csrfToken: '',
      callbackUrl: `${ORIGIN}/auth/shopify/callback`,
    });
    for (const route of ['/auth/shopify/start', '/api/connection/disconnect']) {
      const result = await harness.call('POST', route, { body: {}, headers: { origin: ORIGIN } });
      assert.equal(result.status, 409);
    }
    assert.equal(harness.upstream.calls.length, 0);
  });

  test('setup-required exposes no secrets or paths and rejects actions with 503', async () => {
    harness = await createHarness({ env: { SHOPIFY_AUTH_MODE: 'oauth' } });
    const status = await harness.call('GET', '/api/connection');
    assert.equal(status.json.state, 'setup_required');
    assert.equal(status.json.csrfToken, '');
    const result = await harness.call('POST', '/auth/shopify/start', { body: { store: STORE } });
    assert.equal(result.status, 503);
    assert.deepEqual(result.json, { error: 'setup_required' });
    const callback = await harness.call('GET', '/auth/shopify/callback');
    assert.equal(callback.status, 503);
    await assert.rejects(harness.connection.getAccessToken(), { code: 'setup_required' });
  });

  test('configured oauth is not_connected with a principal-bound CSRF token', async () => {
    harness = await createHarness();
    const first = await harness.connection.status(OWNER);
    const second = await harness.connection.status(OTHER_OWNER);
    assert.equal(first.state, 'not_connected');
    assert.ok(first.csrfToken.length >= 32);
    assert.notEqual(first.csrfToken, second.csrfToken);
    assert.equal(first.csrfToken, (await harness.connection.status(OWNER)).csrfToken);
    const text = JSON.stringify(first);
    for (const secret of [CLIENT_SECRET, KEY, harness.tokenFile]) assert.ok(!text.includes(secret));
    assert.equal((await harness.connection.status(undefined)).csrfToken, '');
  });

  test('unrelated paths are not handled; status method allowlist and query rejection', async () => {
    harness = await createHarness();
    assert.equal((await harness.call('GET', '/other')).status, 404);
    const post = await harness.call('POST', '/api/connection', { body: {} });
    assert.equal(post.status, 405);
    assert.equal(post.response.headers.get('allow'), 'GET, HEAD');
    assert.equal((await harness.call('GET', '/api/connection?x=1')).status, 400);
    const head = await harness.call('HEAD', '/api/connection');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  });
});

describe('OAuth start', () => {
  test('returns the exact fixed authorize URL and secure state cookies', async () => {
    harness = await createHarness();
    const { started, state } = await harness.startAttempt();
    const url = new URL(started.json.authorizationUrl);
    assert.equal(url.origin, `https://${STORE}`);
    assert.equal(url.pathname, '/admin/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('scope'), SCOPE_TEXT);
    assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/auth/shopify/callback`);
    assert.ok(state.length >= 8);
    const cookies = started.response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const cookie of cookies) {
      assert.match(cookie, /; Secure|;Secure|Secure/i);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=lax/i);
      assert.match(cookie, /path=\/auth\/shopify\/callback/i);
    }
    assert.ok(!started.text.includes(CLIENT_SECRET));
    assert.equal(harness.upstream.calls.length, 0);
  });

  test('rejects missing/wrong CSRF, wrong or missing Origin, other store, bad bodies, duplicate headers', async () => {
    harness = await createHarness();
    const token = await harness.csrfFor();
    const good = { origin: ORIGIN, 'x-csrf-token': token };
    const cases = [
      [{ ...good, 'x-csrf-token': '' }, { store: STORE }, 403],
      [{ ...good, 'x-csrf-token': await harness.csrfFor(OTHER_OWNER) }, { store: STORE }, 403],
      [{ 'x-csrf-token': token }, { store: STORE }, 403],
      [{ ...good, origin: 'https://evil.example' }, { store: STORE }, 403],
      [{ ...good, origin: `${ORIGIN}/` }, { store: STORE }, 403],
      [{ ...good, 'sec-fetch-site': 'cross-site' }, { store: STORE }, 403],
      [good, { store: 'other-store.myshopify.com' }, 400],
      [good, { store: STORE, extra: 1 }, 400],
      [good, {}, 400],
      [good, [STORE], 400],
      [{ ...good, 'content-type': 'text/plain' }, { store: STORE }, 415],
    ];
    for (const [headers, body, status] of cases) {
      const result = await harness.call('POST', '/auth/shopify/start', { body, headers });
      assert.equal(result.status, status, JSON.stringify([headers, body]));
    }
    assert.equal((await harness.call('GET', '/auth/shopify/start')).status, 405);
    const oversized = await harness.call('POST', '/auth/shopify/start', {
      raw: JSON.stringify({ store: STORE, pad: 'x'.repeat(5000) }),
      headers: { ...good, 'content-type': 'application/json' },
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      (
        await harness.call('POST', '/auth/shopify/start', {
          raw: '{nope',
          headers: { ...good, 'content-type': 'application/json' },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await harness.call('POST', '/auth/shopify/start?x=1', {
          body: { store: STORE },
          headers: good,
        })
      ).status,
      400,
    );
    assert.equal(harness.upstream.calls.length, 0);
  });

  test('rejects duplicated security headers', async () => {
    harness = await createHarness();
    const token = await harness.csrfFor();
    const body = JSON.stringify({ store: STORE });
    const result = await harness.call('POST', '/auth/shopify/start', {
      raw: body,
      rawHeaders: [
        'x-test-principal',
        OWNER,
        'Content-Type',
        'application/json',
        'Origin',
        ORIGIN,
        'Origin',
        ORIGIN,
        'X-CSRF-Token',
        token,
        'Content-Length',
        String(Buffer.byteLength(body)),
      ],
    });
    assert.equal(result.status, 400);
  });

  test('rate limits repeated starts and bounds concurrent attempts', async () => {
    harness = await createHarness();
    const statuses = [];
    for (let index = 0; index < 8; index += 1) {
      const result = await harness.postJson(
        '/auth/shopify/start',
        { store: STORE },
        { principal: `owner${index}@example.com` },
      );
      statuses.push(result.status);
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.ok(
      statuses.slice(3).every((status) => status === 429),
      statuses.join(),
    );
    harness.clock.value += 120_000;
    const later = await harness.postJson(
      '/auth/shopify/start',
      { store: STORE },
      { principal: 'owner0@example.com' },
    );
    assert.equal(later.status, 200);
  });
});

describe('OAuth callback', () => {
  test('accepts a correctly signed standalone callback without the optional embedded host', async () => {
    harness = await createHarness();
    const { state, cookies } = await harness.startAttempt();
    const result = await harness.callback(
      signedCallbackQuery({ state, includeHost: false }),
      cookies,
    );
    assert.equal(result.response.headers.get('location'), '/?connection=connected#/connections');
    assert.equal((await harness.connection.status(OWNER)).state, 'connected');
  });

  test('completes with expiring:true, stores an encrypted grant, redirects, clears cookies', async () => {
    harness = await createHarness();
    const { state, cookies } = await harness.startAttempt();
    const result = await harness.callback(signedCallbackQuery({ state }), cookies);
    assert.equal(result.status, 303);
    assert.equal(result.response.headers.get('location'), '/?connection=connected#/connections');
    assert.equal(result.text, '');
    const cleared = result.response.headers.getSetCookie();
    assert.equal(cleared.length, 2);
    assert.ok(cleared.every((cookie) => /Max-Age=0/.test(cookie)));
    assert.equal(harness.upstream.calls.length, 1);
    assert.equal(harness.upstream.calls[0].url, `https://${STORE}/admin/oauth/access_token`);
    assert.equal(harness.upstream.calls[0].body.expiring, '1');
    assert.equal(harness.upstream.calls[0].body.code, 'synthetic_code');
    assert.equal(harness.changes.count, 1);
    assert.equal((await harness.connection.status(OWNER)).state, 'connected');
    assert.equal(await harness.connection.getAccessToken(), 'synthetic_access_1');

    const disk = await fs.readFile(harness.tokenFile, 'utf8');
    assert.ok(!disk.includes('synthetic_access_1'));
    assert.ok(!disk.includes('synthetic_refresh_1'));
    assert.equal((await fs.stat(harness.tokenFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(harness.tokenFile))).mode & 0o777, 0o700);
    const restarted = harness.newService();
    assert.equal((await restarted.status(OWNER)).state, 'connected');
    assert.equal(await restarted.getAccessToken(), 'synthetic_access_1');
  });

  test('a callback is one-use: replay of identical request fails', async () => {
    harness = await createHarness();
    const { state, cookies } = await harness.startAttempt();
    const query = signedCallbackQuery({ state });
    assert.equal(
      (await harness.callback(query, cookies)).response.headers.get('location'),
      '/?connection=connected#/connections',
    );
    const replay = await harness.callback(query, cookies);
    assert.equal(replay.response.headers.get('location'), '/?connection=failed#/connections');
    assert.equal(harness.upstream.calls.length, 1);
  });

  test('rejects unknown state, other principal, other store, wrong HMAC, stale timestamp before any token exchange', async () => {
    harness = await createHarness();
    const failed = '/?connection=failed#/connections';

    let attempt = await harness.startAttempt();
    let result = await harness.callback(
      signedCallbackQuery({ state: 'unknown-state-value' }),
      attempt.cookies,
    );
    assert.equal(result.response.headers.get('location'), failed);

    attempt = await harness.startAttempt();
    result = await harness.callback(
      signedCallbackQuery({ state: attempt.state }),
      attempt.cookies,
      { principal: OTHER_OWNER },
    );
    assert.equal(result.response.headers.get('location'), failed);

    attempt = await harness.startAttempt();
    result = await harness.callback(
      signedCallbackQuery({ state: attempt.state, shop: 'other-store.myshopify.com' }),
      attempt.cookies,
    );
    assert.equal(result.response.headers.get('location'), failed);

    attempt = await harness.startAttempt();
    result = await harness.callback(
      signedCallbackQuery({ state: attempt.state, secret: 'a_different_secret_value_000' }),
      attempt.cookies,
    );
    assert.equal(result.response.headers.get('location'), failed);

    attempt = await harness.startAttempt();
    const staleTime = Math.trunc(Date.now() / 1000) - 3600;
    result = await harness.callback(
      signedCallbackQuery({ state: attempt.state, timestamp: staleTime }),
      attempt.cookies,
    );
    assert.equal(result.response.headers.get('location'), failed);

    attempt = await harness.startAttempt();
    result = await harness.callback(signedCallbackQuery({ state: attempt.state }), '', {});
    assert.equal(result.response.headers.get('location'), failed);

    attempt = await harness.startAttempt();
    const tamperedCookies = attempt.cookies.replace(
      /(shopify_app_state\.sig=)(.)/,
      (_m, prefix, first) => `${prefix}${first === 'A' ? 'B' : 'A'}`,
    );
    result = await harness.callback(signedCallbackQuery({ state: attempt.state }), tamperedCookies);
    assert.equal(result.response.headers.get('location'), failed);

    assert.equal(harness.upstream.calls.length, 0, 'no token exchange before validation');
    assert.equal((await harness.connection.status(OWNER)).state, 'not_connected');
    assert.equal(harness.changes.count, 0);
  });

  test('rejects duplicate, missing, extra and oversized query fields', async () => {
    harness = await createHarness();
    const failed = '/?connection=failed#/connections';
    const queries = [];
    let attempt = await harness.startAttempt();
    const valid = signedCallbackQuery({ state: attempt.state });
    queries.push(`${valid}&state=${attempt.state}`);
    queries.push(`${valid}&code=other`);
    queries.push(`${valid}&extra=1`);
    queries.push(valid.replace(/code=[^&]*&?/, ''));
    queries.push(`${valid}&host=${'a'.repeat(600)}`);
    queries.push('');
    for (const query of queries) {
      attempt = await harness.startAttempt();
      const patched = query.replaceAll(/state=[^&]*/g, (match, offset) =>
        offset >= 0 ? `state=${attempt.state}` : match,
      );
      const result = await harness.callback(patched, attempt.cookies);
      assert.equal(result.response.headers.get('location'), failed, query.slice(0, 80));
    }
    assert.equal(harness.upstream.calls.length, 0);
  });

  test('denied authorization fails safely and consumes the attempt', async () => {
    harness = await createHarness();
    const { state, cookies } = await harness.startAttempt();
    const denied = await harness.callback(
      `error=access_denied&state=${state}&shop=${STORE}`,
      cookies,
    );
    assert.equal(denied.response.headers.get('location'), '/?connection=failed#/connections');
    const afterwards = await harness.callback(signedCallbackQuery({ state }), cookies);
    assert.equal(afterwards.response.headers.get('location'), '/?connection=failed#/connections');
    assert.equal(harness.upstream.calls.length, 0);
  });

  test('HEAD and POST never trigger callback state changes', async () => {
    harness = await createHarness();
    const { state, cookies } = await harness.startAttempt();
    const query = signedCallbackQuery({ state });
    const head = await harness.callback(query, cookies, { method: 'HEAD' });
    assert.equal(head.status, 405);
    assert.equal(head.response.headers.get('allow'), 'GET');
    const post = await harness.call('POST', `/auth/shopify/callback?${query}`, {
      headers: { cookie: cookies },
    });
    assert.equal(post.status, 405);
    assert.equal(harness.upstream.calls.length, 0);
    const ok = await harness.callback(query, cookies);
    assert.equal(ok.response.headers.get('location'), '/?connection=connected#/connections');
  });

  test('rejects broader/write, narrower, online and malformed token data without saving', async () => {
    const bad = [
      tokenResponse({ scope: `${SCOPE_TEXT},write_orders` }),
      tokenResponse({ scope: 'read_orders,read_products' }),
      tokenResponse({ scope: 'read_orders,read_products,read_inventory,read_customers' }),
      tokenResponse({ associated_user: { id: 1 } }),
      tokenResponse({ refresh_token: undefined, refresh_token_expires_in: undefined }),
      tokenResponse({ access_token: 'has space' }),
    ];
    for (const json of bad) {
      harness = await createHarness({ respond: () => ({ json }) });
      const { state, cookies } = await harness.startAttempt();
      const result = await harness.callback(signedCallbackQuery({ state }), cookies);
      assert.equal(
        result.response.headers.get('location'),
        '/?connection=failed#/connections',
        JSON.stringify(json),
      );
      assert.equal((await harness.connection.status(OWNER)).state, 'not_connected');
      await assert.rejects(fs.stat(harness.tokenFile), { code: 'ENOENT' });
      assert.equal(harness.changes.count, 0);
      await harness.close();
      harness = undefined;
    }
  });

  test('upstream exchange failure and non-JSON bodies fail without reflecting content', async () => {
    harness = await createHarness({
      respond: () => ({ status: 500, json: { error: 'SECRET-UPSTREAM-TEXT' } }),
    });
    const { state, cookies } = await harness.startAttempt();
    const result = await harness.callback(signedCallbackQuery({ state }), cookies);
    assert.equal(result.response.headers.get('location'), '/?connection=failed#/connections');
    assert.ok(!JSON.stringify([...result.response.headers]).includes('SECRET-UPSTREAM-TEXT'));
  });

  test('a failed reconnect preserves the previous still-valid grant', async () => {
    let failNext = false;
    harness = await createHarness({
      respond: () =>
        failNext ? { status: 400, json: { error: 'invalid_request' } } : { json: tokenResponse() },
    });
    await harness.connect();
    failNext = true;
    const { state, cookies } = await harness.startAttempt();
    const result = await harness.callback(signedCallbackQuery({ state }), cookies);
    assert.equal(result.response.headers.get('location'), '/?connection=failed#/connections');
    assert.equal((await harness.connection.status(OWNER)).state, 'connected');
    assert.equal(await harness.connection.getAccessToken(), 'synthetic_access_1');
    assert.equal((await harness.newService().status(OWNER)).state, 'connected');
  });

  test('pending attempts expire', async () => {
    harness = await createHarness();
    const { state, cookies } = await harness.startAttempt();
    harness.clock.value += 6 * 60_000;
    const result = await harness.callback(signedCallbackQuery({ state }), cookies);
    assert.equal(result.response.headers.get('location'), '/?connection=failed#/connections');
    assert.equal(harness.upstream.calls.length, 0);
  });
});

describe('access tokens and refresh', () => {
  function rotatingUpstream() {
    return (body, callIndex) => {
      if (body.grant_type === 'refresh_token') {
        return {
          json: tokenResponse({
            access_token: `synthetic_access_${callIndex + 1}`,
            refresh_token: `synthetic_refresh_${callIndex + 1}`,
          }),
          delayMs: 20,
        };
      }
      return { json: tokenResponse() };
    };
  }

  test('returns the current token without network while it is fresh', async () => {
    harness = await createHarness({ respond: rotatingUpstream() });
    await harness.connect();
    harness.clock.value += 30 * 60_000;
    assert.equal(await harness.connection.getAccessToken(), 'synthetic_access_1');
    assert.equal(harness.upstream.calls.length, 1);
  });

  test('refreshes early with singleflight and persists the rotated refresh token', async () => {
    harness = await createHarness({ respond: rotatingUpstream() });
    await harness.connect();
    harness.clock.value += 56 * 60_000;
    const tokens = await Promise.all([1, 2, 3, 4].map(() => harness.connection.getAccessToken()));
    assert.deepEqual(new Set(tokens), new Set(['synthetic_access_3']));
    const refreshCalls = harness.upstream.calls.filter(
      (call) => call.body.grant_type === 'refresh_token',
    );
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].body.refresh_token, 'synthetic_refresh_1');
    assert.equal(refreshCalls[0].body.client_secret, CLIENT_SECRET);
    // A fresh service instance (restart) sees the rotated pair, and the disk stays encrypted.
    const restarted = harness.newService();
    assert.equal(await restarted.getAccessToken(), 'synthetic_access_3');
    const disk = await fs.readFile(harness.tokenFile, 'utf8');
    assert.ok(!disk.includes('synthetic_'));
    await restarted.getAccessToken({ forceRefresh: true });
    assert.equal(
      harness.upstream.calls.at(-1).body.refresh_token,
      'synthetic_refresh_3',
      'rotated token, not the original, is used next',
    );
  });

  test('forceRefresh refreshes a fresh token once, concurrent forced calls share one flight', async () => {
    harness = await createHarness({ respond: rotatingUpstream() });
    await harness.connect();
    const tokens = await Promise.all([
      harness.connection.getAccessToken({ forceRefresh: true }),
      harness.connection.getAccessToken({ forceRefresh: true }),
    ]);
    assert.equal(tokens[0], tokens[1]);
    assert.notEqual(tokens[0], 'synthetic_access_1');
    assert.equal(
      harness.upstream.calls.filter((call) => call.body.grant_type === 'refresh_token').length,
      1,
    );
    assert.equal(await harness.connection.getAccessToken(), tokens[0]);
  });

  test('transient refresh failure keeps credentials; valid token still served, forced refresh throws', async () => {
    let mode = 'ok';
    harness = await createHarness({
      respond: (body) => {
        if (body.grant_type !== 'refresh_token') return { json: tokenResponse() };
        if (mode === 'down') return { status: 503, json: { error: 'unavailable' } };
        return {
          json: tokenResponse({
            access_token: 'synthetic_access_9',
            refresh_token: 'synthetic_refresh_9',
          }),
        };
      },
    });
    await harness.connect();
    mode = 'down';
    harness.clock.value += 58 * 60_000;
    assert.equal(await harness.connection.getAccessToken(), 'synthetic_access_1');
    await assert.rejects(harness.connection.getAccessToken({ forceRefresh: true }), {
      code: 'refresh_unavailable',
    });
    harness.clock.value += 10 * 60_000; // access token now expired
    await assert.rejects(harness.connection.getAccessToken(), { code: 'refresh_unavailable' });
    assert.equal((await harness.connection.status(OWNER)).state, 'connected');
    mode = 'ok';
    assert.equal(await harness.connection.getAccessToken(), 'synthetic_access_9');
  });

  test('revoked/invalid refresh grant requires reauthorization and deletes local credentials', async () => {
    let revoked = false;
    harness = await createHarness({
      respond: (body) =>
        body.grant_type === 'refresh_token' && revoked
          ? { status: 400, json: { error: 'invalid_grant' } }
          : { json: tokenResponse() },
    });
    await harness.connect();
    revoked = true;
    const changesBefore = harness.changes.count;
    await assert.rejects(harness.connection.getAccessToken({ forceRefresh: true }), {
      code: 'reauthorization_required',
    });
    assert.equal((await harness.connection.status(OWNER)).state, 'reconnect_required');
    assert.equal(harness.changes.count, changesBefore + 1);
    await assert.rejects(fs.stat(harness.tokenFile), { code: 'ENOENT' });
    await assert.rejects(harness.connection.getAccessToken(), { code: 'reauthorization_required' });
    // The owner can still start a fresh authorization from reconnect_required.
    revoked = false;
    await harness.connect();
    assert.equal((await harness.connection.status(OWNER)).state, 'connected');
  });

  test('expired refresh token needs reauthorization without a network call', async () => {
    harness = await createHarness({
      respond: () => ({ json: tokenResponse({ refresh_token_expires_in: 7200 }) }),
    });
    await harness.connect();
    harness.clock.value += 3 * 3600_000;
    assert.equal((await harness.connection.status(OWNER)).state, 'reconnect_required');
    await assert.rejects(harness.connection.getAccessToken(), { code: 'reauthorization_required' });
    assert.equal(harness.upstream.calls.length, 1);
  });

  test('disconnect during an in-flight refresh cannot restore credentials', async () => {
    harness = await createHarness({ respond: rotatingUpstream() });
    await harness.connect();
    const pending = harness.connection.getAccessToken({ forceRefresh: true });
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    const disconnected = await harness.postJson('/api/connection/disconnect', {});
    assert.equal(disconnected.status, 200);
    await assert.rejects(pending, { code: 'reauthorization_required' });
    await assert.rejects(fs.stat(harness.tokenFile), { code: 'ENOENT' });
    assert.equal((await harness.connection.status(OWNER)).state, 'not_connected');
    assert.equal((await harness.newService().status(OWNER)).state, 'not_connected');
    await assert.rejects(harness.connection.getAccessToken(), { code: 'reauthorization_required' });
  });

  test('a reconnect during an in-flight refresh wins over the older refresh', async () => {
    harness = await createHarness({ respond: rotatingUpstream() });
    await harness.connect();
    const pending = harness.connection.getAccessToken({ forceRefresh: true });
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    await harness.connect();
    await assert.rejects(pending, { code: 'reauthorization_required' });
    assert.equal(await harness.connection.getAccessToken(), 'synthetic_access_1');
    assert.equal(await harness.newService().getAccessToken(), 'synthetic_access_1');
  });

  test('disconnect during callback exchange cannot create a grant', async () => {
    harness = await createHarness({ respond: () => ({ json: tokenResponse(), delayMs: 40 }) });
    const { state, cookies } = await harness.startAttempt();
    const callbackPromise = harness.callback(signedCallbackQuery({ state }), cookies);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.connection.disconnect();
    const result = await callbackPromise;
    assert.equal(result.response.headers.get('location'), '/?connection=failed#/connections');
    await assert.rejects(fs.stat(harness.tokenFile), { code: 'ENOENT' });
    assert.equal((await harness.connection.status(OWNER)).state, 'not_connected');
  });

  test('markReauthorizationRequired clears credentials, notifies, and is a no-op after disconnect', async () => {
    harness = await createHarness();
    await harness.connect();
    const before = harness.changes.count;
    await harness.connection.markReauthorizationRequired();
    assert.equal(harness.changes.count, before + 1);
    assert.equal((await harness.connection.status(OWNER)).state, 'reconnect_required');
    await assert.rejects(fs.stat(harness.tokenFile), { code: 'ENOENT' });
    await assert.rejects(harness.connection.getAccessToken(), { code: 'reauthorization_required' });

    await harness.connect();
    await harness.connection.disconnect();
    const afterDisconnect = harness.changes.count;
    await harness.connection.markReauthorizationRequired();
    assert.equal(harness.changes.count, afterDisconnect);
    assert.equal((await harness.connection.status(OWNER)).state, 'not_connected');
  });
});

describe('stale failure reports', () => {
  test('markReauthorizationRequired with an outdated token does not revoke a newer grant', async () => {
    harness = await createHarness({
      respond: (body, callIndex) =>
        body.grant_type === 'refresh_token'
          ? {
              json: tokenResponse({
                access_token: 'synthetic_access_new',
                refresh_token: 'synthetic_refresh_new',
              }),
            }
          : { json: tokenResponse({ access_token: `synthetic_access_${callIndex}` }) },
    });
    await harness.connect();
    const failedToken = await harness.connection.getAccessToken();
    const refreshedToken = await harness.connection.getAccessToken({ forceRefresh: true });
    assert.notEqual(refreshedToken, failedToken);
    const changesBefore = harness.changes.count;
    await harness.connection.markReauthorizationRequired({ accessToken: failedToken });
    assert.equal(harness.changes.count, changesBefore);
    assert.equal(await harness.connection.getAccessToken(), refreshedToken);

    // A reconnect replaces the grant as well.
    await harness.connect();
    const reconnectedToken = await harness.connection.getAccessToken();
    await harness.connection.markReauthorizationRequired({ accessToken: refreshedToken });
    assert.equal(await harness.connection.getAccessToken(), reconnectedToken);

    // The matching token does revoke.
    await harness.connection.markReauthorizationRequired({ accessToken: reconnectedToken });
    assert.equal((await harness.connection.status(OWNER)).state, 'reconnect_required');
    await assert.rejects(harness.connection.getAccessToken(), { code: 'reauthorization_required' });
  });

  test('a report waits for an in-flight refresh instead of revoking the grant it is replacing', async () => {
    harness = await createHarness({
      respond: (body) =>
        body.grant_type === 'refresh_token'
          ? {
              json: tokenResponse({
                access_token: 'synthetic_access_new',
                refresh_token: 'synthetic_refresh_new',
              }),
              delayMs: 30,
            }
          : { json: tokenResponse() },
    });
    await harness.connect();
    const failedToken = await harness.connection.getAccessToken();
    const refresh = harness.connection.getAccessToken({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await harness.connection.markReauthorizationRequired({ accessToken: failedToken });
    assert.equal(await refresh, 'synthetic_access_new');
    assert.equal(await harness.connection.getAccessToken(), 'synthetic_access_new');
  });
});

describe('change notifications', () => {
  test('onChange receives only a safe state for connect, disconnect and revocation', async () => {
    harness = await createHarness();
    await harness.connect();
    await harness.connection.disconnect();
    await harness.connect();
    await harness.connection.markReauthorizationRequired();
    assert.deepEqual(harness.changes.events, [
      { state: 'connected' },
      { state: 'not_connected' },
      { state: 'connected' },
      { state: 'reconnect_required' },
    ]);
  });
});

describe('disconnect route', () => {
  test('requires Origin, CSRF and an empty JSON object; deletes only local credentials', async () => {
    harness = await createHarness();
    await harness.connect();
    const token = await harness.csrfFor();
    assert.equal(
      (
        await harness.call('POST', '/api/connection/disconnect', {
          body: {},
          headers: { origin: ORIGIN },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await harness.call('POST', '/api/connection/disconnect', {
          body: {},
          headers: { 'x-csrf-token': token },
        })
      ).status,
      403,
    );
    assert.equal(
      (await harness.postJson('/api/connection/disconnect', { force: true })).status,
      400,
    );
    assert.equal((await harness.call('GET', '/api/connection/disconnect')).status, 405);
    assert.equal((await harness.connection.status(OWNER)).state, 'connected');

    const callsBefore = harness.upstream.calls.length;
    const before = harness.changes.count;
    const result = await harness.postJson('/api/connection/disconnect', {});
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { disconnected: true });
    assert.equal(harness.changes.count, before + 1);
    assert.equal(
      harness.upstream.calls.length,
      callsBefore,
      'no remote uninstall or other Shopify call',
    );
    await assert.rejects(fs.stat(harness.tokenFile), { code: 'ENOENT' });
    assert.equal((await harness.connection.status(OWNER)).state, 'not_connected');
  });

  test('disconnect invalidates pending attempts', async () => {
    harness = await createHarness();
    const { state, cookies } = await harness.startAttempt();
    assert.equal((await harness.postJson('/api/connection/disconnect', {})).status, 200);
    const result = await harness.callback(signedCallbackQuery({ state }), cookies);
    assert.equal(result.response.headers.get('location'), '/?connection=failed#/connections');
    assert.equal(harness.upstream.calls.length, 0);
  });
});

describe('corrupt or mismatched stored credentials', () => {
  test('wrong key fails closed as reconnect_required, never exposing a token, and can be reconnected', async () => {
    harness = await createHarness();
    await harness.connect();
    const wrongKeyEnv = {
      ...oauthEnv(harness.dir),
      SHOPIFY_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    };
    const other = await createHarness({ directory: harness.dir, env: wrongKeyEnv });
    try {
      assert.equal((await other.connection.status(OWNER)).state, 'reconnect_required');
      await assert.rejects(other.connection.getAccessToken(), { code: 'reauthorization_required' });
      await other.connect();
      assert.equal((await other.connection.status(OWNER)).state, 'connected');
    } finally {
      await other.close();
    }
  });

  test('a corrupted file fails closed', async () => {
    harness = await createHarness();
    await harness.connect();
    const text = await fs.readFile(harness.tokenFile, 'utf8');
    const envelope = JSON.parse(text);
    envelope.data = Buffer.from('tampered-ciphertext-bytes').toString('base64');
    await fs.writeFile(harness.tokenFile, JSON.stringify(envelope), { mode: 0o600 });
    const restarted = harness.newService();
    assert.equal((await restarted.status(OWNER)).state, 'reconnect_required');
    await assert.rejects(restarted.getAccessToken(), { code: 'reauthorization_required' });
  });
});
