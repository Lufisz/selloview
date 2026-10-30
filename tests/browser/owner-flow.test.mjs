// What an owner does on the page over time: signing in, changing settings, connecting a store,
// pairing a screen. The real controller runs against SYNTHETIC server answers; each action is a
// click, a form submission or one of the page's own timers firing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticSnapshot } from '../helpers/synthetic-snapshot.mjs';
import {
  NO_SCREENS,
  SIGNED_OUT,
  SYNTHETIC_STORE,
  answer,
  ownerSession,
  runOwnerPage,
  storeAnswer,
} from '../helpers/owner-page.mjs';

const CSRF_TOKEN = 'owner-csrf-token';
const CALLBACK_URL = 'https://metrictv.example.test/auth/beta/shopify/callback';
const SEND_CODE = '/api/auth/email-otp/send-verification-otp';
const SIGN_IN = '/api/auth/sign-in/email-otp';

const connectedStore = () =>
  storeAnswer({
    state: 'connected',
    sync: { state: 'ok' },
    snapshot: syntheticSnapshot({ shopName: 'Flow Shop', domain: SYNTHETIC_STORE }),
  });
const urlsOf = (step) => step.requests.map((request) => request.url);

function authorizeUrl(origin = SYNTHETIC_STORE) {
  const url = new URL(`https://${origin}/admin/oauth/authorize`);
  url.searchParams.set('client_id', 'synthetic-client');
  url.searchParams.set('redirect_uri', CALLBACK_URL);
  url.searchParams.set('state', 'synthetic-state');
  return url.href;
}

// ---- Signing in -------------------------------------------------------------------------------

test('an invited owner asks for a code, enters it and lands on the workspace', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [SIGNED_OUT, ownerSession()],
      [SEND_CODE]: [answer(200, {})],
      [SIGN_IN]: [answer(200, {})],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
    },
    actions: [
      { type: 'submit', form: 'request-code', fields: { email: '  Owner@Example.TEST ' } },
      { type: 'submit', form: 'verify-code', fields: { code: '123 456' } },
    ],
  });
  const [start, codeAsked, signedIn] = result.steps;

  assert.deepEqual(result.failures, []);
  assert.match(start.html, /data-form="request-code"/);
  assert.deepEqual(
    codeAsked.requests.map((request) => request.body),
    [{ email: 'owner@example.test', type: 'sign-in' }],
  );
  assert.match(codeAsked.html, /data-form="verify-code"/);
  assert.match(codeAsked.html, /If owner@example\.test can sign in here, a code is on its way/);
  assert.match(codeAsked.html, /Nothing after a few minutes\?/);
  assert.deepEqual(urlsOf(signedIn), [SIGN_IN, '/api/session', '/api/screens', '/api/shopify']);
  assert.deepEqual(signedIn.requests[0].body, { email: 'owner@example.test', otp: '123456' });
  assert.match(signedIn.html, /data-action="sign-out"/);
  assert.doesNotMatch(signedIn.html, /data-form="verify-code"/);
});

test('an address or code that cannot be right is refused on the page, without a request', () => {
  const result = runOwnerPage({
    routes: { '/api/session': [SIGNED_OUT], [SEND_CODE]: [answer(200, {})] },
    actions: [
      { type: 'submit', form: 'request-code', fields: { email: 'not an address' } },
      { type: 'submit', form: 'request-code', fields: { email: 'owner@example.test' } },
      { type: 'submit', form: 'verify-code', fields: { code: '12' } },
    ],
  });
  const [, badAddress, codeStep, badCode] = result.steps;

  assert.deepEqual(badAddress.requests, []);
  assert.match(badAddress.html, /Enter the email address your invitation was issued for\./);
  assert.equal(codeStep.requests.length, 1);
  assert.deepEqual(badCode.requests, []);
  assert.match(badCode.html, /Enter the 6-digit code from your email\./);
  assert.match(badCode.html, /data-form="verify-code"/);
});

