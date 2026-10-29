// Network access for the live board. This is the only module that fetches, and it
// only ever calls same-origin MetricTV endpoints (snapshot and connection). Raw server
// or browser error text is never returned: callers get a status plus a fixed, safe message.
// Authorization is entirely server-side. The only secret the browser handles is the
// short-lived CSRF token from the status endpoint, which callers keep in memory only.
import { normaliseStore } from './model.js';
import { AUTHORIZE_PATH, READ_ONLY_SCOPES, validateAuthorizeUrl } from './shopify-authorize-url.js';
import { isUsableSnapshot } from './snapshot-validation.js';

// The validators moved to modules the beta pages can load without this live-only fetch code.
export { AUTHORIZE_PATH, READ_ONLY_SCOPES, validateAuthorizeUrl, isUsableSnapshot };

export const SNAPSHOT_PATH = '/api/snapshot';
export const CONNECTION_PATH = '/api/connection';
export const START_PATH = '/auth/shopify/start';
export const DISCONNECT_PATH = '/api/connection/disconnect';
export const CALLBACK_PATH = '/auth/shopify/callback';
const CONNECTION_STATES = Object.freeze({
  cli: ['cli_pilot'],
  oauth: ['setup_required', 'not_connected', 'connected', 'reconnect_required'],
});
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_\-.~+/=]{1,256}$/;
const REQUEST_TIMEOUT_MS = 12000;

export const MESSAGES = Object.freeze({
  unauthorized: 'This screen is not authorized. Connect with the owner’s Tailscale account.',
  syncing: 'The first Shopify sync is running. This page will check again automatically.',
  error: 'Shopify could not be refreshed. The server may need a new login.',
  offline: 'Cannot reach the dashboard server. Check the connection.',
  malformed: 'The dashboard server sent an unexpected response.',
  reconnect: 'Shopify access has expired or was revoked. Reconnect Shopify to see figures again.',
  notConnected: 'Shopify is not connected. Connect your store to see figures.',
  securityExpired: 'The page security check expired. It has been refreshed; please try again.',
  setupRequired: 'This server has no Shopify app credentials yet, so connecting is unavailable.',
  cliMode:
    'This server uses the Shopify CLI pilot session. Browser connect and disconnect are off.',
  rateLimited: 'Too many attempts. Wait a minute, then try again.',
  startFailed: 'Shopify authorization could not be started. Nothing was changed. Try again.',
  unsafeAuthorizeUrl: 'The server returned an unexpected Shopify address, so no redirect was made.',
  disconnectFailed: 'The local credentials could not be removed. Try again.',
});

export const CALLBACK_MESSAGES = Object.freeze({
  connected: 'Shopify authorization completed. MetricTV is checking the first sync now.',
  failed: 'Shopify authorization did not complete. Check the status below and try again if needed.',
});

/**
 * @typedef {Object} SnapshotOutcome
 * @property {'ok'|'unauthorized'|'syncing'|'error'|'offline'} status
 * @property {object} [snapshot]  present only when status is 'ok'
 * @property {string} [message]   fixed text for every other status
 */

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const SNAPSHOT_DENIALS = Object.freeze({
  401: { reauthorization_required: { status: 'reconnect_required', message: MESSAGES.reconnect } },
  409: { store_not_connected: { status: 'not_connected', message: MESSAGES.notConnected } },
  503: { setup_required: { status: 'setup_required', message: MESSAGES.setupRequired } },
});

/**
 * Loads the latest cached snapshot.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [dependencies]
 * @returns {Promise<SnapshotOutcome>}
 */
export async function fetchSnapshot({ fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(SNAPSHOT_PATH, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'offline', message: MESSAGES.offline };
  }
  const body = await readJson(response);
  // OAuth-mode denials carry a fixed error code and are not an owner-identity failure.
  const denial = SNAPSHOT_DENIALS[response.status]?.[body?.error];
  if (denial) return { status: denial.status, message: denial.message };
  if (response.status === 401 || response.status === 403) {
    return { status: 'unauthorized', message: MESSAGES.unauthorized };
  }
  if (response.ok && isUsableSnapshot(body)) return { status: 'ok', snapshot: body };
  if (!body) return { status: 'error', message: MESSAGES.malformed };
  if (body.sync?.state === 'loading') return { status: 'syncing', message: MESSAGES.syncing };
  return { status: 'error', message: MESSAGES.error };
}

function isSafeCallbackUrl(value) {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === CALLBACK_PATH
    );
  } catch {
    return false;
  }
}

/**
 * Validates the connection status response. Returns a display-only object plus the
 * CSRF token (kept separate so view code never receives it), or null if malformed.
 */
