// The sign-in endpoints in front of Better Auth, with Better Auth itself replaced by a stub that
// answers at once, so the only time a request can take is what the gateway adds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { MIN_ANSWER_MS, createAuthGateway } from '../../server/accounts/auth-gateway.mjs';
import { SEND_CODE_PATH, SIGN_IN_PATH } from '../../server/accounts/auth.mjs';

const ORIGIN = 'https://metrictv.example.test';
// Node's timers can fire a millisecond early.
const TIMER_SLACK_MS = 2;

function gatewayAnswering(authStatus, registrationOverrides = {}) {
  const replies = [];
  const serve = createAuthGateway({
    auth: { handler: async () => new Response('{}', { status: authStatus }) },
    origin: ORIGIN,
    mailTransport: { configured: true },
    registration: { enabled: false, runExclusive: (work) => work(), ...registrationOverrides },
    reply: (response, status, body) => replies.push({ status, body, at: performance.now() }),
    requireCsrfSession: async () => ({}),
    clientAddress: () => '203.0.113.7',
  });
  return { serve, replies };
}

function jsonPost(body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json', origin: ORIGIN };
  request.rawHeaders = ['Content-Type', 'application/json', 'Origin', ORIGIN];
  return request;
}

test('a server error while asking for a code is reported the same way for every address', async () => {
  const { serve, replies } = gatewayAnswering(500);

  await serve(jsonPost({ email: 'a@example.test', type: 'sign-in' }), {}, SEND_CODE_PATH);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].status, 502);
  assert.deepEqual(replies[0].body, { error: 'delivery_failed' });
});

test('a sign-in answer takes at least the minimum time, however quick the work behind it is', async () => {
  const cases = [
    {
      authPath: SEND_CODE_PATH,
      authStatus: 200,
      body: { email: 'a@example.test', type: 'sign-in' },
    },
    { authPath: SIGN_IN_PATH, authStatus: 200, body: { email: 'a@example.test', otp: '123456' } },
    { authPath: SIGN_IN_PATH, authStatus: 400, body: { email: 'a@example.test', otp: '123456' } },
  ];
  for (const { authPath, authStatus, body } of cases) {
    const { serve, replies } = gatewayAnswering(authStatus);
    const startedAt = performance.now();

    await serve(jsonPost(body), {}, authPath);

    assert.equal(replies.length, 1);
    const tookMs = replies[0].at - startedAt;
    assert.ok(
      tookMs >= MIN_ANSWER_MS - TIMER_SLACK_MS,
      `${authPath} (${authStatus}) answered after ${tookMs.toFixed(1)} ms`,
    );
  }
});

test('registration refusals keep the minimum answer time, including a full beta', async () => {
  for (const hasRoom of [false, true]) {
    const { serve, replies } = gatewayAnswering(200, {
      enabled: true,
      emailHasAccount: () => false,
      hasRoom: () => hasRoom,
      consumeNewAddressCode: () => ({ allowed: false, retryAfterSeconds: 60 }),
    });
    const startedAt = performance.now();
    await serve(jsonPost({ email: 'new@example.test', type: 'sign-in' }), {}, SEND_CODE_PATH);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, hasRoom ? 429 : 200);
    assert.deepEqual(replies[0].body, hasRoom ? { error: 'rate_limited' } : { ok: true });
    const tookMs = replies[0].at - startedAt;
    assert.ok(
      tookMs >= MIN_ANSWER_MS - TIMER_SLACK_MS,
      `registration refusal answered after ${tookMs.toFixed(1)} ms`,
    );
  }
});
