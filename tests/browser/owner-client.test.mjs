// The owner page's client helpers (fixed same-origin requests, honest failures) and the sign-in and
// owner views. Requests use a fake fetch: nothing leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_MESSAGES,
  loadOwnerSession,
  loadScreens,
  messageForError,
  parseCode,
  parseEmail,
  requestSignInCode,
  saveWorkspaceSettings,
  signOut,
  verifySignInCode,
} from '../../public/owner/owner-client.js';
import { renderOwner, renderSignIn } from '../../public/owner/owner-view.js';

function fakeFetchReturning(status, body) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('email and code parsing accept only plausible input', () => {
  assert.equal(parseEmail('  Owner@Example.TEST '), 'owner@example.test');
  for (const bad of ['', 'owner', 'a@b', 'a b@example.test', null, 5])
    assert.equal(parseEmail(bad), null);
  assert.equal(parseCode('123 456'), '123456');
  for (const bad of ['12345', '1234567', 'abcdef', '', null]) assert.equal(parseCode(bad), null);
});

test('client requests use fixed same-origin routes and keep the CSRF token out of bodies', async () => {
  const sent = fakeFetchReturning(200, { ok: true });
  assert.equal((await requestSignInCode('a@example.test', sent.fetchImpl)).ok, true);
  assert.equal(sent.calls[0].url, '/api/auth/email-otp/send-verification-otp');
  assert.deepEqual(JSON.parse(sent.calls[0].options.body), {
    email: 'a@example.test',
    type: 'sign-in',
  });
  assert.equal(sent.calls[0].options.credentials, 'same-origin');
  assert.equal(sent.calls[0].options.headers['X-CSRF-Token'], undefined);

  const verified = fakeFetchReturning(200, { ok: true });
  await verifySignInCode('a@example.test', '123456', verified.fetchImpl);
  assert.equal(verified.calls[0].url, '/api/auth/sign-in/email-otp');
  assert.deepEqual(JSON.parse(verified.calls[0].options.body), {
    email: 'a@example.test',
    otp: '123456',
  });

  const loggedOut = fakeFetchReturning(200, { ok: true });
  await signOut('token-value', loggedOut.fetchImpl);
  assert.equal(loggedOut.calls[0].url, '/api/auth/sign-out');
  assert.equal(loggedOut.calls[0].options.headers['X-CSRF-Token'], 'token-value');
  assert.equal(loggedOut.calls[0].options.body.includes('token-value'), false);

  const saved = fakeFetchReturning(200, { settings: {}, revision: 1 });
  await saveWorkspaceSettings(
    { csrfToken: 't', settings: { theme: 'dark' }, revision: 0 },
    saved.fetchImpl,
  );
  assert.deepEqual(JSON.parse(saved.calls[0].options.body), {
    settings: { theme: 'dark' },
    revision: 0,
  });
});

test('client reports delivery failure, rate limits and offline honestly', async () => {
  const unconfigured = fakeFetchReturning(503, { error: 'delivery_not_configured' });
  const result = await requestSignInCode('a@example.test', unconfigured.fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'delivery_not_configured');
  assert.match(messageForError(result.error), /cannot send sign-in codes/);
  assert.match(messageForError(result.error), /No code was sent/);

  const offline = await requestSignInCode('a@example.test', async () => {
    throw new TypeError('network down');
  });
  assert.equal(offline.error, 'offline');
  assert.equal(messageForError('unknown-code'), 'Something went wrong. Please try again.');
  for (const message of Object.values(ERROR_MESSAGES)) assert.ok(message.length > 10);
});

test('session loading separates signed-out from failure', async () => {
  assert.deepEqual(
    await loadOwnerSession(fakeFetchReturning(401, { error: 'unauthenticated' }).fetchImpl),
    {
      status: 'signed-out',
    },
  );
  const failure = await loadOwnerSession(
    fakeFetchReturning(500, { error: 'server_error' }).fetchImpl,
  );
  assert.equal(failure.status, 'error');
  const ok = await loadOwnerSession(fakeFetchReturning(200, SESSION_VIEW).fetchImpl);
  assert.equal(ok.status, 'signed-in');
});

const SESSION_VIEW = {
  owner: { email: 'owner@example.test' },
  workspace: { name: 'My Selloview', revision: 3, settings: { period: 'month', theme: 'dark' } },
  storeConnection: { state: 'setup_required', canConnect: false },
  csrfToken: 'abc',
};