export function parseConnectionStatus(body) {
  if (!body || typeof body !== 'object') return null;
  const { mode, state, store, scopes, csrfToken, callbackUrl } = body;
  if (!CONNECTION_STATES[mode]?.includes(state)) return null;
  const normalisedStore = typeof store === 'string' ? normaliseStore(store) : null;
  const mayLackStore = state === 'cli_pilot' || state === 'setup_required';
  if (normalisedStore === null && !(mayLackStore && store === '')) return null;
  if (normalisedStore !== null && normalisedStore !== store) return null;
  const sameScopes =
    Array.isArray(scopes) &&
    scopes.length === READ_ONLY_SCOPES.length &&
    READ_ONLY_SCOPES.every((scope, index) => scopes[index] === scope);
  if (!sameScopes) return null;
  if (typeof callbackUrl !== 'string' || !isSafeCallbackUrl(callbackUrl)) return null;
  if (typeof csrfToken !== 'string' || (csrfToken !== '' && !CSRF_TOKEN_PATTERN.test(csrfToken))) {
    return null;
  }
  return {
    connection: {
      mode,
      state,
      store: store,
      scopes: [...READ_ONLY_SCOPES],
      callbackUrl,
    },
    csrfToken,
  };
}

/** True when this connection state may show store figures. Unknown (null) keeps legacy behaviour. */
export function connectionAllowsSnapshot(connection) {
  if (!connection) return true;
  return connection.state === 'cli_pilot' || connection.state === 'connected';
}

/**
 * Loads connection status.
 * @returns {Promise<{status:'ok'|'unauthorized'|'offline'|'error', connection?:object, csrfToken?:string, message?:string}>}
 */
export async function fetchConnection({ fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(CONNECTION_PATH, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'offline', message: MESSAGES.offline };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 'unauthorized', message: MESSAGES.unauthorized };
  }
  const parsed = response.ok ? parseConnectionStatus(await readJson(response)) : null;
  if (!parsed) return { status: 'error', message: MESSAGES.malformed };
  return { status: 'ok', ...parsed };
}

function actionHeaders(csrfToken) {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
}

function failureForStatus(httpStatus, fallbackMessage) {
  if (httpStatus === 401) return { status: 'unauthorized', message: MESSAGES.unauthorized };
  if (httpStatus === 403) return { status: 'security', message: MESSAGES.securityExpired };
  if (httpStatus === 429) return { status: 'rate_limited', message: MESSAGES.rateLimited };
  if (httpStatus === 503) return { status: 'setup_required', message: MESSAGES.setupRequired };
  if (httpStatus === 409) return { status: 'cli_mode', message: MESSAGES.cliMode };
  return { status: 'error', message: fallbackMessage };
}

async function postJson(path, body, csrfToken, fetchImpl, timeoutMs) {
  try {
    return await fetchImpl(path, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: actionHeaders(csrfToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
}

/**
 * Asks the server for the Shopify authorization URL for the configured store.
 * The store comes from validated status, never from user input.
 * @returns {Promise<{status:'ok', authorizationUrl:string}|{status:string, message:string}>}
 */
export async function startAuthorization({
  connection,
  csrfToken,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!connection || !csrfToken) return { status: 'security', message: MESSAGES.securityExpired };
  const response = await postJson(
    START_PATH,
    { store: connection.store },
    csrfToken,
    fetchImpl,
    timeoutMs,
  );
  if (!response) return { status: 'offline', message: MESSAGES.offline };
  if (!response.ok) return failureForStatus(response.status, MESSAGES.startFailed);
  const body = await readJson(response);
  const authorizationUrl = validateAuthorizeUrl(body?.authorizationUrl, connection);
  if (!authorizationUrl) return { status: 'error', message: MESSAGES.unsafeAuthorizeUrl };
  return { status: 'ok', authorizationUrl };
}

/**
 * Deletes the server's LOCAL Shopify credentials. This never uninstalls the app in Shopify.
 * @returns {Promise<{status:'ok'}|{status:string, message:string}>}
 */
export async function disconnectLocally({
  csrfToken,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!csrfToken) return { status: 'security', message: MESSAGES.securityExpired };
  const response = await postJson(DISCONNECT_PATH, {}, csrfToken, fetchImpl, timeoutMs);
  if (!response) return { status: 'offline', message: MESSAGES.offline };
  if (!response.ok) return failureForStatus(response.status, MESSAGES.disconnectFailed);
  const body = await readJson(response);
  if (body?.disconnected !== true) return { status: 'error', message: MESSAGES.disconnectFailed };
  return { status: 'ok' };
}

/**
 * Consumes the fixed ?connection=connected|failed callback result.
 * Returns the result (or '') and the same URL with that parameter removed.
 */
export function consumeCallbackResult({ search, hash = '', pathname = '/' }) {
  const params = new URLSearchParams(search);
  const values = params.getAll('connection');
  if (values.length === 0) return { result: '', cleanedUrl: null };
  params.delete('connection');
  const remaining = params.toString();
  const cleanedUrl = `${pathname}${remaining ? `?${remaining}` : ''}${hash}`;
  const isKnown = values.length === 1 && (values[0] === 'connected' || values[0] === 'failed');
  return { result: isKnown ? values[0] : '', cleanedUrl };
}
