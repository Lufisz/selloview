// Synthetic values only: no real Shopify credentials or responses appear in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardedHeaders,
  grantFromSession,
  hasExactCallbackFields,
  MAX_QUERY_VALUE_LENGTH,
  parseAuthorizationUrl,
  parseQuery,
} from '../../server/shopify/sdk.mjs';
import { REQUIRED_SCOPES } from '../../server/shopify/token-store.mjs';

const STORE = 'synthetic-test-store.myshopify.com';
const CLIENT_ID = 'synthetic_client_id_0001';
const CALLBACK_URL = 'https://selloview.test.example/auth/callback';
const expected = { store: STORE, clientId: CLIENT_ID, callbackUrl: CALLBACK_URL };

function authorizeUrl(changes = {}) {
  const url = new URL(`https://${STORE}/admin/oauth/authorize`);
  const parameters = {
    client_id: CLIENT_ID,
    scope: REQUIRED_SCOPES.join(','),
    redirect_uri: CALLBACK_URL,
    state: 'synthetic-state-value',
    ...changes,
  };
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.href;
}

test('the SDK redirect is accepted only when it is the fixed authorize URL for our app and store', () => {
  const accepted = parseAuthorizationUrl(authorizeUrl(), expected);
  assert.equal(accepted.state, 'synthetic-state-value');
  assert.equal(accepted.href, authorizeUrl());

  const rejected = [
    'not a url',
    authorizeUrl().replace('https:', 'http:'),
    authorizeUrl().replace(STORE, 'other-store.myshopify.com'),
    authorizeUrl().replace(STORE, `user:secret@${STORE}`),
    authorizeUrl().replace('/admin/oauth/authorize', '/admin/oauth/other'),
    `${authorizeUrl()}#fragment`,
    authorizeUrl({ client_id: 'another_client_id_9999' }),
    authorizeUrl({ client_id: undefined }),
    authorizeUrl({ scope: 'read_orders' }),
    authorizeUrl({ scope: `${REQUIRED_SCOPES.join(',')},write_orders` }),
    authorizeUrl({ redirect_uri: 'https://evil.example/callback' }),
    authorizeUrl({ state: undefined }),
    authorizeUrl({ state: '' }),
    `${authorizeUrl()}&state=second`,
    `${authorizeUrl()}&scope=read_orders`,
  ];
  for (const location of rejected) {
    assert.equal(parseAuthorizationUrl(location, expected), null, location);
  }
});

test('query parsing refuses duplicates, oversized values and malformed targets', () => {
  const parsed = parseQuery('/auth/callback?code=abc&shop=x.myshopify.com');
  assert.deepEqual(
    [...parsed],
    [
      ['code', 'abc'],
      ['shop', 'x.myshopify.com'],
    ],
  );
  assert.equal(parseQuery('/auth/callback').size, 0);

  assert.equal(parseQuery('/cb?a=1&a=2'), null);
  assert.equal(parseQuery(`/cb?a=${'x'.repeat(MAX_QUERY_VALUE_LENGTH + 1)}`), null);
  assert.equal(parseQuery(`/cb?${'k'.repeat(65)}=1`), null);
  assert.equal(parseQuery('http://[bad'), null);
  assert.ok(
    parseQuery(`/cb?a=${'x'.repeat(MAX_QUERY_VALUE_LENGTH)}`),
    'the limit itself is allowed',
  );
});

test('a callback must carry exactly the fields Shopify sends, all non-empty', () => {
  const complete = new Map([
    ['code', 'c'],
    ['hmac', 'h'],
    ['shop', STORE],
    ['state', 's'],
    ['timestamp', '1'],
  ]);
  assert.equal(hasExactCallbackFields(complete), true);
  assert.equal(hasExactCallbackFields(new Map([...complete, ['host', 'aG9zdA']])), true);

  assert.equal(hasExactCallbackFields(new Map([...complete, ['extra', '1']])), false);
  for (const name of complete.keys()) {
    const without = new Map(complete);
    without.delete(name);
    assert.equal(hasExactCallbackFields(without), false, `missing ${name}`);
    assert.equal(
      hasExactCallbackFields(new Map([...complete, [name, '']])),
      false,
      `empty ${name}`,
    );
  }
});

test('only the named string headers are forwarded to the SDK', () => {
  const request = {
    headers: {
      cookie: 'a=1',
      'user-agent': 'synthetic',
      authorization: 'secret',
      accept: ['x', 'y'],
    },
  };
  assert.deepEqual(forwardedHeaders(request, ['cookie', 'user-agent', 'accept', 'missing']), {
    cookie: 'a=1',
    'user-agent': 'synthetic',
  });
});

test('a session becomes a grant whose expiry follows the injected clock', () => {
  const hour = 3_600_000;
  const session = {
    shop: STORE,
    isOnline: false,
    accessToken: 'synthetic_access',
    scope: REQUIRED_SCOPES.join(', '),
    expires: new Date(Date.now() + hour),
    refreshToken: 'synthetic_refresh',
    refreshTokenExpires: new Date(Date.now() + 24 * hour),
  };
  const clockMs = 5_000_000_000_000;
  const grant = grantFromSession(session, {
    store: STORE,
    clientId: CLIENT_ID,
    now: () => clockMs,
  });

  assert.deepEqual(grant.scopes, [...REQUIRED_SCOPES]);
  assert.equal(grant.savedAt, clockMs);
  assert.ok(Math.abs(grant.accessTokenExpiresAt - (clockMs + hour)) < 1000);
  assert.ok(Math.abs(grant.refreshTokenExpiresAt - (clockMs + 24 * hour)) < 1000);
  assert.equal(grant.offline, true);
});
