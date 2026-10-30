// All upstream responses in these tests are explicitly synthetic transport fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyFetch } from '../server/shopify/http.mjs';
import { createAdminRunner } from '../server/shopify/admin-runner.mjs';
import { API_VERSION, QUERIES } from '../server/shopify/shop-data.mjs';

const STORE = 'synthetic-store.myshopify.com';
const TOKEN_URL = `https://${STORE}/admin/oauth/access_token`;
const GRAPHQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function connectionStub() {
  return {
    requests: [],
    revoked: false,
    async getAccessToken(options) {
      this.requests.push(options);
      return options.forceRefresh ? 'synthetic-rotated-token' : 'synthetic-access-token';
    },
    async markReauthorizationRequired() {
      this.revoked = true;
    },
  };
}

test('Shopify transport confines all requests to the configured store and fixed endpoints', async () => {
  let calls = 0;
  const run = createShopifyFetch({
    store: STORE,
    fetchImpl: async () => {
      calls++;
      return jsonResponse({});
    },
  });
  const rejected = [
    'http://' + STORE + '/admin/oauth/access_token',
    'https://other.myshopify.com/admin/oauth/access_token',
    'https://' + STORE + '.evil.example/admin/oauth/access_token',
    'https://secret@' + STORE + '/admin/oauth/access_token',
    TOKEN_URL + '?unexpected=1',
    `https://${STORE}/admin/other`,
    `https://${STORE}:444/admin/oauth/access_token`,
  ];
  for (const address of rejected) await assert.rejects(run(address, { method: 'POST' }));
  await assert.rejects(run(TOKEN_URL, { method: 'GET' }));
  assert.equal(calls, 0);
  await run(TOKEN_URL, { method: 'POST' });
  await run(GRAPHQL_URL, { method: 'POST' });
  assert.equal(calls, 2);
});

test('Shopify transport forbids redirects and omits ambient credentials', async () => {
  const run = createShopifyFetch({
    store: STORE,
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      return new Response('', { status: 302, headers: { Location: 'https://evil.example' } });
    },
  });
  await assert.rejects(run(TOKEN_URL, { method: 'POST' }), { code: 'api_error' });
});

test('Shopify transport bounds both advertised and streamed response bytes', async () => {
  for (const headers of [{}, { 'Content-Length': '1000' }]) {
    const run = createShopifyFetch({
      store: STORE,
      maxBytes: 8,
      fetchImpl: async () => new Response('too many response bytes', { headers }),
    });
    await assert.rejects(run(TOKEN_URL, { method: 'POST' }), { code: 'api_response_too_large' });
  }
});

test('Shopify transport times out stalled streams and cancels the read', async () => {
  let cancelled = false;
  const run = createShopifyFetch({
    store: STORE,
    timeoutMs: 10,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(run(TOKEN_URL, { method: 'POST' }), { code: 'api_timeout' });
  assert.equal(cancelled, true);
});

test('Shopify transport hides raw network errors and strips decoded-body headers', async () => {
  const failing = createShopifyFetch({
    store: STORE,
    fetchImpl: async () => {
      throw new Error('synthetic-secret');
    },
  });
  await assert.rejects(failing(TOKEN_URL, { method: 'POST' }), { message: 'api_error' });
  const run = createShopifyFetch({
    store: STORE,
    fetchImpl: async () =>
      jsonResponse({ ok: true }, 200, {
        'Content-Encoding': 'gzip',
        'Set-Cookie': 'unwanted=value',
      }),
  });
  const response = await run(TOKEN_URL, { method: 'POST' });
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { ok: true });
});

test('Admin runner sends only fixed read queries and the server-side access token', async () => {
  const connection = connectionStub();
  let calls = 0;
  const run = createAdminRunner({
    store: STORE,
    connection,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, GRAPHQL_URL);
      assert.equal(options.headers['X-Shopify-Access-Token'], 'synthetic-access-token');
      assert.equal(JSON.parse(options.body).query, QUERIES.shop);
      return jsonResponse({ data: { shop: { name: 'Synthetic' } } });
    },
  });
  // The name must be one of the runner's own fixed queries, whatever shape it arrives in.
  for (const name of [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'mutation',
    '',
    undefined,
    null,
    5,
    ['shop'],
    { toString: () => 'shop' },
  ]) {
    await assert.rejects(run(name), { code: 'unknown_query' }, String(name));
  }
  assert.equal(calls, 0);
  assert.deepEqual(connection.requests, [], 'no token is fetched for an unknown query');
  assert.deepEqual(await run('shop'), { shop: { name: 'Synthetic' } });
  assert.equal(calls, 1);
});

test('Admin runner runs each fixed query with its own text', async () => {
  const sentQueries = [];
  const run = createAdminRunner({
    store: STORE,
    connection: connectionStub(),
    fetchImpl: async (url, options) => {
      sentQueries.push(JSON.parse(options.body).query);
      return jsonResponse({ data: {} });
    },
  });
  for (const name of Object.keys(QUERIES)) await run(name);
  assert.deepEqual(sentQueries, Object.values(QUERIES));
});

test('Admin runner sends nothing when the access token is unusable', async () => {
  for (const token of ['', undefined, null, 5, 'x'.repeat(16385)]) {
    let requests = 0;
    const run = createAdminRunner({
      store: STORE,
      connection: { getAccessToken: async () => token },
      fetchImpl: async () => {
        requests++;
        return jsonResponse({ data: {} });
      },
    });
    await assert.rejects(
      run('shop'),
      { code: 'reauthorization_required' },
      String(token).slice(0, 20),
    );
    assert.equal(requests, 0);
  }
});

test('Admin runner refreshes once after 401 and uses the newly rotated token', async () => {
  const connection = connectionStub();
  let calls = 0;
  const run = createAdminRunner({
    store: STORE,
    connection,
    fetchImpl: async (url, options) => {
      calls++;
      if (calls === 1) return jsonResponse({}, 401);
      assert.equal(options.headers['X-Shopify-Access-Token'], 'synthetic-rotated-token');
      return jsonResponse({ data: { shop: {} } });
    },
  });
  await run('shop');
  assert.deepEqual(connection.requests, [{ forceRefresh: false }, { forceRefresh: true }]);
  assert.equal(connection.revoked, false);
});

test('Admin runner fails closed on revoked credentials or GraphQL access denial', async () => {
  for (const status of [401, 403, 200]) {
    const connection = connectionStub();
    const run = createAdminRunner({
      store: STORE,
      connection,
      fetchImpl: async () =>
        jsonResponse({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] }, status),
    });
    await assert.rejects(run('shop'), { code: 'reauthorization_required' });
    assert.equal(connection.revoked, true);
  }
});

test('Admin runner rejects failed/malformed/version-mismatched replies without exposing raw errors', async () => {
  const responses = [
    jsonResponse({ syntheticSecret: 'never surface' }, 500),
    new Response('not json'),
    jsonResponse({ data: { shop: {} } }, 200, { 'X-Shopify-API-Version': '2025-01' }),
    jsonResponse({ errors: [{ message: 'synthetic-secret' }] }),
  ];
  for (const response of responses) {
    const run = createAdminRunner({
      store: STORE,
      connection: connectionStub(),
      fetchImpl: async () => response,
    });
    await assert.rejects(run('shop'), (error) => !error.message.includes('synthetic-secret'));
  }
});
