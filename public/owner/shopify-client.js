// Browser API for the owner's Shopify connection on the owner page. Same-origin requests only.
// Authorization is entirely server-side: the page never sees a token, a secret or a grant; the only
// secret it holds is the short-lived CSRF token from the session endpoint, in memory.
import { normaliseStore } from '../shared/format.js';
import { sendRequest } from './owner-client.js';
import { validateAuthorizeUrl } from './shopify-authorize-url.js';
import { isUsableSnapshot } from '../shared/snapshot-validation.js';

export const SHOPIFY_STATUS_URL = '/api/shopify';
export const SHOPIFY_START_URL = '/api/shopify/start';
export const SHOPIFY_DISCONNECT_URL = '/api/shopify/disconnect';
// The redirect path registered in the operator's Shopify app; the server uses the same value.
// It keeps its original name because renaming it would break every existing registration.
export const SHOPIFY_CALLBACK_PATH = '/auth/beta/shopify/callback';

const CONNECTION_STATES = Object.freeze([
  'setup_required',
  'owner_not_allowed',
  'not_connected',
  'connected',
  'reconnect_required',
]);
const SYNC_STATES = Object.freeze(['loading', 'ok', 'stale', 'error']);

/** Canonical store domain, or null. Mirrors the server, which accepts only this exact form. */
export function parseStoreDomain(text) {
  if (typeof text !== 'string') return null;
  return normaliseStore(text);
}

/** A connection summary the page may render, or null when the server sent something odd. */
export function parseConnection(value) {
  if (!value || typeof value !== 'object') return null;
  if (!CONNECTION_STATES.includes(value.state)) return null;
  const store = value.store === undefined ? '' : parseStoreDomain(value.store);
  if (store === null || (store !== '' && store !== value.store)) return null;
  const sync = value.sync;
  if (sync !== undefined && !(sync && SYNC_STATES.includes(sync.state))) return null;
  return {
    state: value.state,
    store,
    canConnect: value.canConnect === true,
    sync: sync === undefined ? null : sync,
  };
}

/**
 * Resolves to {ok: true, connection, snapshot} or {ok: false, error}. A snapshot that fails the
 * shared validator is dropped (no figures) rather than rendered.
 */
export async function loadShopifyStatus(fetchImpl = fetch) {
  const result = await sendRequest({ fetchImpl, url: SHOPIFY_STATUS_URL, method: 'GET' });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  const connection = parseConnection(result.data && result.data.connection);
  if (!connection) return { ok: false, status: result.status, error: 'malformed' };
  const candidate = result.data.snapshot;
  const hasSnapshot = connection.state === 'connected' && isUsableSnapshot(candidate);
  return { ok: true, connection, snapshot: hasSnapshot ? candidate : null };
}

/**
 * Asks the server to start Shopify authorization for the entered store. Resolves to
 * {ok: true, authorizationUrl} where the URL passed the shared Shopify-address check, or
 * {ok: false, error}.
 */
export async function startShopifyConnection(
  { csrfToken, storeText, callbackUrl },
  fetchImpl = fetch,
) {
  const store = parseStoreDomain(storeText);
  if (!store) return { ok: false, error: 'invalid_store' };
  const result = await sendRequest({
    fetchImpl,
    url: SHOPIFY_START_URL,
    body: { store },
    csrfToken,
  });
  if (!result.ok) return { ok: false, error: result.error };
  const authorizationUrl = validateAuthorizeUrl(result.data && result.data.authorizationUrl, {
    store,
    callbackUrl,
  });
  if (!authorizationUrl) return { ok: false, error: 'unsafe_authorize_url' };
  return { ok: true, authorizationUrl };
}

/** Removes the server's saved Shopify access for this workspace. Never uninstalls the app. */
export async function disconnectShopify({ csrfToken }, fetchImpl = fetch) {
  const result = await sendRequest({
    fetchImpl,
    url: SHOPIFY_DISCONNECT_URL,
    body: {},
    csrfToken,
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data || result.data.disconnected !== true) {
    return { ok: false, error: 'disconnect_failed' };
  }
  return { ok: true };
}

/** Consumes the fixed ?shopify=connected|failed result of the callback redirect. */
export function consumeShopifyReturn({ search, hash = '', pathname = '/' }) {
  const params = new URLSearchParams(search);
  const values = params.getAll('shopify');
  if (values.length === 0) return { result: '', cleanedUrl: null };
  params.delete('shopify');
  const remaining = params.toString();
  const cleanedUrl = `${pathname}${remaining ? `?${remaining}` : ''}${hash}`;
  const isKnown = values.length === 1 && (values[0] === 'connected' || values[0] === 'failed');
  return { result: isKnown ? values[0] : '', cleanedUrl };
}
