// The one place that writes Set-Cookie text: every cookie the app sets is host-only and HttpOnly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCookie } from '../../server/http/guards.mjs';

test('a cookie is HttpOnly, SameSite=Strict and sent on every path unless told otherwise', () => {
  const cookie = buildCookie({ name: 'synthetic', value: 'abc', maxAgeSeconds: 60, secure: false });

  assert.equal(cookie, 'synthetic=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=60');
});

test('a cookie can be limited to one path and sent on the way back from another site', () => {
  const cookie = buildCookie({
    name: 'synthetic',
    value: 'abc',
    maxAgeSeconds: 300,
    secure: true,
    path: '/auth/callback',
    sameSite: 'Lax',
  });

  assert.equal(
    cookie,
    'synthetic=abc; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=300; Secure',
  );
});

test('an empty value clears the cookie, whatever lifetime is passed', () => {
  const cookie = buildCookie({ name: 'synthetic', value: '', maxAgeSeconds: 60, secure: true });

  assert.equal(cookie, 'synthetic=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
});