test('malformed successful session replies never become signed-in sessions', async () => {
  const malformed = [
    null,
    {},
    [],
    'signed-in',
    { ...SESSION_VIEW, owner: null },
    { ...SESSION_VIEW, owner: { email: 5 } },
    { ...SESSION_VIEW, workspace: null },
    { ...SESSION_VIEW, workspace: { ...SESSION_VIEW.workspace, settings: {} } },
    { ...SESSION_VIEW, workspace: { ...SESSION_VIEW.workspace, revision: -1 } },
    { ...SESSION_VIEW, csrfToken: '' },
    { ...SESSION_VIEW, storeConnection: null },
  ];
  for (const body of malformed) {
    assert.deepEqual(await loadOwnerSession(fakeFetchReturning(200, body).fetchImpl), {
      status: 'error',
      error: 'malformed',
    });
  }
  const unreadableJson = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError();
    },
  });
  assert.equal((await loadOwnerSession(unreadableJson)).status, 'error');
});

const SCREEN = {
  id: 'screen-a',
  name: 'Office',
  pairedAt: '2026-10-01T12:00:00.000Z',
  lastSeenAt: null,
  expiresAt: '2026-11-01T12:00:00.000Z',
};

test('screen loading rejects malformed lists and entries without throwing', async () => {
  for (const body of [
    null,
    {},
    [],
    { screens: null },
    { screens: {} },
    { screens: [null] },
    { screens: [{}] },
    { screens: [{ ...SCREEN, expiresAt: 'invalid' }] },
  ]) {
    assert.deepEqual(await loadScreens(fakeFetchReturning(200, body).fetchImpl), {
      ok: false,
      error: 'malformed',
    });
  }
  for (const screens of [[], [SCREEN]]) {
    assert.deepEqual(await loadScreens(fakeFetchReturning(200, { screens }).fetchImpl), {
      ok: true,
      screens,
    });
  }
});

test('settings replies need valid settings and a revision, including conflicts', async () => {
  const input = { csrfToken: 'abc', settings: { theme: 'dark' }, revision: 0 };
  for (const status of [200, 409]) {
    for (const body of [
      null,
      {},
      { settings: {}, revision: 1 },
      { settings: { theme: 'dark', period: 'week' }, revision: -1 },
    ]) {
      const result = await saveWorkspaceSettings(input, fakeFetchReturning(status, body).fetchImpl);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'malformed');
      assert.notEqual(result.status, 409, 'malformed conflicts must not be adopted by the page');
    }
    const body = { settings: { theme: 'dark', period: 'week' }, revision: 1 };
    const result = await saveWorkspaceSettings(input, fakeFetchReturning(status, body).fetchImpl);
    assert.equal(result.status, status);
    assert.deepEqual(result.data, body);
  }
});

test('sign-in view escapes input and never shows a fake success', () => {
  const emailStep = renderSignIn({
    step: 'email',
    email: '"><img src=x onerror=alert(1)>',
    message:
      'This server cannot send sign-in codes yet because email delivery is not set up. No code was sent.',
    tone: 'error',
  });
  assert.equal(emailStep.includes('<img src=x'), false);
  assert.match(emailStep, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(emailStep, /role="alert"/);
  assert.match(emailStep, /No code was sent/);
  assert.match(emailStep, /Email me a sign-in code/);

  const codeStep = renderSignIn({
    step: 'code',
    email: '<b>x</b>@example.test',
    message: '',
    tone: 'info',
  });
  assert.equal(codeStep.includes('<b>'), false);
  assert.match(codeStep, /autocomplete="one-time-code"/);
});

test('owner view shows the honest empty state, escapes values and offers sign out', () => {
  const html = renderOwner({
    session: { ...SESSION_VIEW, owner: { email: '"><script>alert(1)</script>@example.test' } },
    message: '',
    tone: 'info',
    screens: { status: 'ready', items: [] },
    confirmRevokeId: '',
    screenMessage: '',
    screenTone: 'info',
  });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /data-store-state="loading"/);
  assert.match(html, /data-action="sign-out"/);
  assert.match(html, /<option value="month" selected>/);
  assert.match(html, /<option value="dark" selected>/);
  assert.equal(
    /\$[0-9]|class="metric-value"/i.test(html),
    false,
    'no metrics or fictional figures',
  );
  assert.equal(html.includes(SESSION_VIEW.csrfToken), false, 'the CSRF token is never rendered');
});