test('a code that could not be sent, or does not work, is said so and the owner stays put', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [SIGNED_OUT],
      [SEND_CODE]: [answer(503, { error: 'delivery_failed' }), answer(200, {})],
      [SIGN_IN]: [answer(401, { error: 'invalid_code' })],
    },
    actions: [
      { type: 'submit', form: 'request-code', fields: { email: 'owner@example.test' } },
      { type: 'submit', form: 'request-code', fields: { email: 'owner@example.test' } },
      { type: 'submit', form: 'verify-code', fields: { code: '123456' } },
    ],
  });
  const [, notSent, codeStep, wrongCode] = result.steps;

  assert.match(notSent.html, /could not be sent/);
  assert.match(
    notSent.html,
    /data-form="request-code"/,
    'no code step for a code that was not sent',
  );
  assert.match(codeStep.html, /data-form="verify-code"/);
  assert.match(wrongCode.html, /did not work/);
  assert.match(wrongCode.html, /data-form="verify-code"/);
});

test('"Use a different email" goes back to asking for an address', () => {
  const result = runOwnerPage({
    routes: { '/api/session': [SIGNED_OUT], [SEND_CODE]: [answer(200, {})] },
    actions: [
      { type: 'submit', form: 'request-code', fields: { email: 'owner@example.test' } },
      { type: 'click', action: 'change-email' },
    ],
  });
  const [, codeStep, backAtStart] = result.steps;

  assert.match(codeStep.html, /data-form="verify-code"/);
  assert.match(backAtStart.html, /data-form="request-code"/);
  assert.deepEqual(backAtStart.requests, []);
});

test('signing out sends the CSRF token, stops the polling and says so', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [connectedStore()],
      '/api/auth/sign-out': [answer(200, {})],
    },
    actions: [{ type: 'click', action: 'sign-out' }],
  });
  const [signedIn, signedOut] = result.steps;

  assert.deepEqual(signedIn.timers, [30000], 'figures refresh while signed in');
  assert.deepEqual(signedOut.requests, [
    { url: '/api/auth/sign-out', method: 'POST', body: {}, csrf: CSRF_TOKEN },
  ]);
  assert.match(signedOut.html, /data-form="request-code"/);
  assert.match(signedOut.html, /You are signed out\./);
  assert.deepEqual(signedOut.timers, [], 'nothing keeps polling after sign-out');
  assert.doesNotMatch(signedOut.html, /Flow Shop/);
});

test('a page that could not load offers "Try again", and trying again loads it', () => {
  const noSession = runOwnerPage({
    routes: {
      '/api/session': [answer(500, { error: 'request_failed' }), ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
    },
    actions: [{ type: 'click', action: 'retry' }],
  });
  const noStore = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer({ status: 500 }), storeAnswer()],
    },
    actions: [{ type: 'click', action: 'refresh-store' }],
  });

  assert.match(noSession.steps[0].html, /Could not load your session/);
  assert.match(noSession.html, /data-action="sign-out"/);
  assert.match(noStore.steps[0].html, /data-action="refresh-store"/);
  assert.doesNotMatch(noStore.html, /data-action="refresh-store"/);
  assert.match(noStore.html, /data-form="connect-shopify"/);
});

test('a button the page does not know, even one named like an object built-in, does nothing', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
    },
    actions: [
      { type: 'click', action: 'definition' },
      { type: 'click', action: 'constructor' },
      { type: 'click', action: 'toString' },
    ],
  });
  const [start, ...afterClicks] = result.steps;

  assert.deepEqual(result.failures, []);
  for (const step of afterClicks) {
    assert.deepEqual(step.requests, []);
    assert.equal(step.html, start.html);
  }
});

