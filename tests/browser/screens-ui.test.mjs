// Browser-side helpers and views for Screens and the TV page, with a synthetic fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadScreens,
  messageForError,
  pairScreen,
  parsePairingCode,
  revokeScreen,
} from '../../public/owner/owner-client.js';
import {
  createChallenge,
  exchangePairing,
  loadDisplay,
  loadPairing,
} from '../../public/tv/tv-client.js';
import { renderOwner } from '../../public/owner/owner-view.js';
import { renderPaired, renderWaiting } from '../../public/tv/tv-view.js';

function fakeFetchReturning(status, body) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

const OWNER_SESSION = {
  owner: { email: 'owner@example.test' },
  workspace: { name: 'My MetricTV', revision: 0, settings: { period: 'week', theme: 'light' } },
  storeConnection: { state: 'setup_required', canConnect: false },
  csrfToken: 'owner-csrf-token',
};

function ownerState(overrides) {
  return {
    session: OWNER_SESSION,
    message: '',
    tone: 'info',
    screens: { status: 'ready', items: [] },
    confirmRevokeId: '',
    screenMessage: '',
    screenTone: 'info',
    ...overrides,
  };
}

test('pairing codes accept case, spaces and hyphens only', () => {
  assert.equal(parsePairingCode(' abcd-efgh '), 'ABCDEFGH');
  for (const bad of ['', 'ABCD', 'ABCD-EFGH-J', 'ABCD EF<>', null, 12345678]) {
    assert.equal(parsePairingCode(bad), null, String(bad));
  }
});

test('screen requests are same-origin JSON with the CSRF header and no URL secrets', async () => {
  const paired = fakeFetchReturning(200, { status: 'approved' });
  await pairScreen({ csrfToken: 'tok', code: 'ABCDEFGH', name: 'Hall' }, paired.fetchImpl);
  assert.equal(paired.calls[0].url, '/api/screens/pair');
  assert.equal(paired.calls[0].options.method, 'POST');
  assert.equal(paired.calls[0].options.credentials, 'same-origin');
  assert.equal(paired.calls[0].options.headers['X-CSRF-Token'], 'tok');
  assert.deepEqual(JSON.parse(paired.calls[0].options.body), { code: 'ABCDEFGH', name: 'Hall' });

  const revoked = fakeFetchReturning(200, { status: 'revoked' });
  await revokeScreen({ csrfToken: 'tok', id: 'abc' }, revoked.fetchImpl);
  assert.equal(revoked.calls[0].url, '/api/screens/revoke');
  assert.deepEqual(JSON.parse(revoked.calls[0].options.body), { id: 'abc' });

  const screens = [
    {
      id: 'a',
      name: 'Hall',
      pairedAt: '2026-10-01T12:00:00.000Z',
      expiresAt: '2026-11-01T12:00:00.000Z',
      lastSeenAt: null,
    },
  ];
  const listed = fakeFetchReturning(200, { screens });
  assert.deepEqual(await loadScreens(listed.fetchImpl), {
    ok: true,
    screens,
  });
  assert.equal(listed.calls[0].options.method, 'GET');
  assert.equal(listed.calls[0].options.headers['X-CSRF-Token'], undefined);
  assert.equal(
    (await loadScreens(fakeFetchReturning(401, { error: 'unauthenticated' }).fetchImpl)).ok,
    false,
  );
});

test('a wrong screen code gets pairing wording, not the sign-in wording', async () => {
  const refused = fakeFetchReturning(400, { error: 'invalid_code' });
  const result = await pairScreen(
    { csrfToken: 't', code: 'ABCDEFGH', name: 'x' },
    refused.fetchImpl,
  );
  assert.equal(result.error, 'invalid_pairing_code');
  assert.match(messageForError(result.error), /screen code/);
  assert.match(messageForError('screen_limit'), /maximum/);
});

