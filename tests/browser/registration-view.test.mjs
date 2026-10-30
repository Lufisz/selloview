import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSignIn } from '../../public/owner/owner-view.js';
import { loadRegistrationStatus } from '../../public/owner/owner-client.js';

const BASE = { step: 'email', email: '', message: '', tone: 'info', registering: true };

test('registration is honest when closed or at capacity, without a dead signup form', () => {
  const closed = renderSignIn({ ...BASE, registration: { enabled: false, available: false } });
  assert.match(closed, /Registration is not open yet/);
  assert.match(closed, /href="\/app"/);
  assert.match(closed, /href="\/demo"/);
  assert.match(closed, /class="entry-page"/);
  assert.match(closed, /class="button primary" href="\/demo"/);
  assert.match(closed, /class="registration-signin" href="\/app"/);
  assert.match(closed, /No account has been created/);
  assert.doesNotMatch(closed, /<form/);
  const full = renderSignIn({ ...BASE, registration: { enabled: true, available: false } });
  assert.match(full, /beta is at capacity/);
  assert.doesNotMatch(full, /<form/);
});

test('an open registration starts with email ownership verification', () => {
  const html = renderSignIn({ ...BASE, registration: { enabled: true, available: true } });
  assert.match(html, /Create your workspace/);
  assert.match(html, /Your email address/);
  assert.match(html, /data-form="request-code"/);
  assert.match(html, /No password or card required/);
  assert.doesNotMatch(html, /type="password"/);
});

test('a code already requested can still be entered when capacity changes', () => {
  const html = renderSignIn({
    ...BASE,
    step: 'code',
    registration: { enabled: true, available: false },
  });
  assert.match(html, /data-form="verify-code"/);
});

test('email and code entry share the account-entry layout without changing form contracts', () => {
  const email = renderSignIn({ ...BASE, registering: false });
  assert.match(email, /class="entry-card entry-form-card"/);
  assert.match(email, /data-form="request-code"/);
  assert.match(email, /id="owner-email"[^>]*type="email"[^>]*autocomplete="email"/);
  assert.match(email, /invitation only/);
  const code = renderSignIn({
    ...BASE,
    registering: false,
    step: 'code',
    email: 'owner@example.test',
    message: '<b>Invalid code</b>',
    tone: 'error',
  });
  assert.match(code, /class="entry-card entry-form-card"/);
  assert.match(code, /data-form="verify-code"/);
  assert.match(code, /autocomplete="one-time-code"/);
  assert.match(code, /data-action="change-email"/);
  assert.match(code, /role="alert">&lt;b&gt;Invalid code&lt;\/b&gt;/);
});

test('registration status is a same-origin read', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ enabled: false, available: false }) };
  };
  const result = await loadRegistrationStatus(fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, '/api/registration');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
});