test('the sign-up page loads the registration status and says when it is not open', () => {
  const closed = runOwnerPage({
    pathname: '/register',
    routes: {
      '/api/session': [SIGNED_OUT],
      '/api/registration': [answer(200, { enabled: true, available: false })],
    },
  });
  const open = runOwnerPage({
    pathname: '/register',
    routes: {
      '/api/session': [SIGNED_OUT],
      '/api/registration': [answer(200, { enabled: true, available: true })],
    },
  });

  assert.deepEqual(urlsOf(closed.steps[0]), ['/api/session', '/api/registration']);
  assert.match(closed.html, /at capacity/);
  assert.doesNotMatch(closed.html, /data-form="request-code"/);
  assert.match(open.html, /Create your workspace\./);
  assert.match(open.html, /data-form="request-code"/);
});

// ---- Settings -----------------------------------------------------------------------------------

test('saving settings sends the revision the page saw and shows what the server kept', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
      '/api/settings': [
        answer(200, { settings: { period: 'month', theme: 'dark' }, revision: 1 }),
        answer(409, {
          error: 'conflict',
          settings: { period: 'today', theme: 'light' },
          revision: 5,
        }),
      ],
    },
    actions: [
      { type: 'submit', form: 'settings', fields: { period: 'month', theme: 'dark' } },
      { type: 'submit', form: 'settings', fields: { period: 'week', theme: 'light' } },
    ],
  });
  const [, saved, conflicted] = result.steps;

  assert.deepEqual(saved.requests, [
    {
      url: '/api/settings',
      method: 'POST',
      body: { settings: { period: 'month', theme: 'dark' }, revision: 0 },
      csrf: CSRF_TOKEN,
    },
  ]);
  assert.match(saved.html, /Saved for this workspace\./);
  assert.match(saved.html, /<option value="month" selected>/);
  assert.equal(saved.theme, 'dark');
  assert.equal(conflicted.requests[0].body.revision, 1, 'the next save builds on the saved one');
  assert.match(conflicted.html, /changed elsewhere/);
  assert.match(conflicted.html, /<option value="today" selected>/, "the server's choices win");
  assert.equal(conflicted.theme, 'light');
});

test("the board's own period picker saves the same workspace setting", () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [connectedStore()],
      '/api/settings': [
        answer(200, { settings: { period: 'month', theme: 'light' }, revision: 1 }),
      ],
    },
    actions: [{ type: 'change', id: 'period', value: 'month' }],
  });
  const [before, after] = result.steps;

  assert.match(before.html, /Daily order value(?! \()/, 'the 7-day chart to start with');
  assert.deepEqual(after.requests, [
    {
      url: '/api/settings',
      method: 'POST',
      body: { settings: { period: 'month' }, revision: 0 },
      csrf: CSRF_TOKEN,
    },
  ]);
  assert.match(after.html, /Daily order value \(30 days\)/);
});

test('text typed into the forms survives the page being redrawn', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
    },
    actions: [
      { type: 'input', form: 'pair-screen', name: 'code', value: 'ABCD' },
      { type: 'input', form: 'settings', name: 'period', value: 'month' },
      { type: 'input', form: 'connect-shopify', name: 'store', value: 'half-typed' },
      { type: 'click', action: 'refresh-screens' },
    ],
  });

  assert.match(result.html, /value="ABCD"/);
  assert.match(result.html, /<option value="month" selected>/);
  assert.match(result.html, /value="half-typed"/);
});

test('the details an owner opened or closed, and what was typed in them, survive a redraw', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [connectedStore()],
    },
    actions: [
      { type: 'toggle', key: 'connection', open: false },
      { type: 'toggle', key: 'add-screen', open: true },
      { type: 'input', form: 'pair-screen', name: 'name', value: 'Lobby' },
      { type: 'input', form: 'connect-shopify', name: 'store', value: 'draft-store.myshopify.com' },
      { type: 'click', action: 'refresh-screens' },
    ],
  });

  assert.deepEqual(result.failures, []);
  assert.match(result.html, /data-details-key="connection" open>/);
  assert.doesNotMatch(
    result.html,
    /data-details-key="add-screen" open/,
    'a closed choice stays closed',
  );
  assert.match(result.html, /name="name"[^>]*value="Lobby"/);
  assert.match(result.html, /value="draft-store.myshopify.com"/);
});

