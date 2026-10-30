// Browser API for the invite-only beta page. Talks only to same-origin beta routes.
// The CSRF token returned by the session endpoint stays in memory; nothing is put in storage.

export const SESSION_URL = '/api/beta/session';
export const REGISTRATION_URL = '/api/beta/registration';
export const SETTINGS_URL = '/api/beta/settings';
export const SEND_CODE_URL = '/api/auth/email-otp/send-verification-otp';
export const SIGN_IN_URL = '/api/auth/sign-in/email-otp';
export const SIGN_OUT_URL = '/api/auth/sign-out';
export const SCREENS_URL = '/api/beta/screens';
export const PAIR_SCREEN_URL = '/api/beta/screens/pair';
export const REVOKE_SCREEN_URL = '/api/beta/screens/revoke';
export const PERIOD_CHOICES = Object.freeze(['today', 'week', 'month', 'days60']);
export const THEME_CHOICES = Object.freeze(['light', 'dark']);

const REQUEST_TIMEOUT_MS = 12000;
const CODE_PATTERN = /^\d{6}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const PAIRING_CODE_PATTERN = /^[A-Z0-9]{8}$/;

export const ERROR_MESSAGES = Object.freeze({
  delivery_not_configured:
    'This beta cannot send sign-in codes yet because email delivery is not set up. No code was sent.',
  delivery_failed: 'The code email could not be sent. Please try again later.',
  invalid_code:
    'That code did not work. It may be wrong, used already or expired. Request a new one.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  invalid_origin: 'This request was blocked for safety. Reload the page and try again.',
  invalid_csrf: 'Your page was out of date. Reload and try again.',
  unauthenticated: 'You are signed out. Sign in again.',
  conflict: 'Settings were changed elsewhere. Showing the saved choices.',
  offline: 'Could not reach the server. Check your connection and try again.',
  invalid_email: 'Enter the email address your invitation was issued for.',
  registration_closed: 'New accounts are not available yet. Existing owners can still sign in.',
  registration_full: 'The beta is at capacity. Existing owners can still sign in.',
  invalid_format: 'Enter the 6-digit code from your email.',
  invalid_pairing_code:
    'That screen code did not work. Check the code on the TV; it may have expired or been used already.',
  invalid_pairing_format: 'Enter the 8-character code shown on the TV.',
  invalid_name: 'Name the screen with 1 to 40 letters, numbers, spaces or . _ - characters.',
  screen_limit: 'This workspace already has the maximum number of screens. Remove one first.',
  not_found: 'That screen is already gone.',
  setup_required: 'Store connection is not set up on this beta server yet.',
  pilot_unavailable: 'Store connection is limited to the pilot owner during this beta.',
  store_not_allowed: 'This beta pilot can connect only one specific store, and this is not it.',
  store_in_use: 'That store is already connected to another MetricTV workspace.',
  invalid_store: 'Enter the store address as shown in Shopify, ending in .myshopify.com.',
  start_failed: 'Shopify authorization could not be started. Nothing was changed. Try again.',
  unsupported_client: 'This browser cannot start the Shopify authorization.',
  unsafe_authorize_url:
    'The server returned an unexpected Shopify address, so no redirect was made.',
  disconnect_failed: 'The saved Shopify access could not be removed. Try again.',
});

/** Trimmed lowercase email, or null when it cannot be an address. */
export function parseEmail(text) {
  if (typeof text !== 'string') return null;
  const email = text.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/** Six digits, ignoring spaces, or null. */
export function parseCode(text) {
  if (typeof text !== 'string') return null;
  const code = text.replace(/\s+/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

/** Eight characters, ignoring case, spaces and hyphens, or null. */
export function parsePairingCode(text) {
  if (typeof text !== 'string') return null;
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  return PAIRING_CODE_PATTERN.test(code) ? code : null;
}

export function messageForError(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : 'Something went wrong. Please try again.';
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** @returns {Promise<{ok: boolean, status: number, data: object|null, error: string}>} */
export async function sendRequest({ fetchImpl, url, method = 'POST', body, csrfToken }) {
  const headers = {};
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  // TV browsers often have AbortController but not the newer AbortSignal.timeout API.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });
    const data = await readJson(response);
    const error = response.ok ? '' : (data?.error ?? 'request_failed');
    return { ok: response.ok, status: response.status, data, error };
  } catch {
    return { ok: false, status: 0, data: null, error: 'offline' };
  } finally {
    clearTimeout(timeout);
  }
}

export function requestSignInCode(email, fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: SEND_CODE_URL, body: { email, type: 'sign-in' } });
}

/** Registration is deliberately closed unless the operator enables a bounded beta. */
export function loadRegistrationStatus(fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: REGISTRATION_URL, method: 'GET' });
}

export function verifySignInCode(email, code, fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: SIGN_IN_URL, body: { email, otp: code } });
}

export function signOut(csrfToken, fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: SIGN_OUT_URL, body: {}, csrfToken });
}

/** Resolves to {status:'signed-in', session} | {status:'signed-out'} | {status:'error', error}. */
export async function loadOwnerSession(fetchImpl = fetch) {
  const result = await sendRequest({ fetchImpl, url: SESSION_URL, method: 'GET' });
  if (result.status === 401) return { status: 'signed-out' };
  if (!result.ok) return { status: 'error', error: result.error };
  return { status: 'signed-in', session: result.data };
}

export function saveWorkspaceSettings({ csrfToken, settings, revision }, fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: SETTINGS_URL, body: { settings, revision }, csrfToken });
}

/** Resolves to {ok: true, screens} or {ok: false, error}. */
export async function loadScreens(fetchImpl = fetch) {
  const result = await sendRequest({ fetchImpl, url: SCREENS_URL, method: 'GET' });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, screens: result.data.screens };
}

export async function pairScreen({ csrfToken, code, name }, fetchImpl = fetch) {
  const result = await sendRequest({
    fetchImpl,
    url: PAIR_SCREEN_URL,
    body: { code, name },
    csrfToken,
  });
  // The sign-in page has its own wording for invalid_code; keep the two messages apart.
  if (result.error === 'invalid_code') return { ...result, error: 'invalid_pairing_code' };
  return result;
}

export function revokeScreen({ csrfToken, id }, fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: REVOKE_SCREEN_URL, body: { id }, csrfToken });
}