test('TV client sends bodiless-JSON POSTs and reads state through GET', async () => {
  const created = fakeFetchReturning(201, { code: 'ABCD-EFGH' });
  await createChallenge(created.fetchImpl);
  assert.equal(created.calls[0].url, '/api/tv/challenge');
  assert.equal(created.calls[0].options.body, '{}');
  await exchangePairing(created.fetchImpl);
  assert.equal(created.calls[1].url, '/api/tv/pairing/exchange');
  await loadPairing(created.fetchImpl);
  assert.equal(created.calls[2].options.method, 'GET');

  const display = { screen: { name: 'Hall' }, settings: { period: 'week', theme: 'dark' } };
  assert.deepEqual(await loadDisplay(fakeFetchReturning(200, display).fetchImpl), {
    status: 'paired',
    display,
  });
  assert.deepEqual(
    await loadDisplay(fakeFetchReturning(401, { error: 'unauthenticated' }).fetchImpl),
    {
      status: 'unpaired',
    },
  );
  const failed = await loadDisplay(fakeFetchReturning(500, { error: 'server_error' }).fetchImpl);
  assert.deepEqual(failed, { status: 'error', error: 'server_error' });
});

test('owner screens view escapes names, asks before removing and never shows tokens', () => {
  const items = [
    {
      id: 'screen-1',
      name: '"><script>alert(1)</script>',
      pairedAt: '2026-10-27T10:00:00.000Z',
      lastSeenAt: null,
      expiresAt: '2026-11-26T10:00:00.000Z',
    },
    {
      id: 'screen-2',
      name: 'Kitchen',
      pairedAt: '2026-10-27T11:00:00.000Z',
      lastSeenAt: '2026-10-27T12:30:45.000Z',
      expiresAt: '2026-11-26T11:00:00.000Z',
    },
  ];
  const html = renderOwner(ownerState({ screens: { status: 'ready', items } }));
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /Not seen since pairing/);
  assert.match(html, /Last seen 2026-10-27 12:30 UTC/);
  assert.match(html, /data-action="revoke-screen" data-id="screen-1"/);
  assert.equal(html.includes('confirm-revoke'), false, 'no one-click removal');
  assert.equal(html.includes(OWNER_SESSION.csrfToken), false);
  assert.match(html, /name="code"/);
  assert.match(html, /data-form="pair-screen"/);

  const confirming = renderOwner(
    ownerState({ screens: { status: 'ready', items }, confirmRevokeId: 'screen-2' }),
  );
  assert.match(confirming, /data-action="confirm-revoke" data-id="screen-2"/);
  assert.match(confirming, /data-action="cancel-revoke"/);
  assert.equal(confirming.includes('data-action="confirm-revoke" data-id="screen-1"'), false);
});

test('owner screens view is honest while loading, empty and failed; it has no TV controls', () => {
  assert.match(
    renderOwner(ownerState({ screens: { status: 'loading', items: [] } })),
    /Loading screens/,
  );
  assert.match(renderOwner(ownerState()), /No screens paired yet/);
  const failed = renderOwner(
    ownerState({ screens: { status: 'error', items: [], error: 'offline' } }),
  );
  assert.match(failed, /Could not reach the server/);
  assert.match(failed, /refresh-screens/);
  assert.equal(/<video|fullscreen|play|control/i.test(failed), false);
});

test('TV views escape values and show no figures or owner data', () => {
  const waiting = renderWaiting({ code: '"><img src=x>', message: '<b>retry</b>' });
  assert.equal(waiting.includes('<img src=x'), false);
  assert.equal(waiting.includes('<b>'), false);
  assert.match(waiting, /NOT PAIRED/);

  const display = {
    screen: { name: '<script>x</script>' },
    settings: { period: 'month', theme: 'dark' },
    storeConnection: { state: 'not_connected' },
  };
  const paired = renderPaired({ display, notice: '' });
  assert.equal(paired.includes('<script>'), false);
  assert.match(paired, /data-store-state="not_connected"/);
  assert.match(paired, /No store is connected/);
  assert.match(paired, /This month/);
  assert.match(paired, /dark-board/);
  assert.equal(/\$[0-9]|orders|revenue|owner@/i.test(paired), false);
  assert.match(renderPaired({ display, notice: 'Connection lost.' }), /Connection lost/);
});
