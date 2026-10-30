// The browser-facing sign-in endpoints below /api/auth, in front of Better Auth. This file decides
// what a browser may send and what it gets back; Better Auth only does the work behind it. Its
// bodies (tokens, user records, error text) are never passed through, only its cookies and its
// rate-limit delay.
import { setTimeout as pause } from 'node:timers/promises';
import { fromNodeHeaders } from 'better-auth/node';
import { RequestRejection, assertSameOriginJson, readJsonObject } from '../http/guards.mjs';
import {
  AUTH_BASE_PATH,
  CLIENT_IP_HEADER,
  SEND_CODE_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
} from './auth.mjs';

const CODE_PATTERN = /^\d{6}$/;
const MAX_EMAIL_LENGTH = 254;
// Every answer from these endpoints takes at least this long, far more than the work behind it
// (about a millisecond), so how long an answer takes says nothing about whether the address has an
// account. The timer starts before the work, so the work's own length does not move when the
// answer goes out.
// ceiling: work above this shows through,
// upgrade: raise it if the work ever takes tens of milliseconds
export const MIN_ANSWER_MS = 100;

function isEmailText(value) {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && value.includes('@');
}

// Per-endpoint body shape and validation. Unknown keys (name, image, ...) are rejected so the
// browser cannot set profile fields or reach other Better Auth options.
const ENDPOINTS = Object.freeze({
  [SEND_CODE_PATH]: {
    keys: ['email', 'type'],
    isValid: (body) => isEmailText(body.email) && body.type === 'sign-in',
    needsSession: false,
  },
  [SIGN_IN_PATH]: {
    keys: ['email', 'otp'],
    isValid: (body) => isEmailText(body.email) && CODE_PATTERN.test(String(body.otp)),
    needsSession: false,
  },
  [SIGN_OUT_PATH]: { keys: [], isValid: () => true, needsSession: true },
});

/**
 * @param {object} dependencies
 * @param {ReturnType<typeof import('./auth.mjs').createAuth>} dependencies.auth
 * @param {string} dependencies.origin
 * @param {{configured: boolean}} dependencies.mailTransport
 * @param {ReturnType<typeof import('./registration.mjs').createRegistrationPolicy>} dependencies.registration
 * @param {(response, status, body, extraHeaders?) => void} dependencies.reply
 * @param {(request, response) => Promise<object|null>} dependencies.requireCsrfSession
 * @param {(request) => string} dependencies.clientAddress
 * @returns {(request, response, authPath: string) => Promise<void>} serves one request below
 *   /api/auth; `authPath` is the part after that prefix
 */
export function createAuthGateway({
  auth,
  origin,
  mailTransport,
  registration,
  reply,
  requireCsrfSession,
  clientAddress,
}) {
  function forwardedAuthRequest(request, authPath, bodyText) {
    const headers = fromNodeHeaders(request.headers);
    // Never trust a browser-supplied address header; Better Auth keys rate limits on this one.
    headers.set(CLIENT_IP_HEADER, clientAddress(request));
    headers.delete('content-length');
    return new Request(`${origin}${AUTH_BASE_PATH}${authPath}`, {
      method: 'POST',
      headers,
      body: bodyText,
    });
  }

  function respondToAuthResult(response, authPath, authResponse) {
    const extraHeaders = { 'Set-Cookie': authResponse.headers.getSetCookie() };
    if (authResponse.status === 429) {
      const retryAfter = authResponse.headers.get('retry-after');
      if (retryAfter && /^\d{1,6}$/.test(retryAfter)) extraHeaders['Retry-After'] = retryAfter;
      return reply(response, 429, { error: 'rate_limited' }, extraHeaders);
    }
    if (authResponse.ok) return reply(response, 200, { ok: true }, extraHeaders);
    if (authPath === SEND_CODE_PATH && authResponse.status >= 500) {
      return reply(response, 502, { error: 'delivery_failed' });
    }
    if (authPath === SIGN_IN_PATH) return reply(response, 400, { error: 'invalid_code' });
    return reply(response, 400, { error: 'invalid_request' });
  }

  // Existing owners are unaffected. A code for an address without an account costs email, so it
  // needs room and fits the request limits. A full service answers like the closed one: no mail,
  // success-shaped reply, nothing that tells a stranger which addresses have accounts.
  function checkNewAddressRequest(request, email) {
    if (registration.emailHasAccount(email.toLowerCase())) return null;
    if (!registration.hasRoom()) return { silent: true };
    const limit = registration.consumeNewAddressCode(clientAddress(request));
    return limit.allowed ? null : { retryAfterSeconds: limit.retryAfterSeconds };
  }

  function respondToRegistrationRefusal(response, refusal) {
    if (refusal.silent) return reply(response, 200, { ok: true });
    const extraHeaders = { 'Retry-After': String(refusal.retryAfterSeconds) };
    return reply(response, 429, { error: 'rate_limited' }, extraHeaders);
  }

  return async function serveAuthRoute(request, response, authPath) {
    const endpoint = Object.hasOwn(ENDPOINTS, authPath) ? ENDPOINTS[authPath] : null;
    if (!endpoint) return reply(response, 404, { error: 'not_found' });
    if (request.method !== 'POST') {
      return reply(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    assertSameOriginJson(request, origin);

    if (endpoint.needsSession && !(await requireCsrfSession(request, response))) return;
    if (authPath === SEND_CODE_PATH && !mailTransport.configured) {
      return reply(response, 503, { error: 'delivery_not_configured' });
    }

    const body = await readJsonObject(request, endpoint.keys);
    if (!endpoint.isValid(body)) throw new RequestRejection(400, 'invalid_request');
    const minimumAnswerTime = pause(MIN_ANSWER_MS);
    if (authPath === SEND_CODE_PATH && registration.enabled) {
      const refusal = checkNewAddressRequest(request, body.email);
      if (refusal) {
        await minimumAnswerTime;
        return respondToRegistrationRefusal(response, refusal);
      }
    }
    const authRequest = forwardedAuthRequest(request, authPath, JSON.stringify(body));
    const forwardToAuth = () => auth.handler(authRequest);
    // Verification can create an account, so it queues behind other verifications.
    const authResponse =
      authPath === SIGN_IN_PATH
        ? await registration.runExclusive(forwardToAuth)
        : await forwardToAuth();
    await minimumAnswerTime;
    return respondToAuthResult(response, authPath, authResponse);
  };
}
