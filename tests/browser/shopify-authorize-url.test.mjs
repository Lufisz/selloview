import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthorizeUrl } from '../../public/owner/shopify-authorize-url.js';

const STORE = 'synthetic.myshopify.com';
const CALLBACK = 'https://board.example.test/auth/shopify/callback';
const SCOPES = 'read_all_orders,read_orders,read_products,read_inventory';
const GOOD_URL = `https://${STORE}/admin/oauth/authorize?client_id=x&scope=${SCOPES}&redirect_uri=${encodeURIComponent(CALLBACK)}&state=s`;
const context = { store: STORE, callbackUrl: CALLBACK };

test('the authorize URL must be the exact configured store over HTTPS', () => {
  assert.ok(validateAuthorizeUrl(GOOD_URL, context));
  const unsafe = [
    GOOD_URL.replace('https:', 'http:'),
    GOOD_URL.replace(STORE, 'other.myshopify.com'),
    GOOD_URL.replace(STORE, `${STORE}.evil.example`),
    GOOD_URL.replace(`https://${STORE}`, `https://${STORE}@evil.example`),
    GOOD_URL.replace(`https://${STORE}`, `https://evil.example/@${STORE}`),
    GOOD_URL.replace(STORE, `${STORE}:8443`),
    GOOD_URL.replace('/admin/oauth/authorize', '/admin/oauth/other'),
    GOOD_URL.replace('/admin/oauth/authorize', '/admin/oauth/authorize/x'),
    `${GOOD_URL}#fragment`,
    GOOD_URL.replace(SCOPES, 'read_orders,write_orders'),
    GOOD_URL.replace(SCOPES, 'read_orders'),
    GOOD_URL.replace(SCOPES, 'read_orders,read_orders,read_products,read_inventory'),
    `${GOOD_URL}&scope=read_orders`,
    GOOD_URL.replace(encodeURIComponent(CALLBACK), 'https%3A%2F%2Fevil.example%2Fcb'),
    `${GOOD_URL}&redirect_uri=${encodeURIComponent(CALLBACK)}`,
    'javascript:alert(1)',
    '//evil.example/admin/oauth/authorize',
    '',
    42,
    null,
  ];
  for (const url of unsafe) assert.equal(validateAuthorizeUrl(url, context), null, String(url));
  assert.equal(validateAuthorizeUrl(GOOD_URL, { store: 'bad store', callbackUrl: CALLBACK }), null);
  assert.equal(validateAuthorizeUrl(GOOD_URL, { store: 'Synthetic.myshopify.com' }), null);
  assert.equal(validateAuthorizeUrl(GOOD_URL, { store: 42 }), null);
});

test('scope and redirect_uri are optional, but checked whenever they are present', () => {
  const bare = `https://${STORE}/admin/oauth/authorize?client_id=x&state=s`;
  assert.equal(validateAuthorizeUrl(bare, context), bare);

  // Without a configured callback URL there is nothing to compare the redirect with.
  assert.ok(validateAuthorizeUrl(GOOD_URL, { store: STORE }));
  const otherRedirect = GOOD_URL.replace(
    encodeURIComponent(CALLBACK),
    'https%3A%2F%2Fother.test%2Fcb',
  );
  assert.ok(validateAuthorizeUrl(otherRedirect, { store: STORE }));
  assert.equal(validateAuthorizeUrl(otherRedirect, context), null);
});