// ---- The Shopify connection --------------------------------------------------------------------

test('connecting asks the server to start, then goes to the Shopify address it returned', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
      '/api/shopify/start': [answer(200, { authorizationUrl: authorizeUrl() })],
    },
    actions: [
      { type: 'submit', form: 'connect-shopify', fields: { store: 'not a store' } },
      {
        type: 'submit',
        form: 'connect-shopify',
        fields: { store: ` ${SYNTHETIC_STORE.toUpperCase()} ` },
      },
    ],
  });
  const [, refused, started] = result.steps;

  assert.deepEqual(refused.requests, [], 'an address that is not a store never leaves the page');
  assert.match(refused.html, /ending in \.myshopify\.com/);
  assert.deepEqual(started.requests, [
    {
      url: '/api/shopify/start',
      method: 'POST',
      body: { store: SYNTHETIC_STORE },
      csrf: CSRF_TOKEN,
    },
  ]);
  assert.deepEqual(result.assigned, [authorizeUrl()]);
});

test('a store address that cannot be right opens the connection details with the error', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [connectedStore()],
    },
    actions: [{ type: 'submit', form: 'connect-shopify', fields: { store: 'not a store' } }],
  });
  const [, refused] = result.steps;

  assert.deepEqual(refused.requests, [], 'nothing is sent to the server');
  assert.match(refused.html, /data-details-key="connection" open>/);
  assert.match(refused.html, /role="alert"/);
  assert.match(refused.html, /value="not a store"/, 'the submitted text is kept');
});

test("a Shopify address that is not the store's own authorization page is never visited", () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
      '/api/shopify/start': [answer(200, { authorizationUrl: authorizeUrl('evil.myshopify.com') })],
    },
    actions: [{ type: 'submit', form: 'connect-shopify', fields: { store: SYNTHETIC_STORE } }],
  });

  assert.deepEqual(result.assigned, []);
  assert.match(result.html, /unexpected Shopify address/);
});

test('a session that ended while connecting sends the owner back to sign in', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
      '/api/shopify/start': [SIGNED_OUT],
    },
    actions: [{ type: 'submit', form: 'connect-shopify', fields: { store: SYNTHETIC_STORE } }],
  });

  assert.match(result.html, /data-form="request-code"/);
  assert.match(result.html, /You are signed out\. Sign in again\./);
});

test('disconnecting asks first, and only the confirmation removes the access', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [connectedStore(), storeAnswer()],
      '/api/shopify/disconnect': [answer(200, { disconnected: true })],
    },
    actions: [
      { type: 'click', action: 'disconnect-shopify-ask' },
      { type: 'click', action: 'disconnect-shopify-cancel' },
      { type: 'click', action: 'disconnect-shopify-ask' },
      { type: 'click', action: 'disconnect-shopify-confirm' },
    ],
  });
  const [, asked, cancelled, askedAgain, confirmed] = result.steps;

  assert.match(asked.html, /data-action="disconnect-shopify-confirm"/);
  assert.deepEqual(asked.requests, []);
  assert.doesNotMatch(cancelled.html, /data-action="disconnect-shopify-confirm"/);
  assert.deepEqual(cancelled.requests, []);
  assert.match(askedAgain.html, /data-action="disconnect-shopify-confirm"/);
  assert.deepEqual(
    confirmed.requests.map((request) => [request.url, request.csrf]),
    [
      ['/api/shopify/disconnect', CSRF_TOKEN],
      ['/api/shopify', null],
    ],
  );
  assert.match(confirmed.html, /Disconnected from MetricTV/);
  assert.match(confirmed.html, /data-form="connect-shopify"/);
  assert.doesNotMatch(confirmed.html, /Flow Shop/);
});

test('a failed refresh keeps the board and says so; the next good one clears the notice', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [connectedStore(), 'network-error', connectedStore()],
    },
    actions: [{ type: 'tick' }, { type: 'tick' }],
  });
  const [shown, lost, recovered] = result.steps;

  assert.match(shown.html, /Flow Shop/);
  assert.match(lost.html, /Flow Shop/, 'the last figures stay on screen');
  assert.match(lost.html, /Could not reach the server/);
  assert.deepEqual(lost.timers, [30000], 'it keeps trying');
  assert.match(recovered.html, /Flow Shop/);
  assert.doesNotMatch(recovered.html, /Could not reach the server/);
});

test('a refresh that finds the session ended returns to the sign-in page', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [connectedStore(), SIGNED_OUT],
    },
    actions: [{ type: 'tick' }],
  });

  assert.match(result.html, /data-form="request-code"/);
  assert.doesNotMatch(result.html, /Flow Shop/);
  assert.deepEqual(result.timers, []);
});

// ---- Screens -------------------------------------------------------------------------------------

const OFFICE_SCREEN = {
  id: 'screen-1',
  name: 'Office',
  pairedAt: '2026-10-01T10:00:00.000Z',
  expiresAt: '2027-01-01T10:00:00.000Z',
  lastSeenAt: null,
};

test('approving a screen sends its code and name, then waits for the TV to appear', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS, NO_SCREENS, answer(200, { screens: [OFFICE_SCREEN] })],
      '/api/shopify': [storeAnswer()],
      '/api/screens/pair': [answer(200, { ok: true })],
    },
    actions: [
      { type: 'submit', form: 'pair-screen', fields: { code: 'abcd-efgh', name: ' Office ' } },
      { type: 'tick' },
    ],
  });
  const [, approved, connected] = result.steps;

  assert.deepEqual(approved.requests[0], {
    url: '/api/screens/pair',
    method: 'POST',
    body: { code: 'ABCDEFGH', name: 'Office' },
    csrf: CSRF_TOKEN,
  });
  assert.match(approved.html, /Approved\. The screen appears/);
  assert.deepEqual(approved.timers, [3000], 'it looks again in a few seconds');
  assert.match(connected.html, /The screen is connected\./);
  assert.match(connected.html, /Office/);
});

test('a screen code of the wrong shape is refused on the page and the typed text is kept', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [NO_SCREENS],
      '/api/shopify': [storeAnswer()],
    },
    actions: [{ type: 'submit', form: 'pair-screen', fields: { code: 'xx', name: 'Office' } }],
  });
  const [, refused] = result.steps;

  assert.deepEqual(refused.requests, []);
  assert.match(refused.html, /Enter the 8-character code shown on the TV\./);
  assert.match(refused.html, /value="xx"/);
  assert.match(refused.html, /value="Office"/);
});

test('removing a screen asks first, and only the confirmation sends the request', () => {
  const result = runOwnerPage({
    routes: {
      '/api/session': [ownerSession()],
      '/api/screens': [answer(200, { screens: [OFFICE_SCREEN] }), NO_SCREENS],
      '/api/shopify': [storeAnswer()],
      '/api/screens/revoke': [answer(200, { ok: true })],
    },
    actions: [
      { type: 'click', action: 'revoke-screen', id: 'screen-1' },
      { type: 'click', action: 'cancel-revoke' },
      { type: 'click', action: 'revoke-screen', id: 'screen-1' },
      { type: 'click', action: 'confirm-revoke', id: 'screen-1' },
    ],
  });
  const [, asked, cancelled, askedAgain, removed] = result.steps;

  assert.match(asked.html, /data-action="confirm-revoke"/);
  assert.deepEqual(asked.requests, []);
  assert.doesNotMatch(cancelled.html, /data-action="confirm-revoke"/);
  assert.match(cancelled.html, /Office/, 'cancelling keeps the screen');
  assert.match(askedAgain.html, /data-action="confirm-revoke"/);
  assert.deepEqual(removed.requests[0], {
    url: '/api/screens/revoke',
    method: 'POST',
    body: { id: 'screen-1' },
    csrf: CSRF_TOKEN,
  });
  assert.match(removed.html, /Screen removed\./);
  assert.doesNotMatch(removed.html, /screen-item/);
});
