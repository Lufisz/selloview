// Pieces of the official Shopify SDK integration: the outbound bridge, grant validation and the
// parsers for the OAuth redirect and callback. connect-flow.mjs and workspace-runtimes.mjs use them.
import { AsyncLocalStorage } from 'node:async_hooks';
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/web-api';
import { setAbstractFetchFunc } from '@shopify/shopify-api/runtime';
import { ShopifyError } from './shop-data.mjs';
import { REQUIRED_SCOPES, hasExactRequiredScopes } from './token-store.mjs';

export const MAX_QUERY_VALUE_LENGTH = 512;
// The SDK's own state cookie lives 60 s; a merchant may need longer to sign in to Shopify.
export const PENDING_ATTEMPT_TTL_MS = 5 * 60_000;
const CALLBACK_QUERY_FIELDS = new Set(['code', 'hmac', 'host', 'shop', 'state', 'timestamp']);
const REQUIRED_CALLBACK_FIELDS = ['code', 'hmac', 'shop', 'state', 'timestamp'];
// Cookie names the SDK reads and writes. The signature covers "name=value", so a caller that
// renames them on the wire must restore these exact names before handing the request back.
export const STATE_COOKIE_NAMES = ['shopify_app_state', 'shopify_app_state.sig'];

// ---------------------------------------------------------------------------------------------
// SDK outbound bridge. The SDK has ONE process-wide fetch hook, so install a single bridge that
// dispatches to the service-scoped bounded transport of the call that is currently running.
// An SDK request made outside such a context is refused.
// ---------------------------------------------------------------------------------------------

const fetchContext = new AsyncLocalStorage();

setAbstractFetchFunc(async (url, options) => {
  const context = fetchContext.getStore();
  if (!context) throw new ShopifyError('api_error');
  const response = await context.boundedFetch(url, options);
  context.lastStatus = response.status;
  return response;
});

export function runWithBoundedFetch(boundedFetch, task) {
  const context = { boundedFetch, lastStatus: null };
  return fetchContext.run(context, () => task(context));
}

/**
 * Official SDK client for a standalone, non-embedded app. `origin` is the exact public origin
 * whose host and scheme form the redirect URL Shopify sends the browser back to.
 */
export function createShopifySdk({ clientId, clientSecret, origin }) {
  const parsedOrigin = new URL(origin);
  return shopifyApi({
    apiKey: clientId,
    apiSecretKey: clientSecret,
    scopes: [...REQUIRED_SCOPES],
    hostName: parsedOrigin.host,
    hostScheme: parsedOrigin.protocol === 'http:' ? 'http' : 'https',
    apiVersion: ApiVersion.July26,
    isEmbeddedApp: false,
    // Safe no-op logger: the SDK would otherwise print shop names, states and request details.
    logger: { level: LogSeverity.Error, log: () => {}, httpRequests: false, timestamps: false },
  });
}

/** Convert an SDK offline session into a persisted grant, or throw if it is not acceptable. */
export function grantFromSession(session, { store, clientId, now }) {
  const scopes = String(session.scope ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (session.isOnline) throw new ShopifyError('bad_token_response');
  if (session.shop !== store) throw new ShopifyError('bad_token_response');
  if (!hasExactRequiredScopes(scopes)) throw new ShopifyError('unexpected_scopes');
  if (!session.expires || !session.refreshToken || !session.refreshTokenExpires) {
    throw new ShopifyError('bad_token_response');
  }
  // The SDK computes expiry from the wall clock; re-base it on the injected clock.
  const sdkNow = Date.now();
  const current = now();
  return {
    shop: store,
    clientId,
    offline: true,
    scopes,
    accessToken: session.accessToken,
    accessTokenExpiresAt: current + (session.expires.getTime() - sdkNow),
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: current + (session.refreshTokenExpires.getTime() - sdkNow),
    savedAt: current,
  };
}

/** Check the SDK's redirect really is the fixed authorize URL for our app and store. */
export function parseAuthorizationUrl(location, { store, clientId, callbackUrl }) {
  let url;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  const expected = {
    client_id: clientId,
    scope: REQUIRED_SCOPES.join(','),
    redirect_uri: callbackUrl,
  };
  const isFixedTarget =
    url.protocol === 'https:' &&
    url.host === store &&
    url.pathname === '/admin/oauth/authorize' &&
    !url.username &&
    !url.password &&
    !url.hash;
  if (!isFixedTarget) return null;
  for (const [name, value] of Object.entries(expected)) {
    if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== value) {
      return null;
    }
  }
  const state = url.searchParams.get('state');
  if (url.searchParams.getAll('state').length !== 1 || !state) return null;
  return { href: url.href, state };
}

/** Query parameters as a Map; null for duplicate keys, oversized values or a malformed URL. */
export function parseQuery(requestUrl) {
  let parsed;
  try {
    parsed = new URL(requestUrl, 'http://placeholder.invalid');
  } catch {
    return null;
  }
  const values = new Map();
  for (const [key, value] of parsed.searchParams) {
    if (values.has(key)) return null;
    if (key.length > 64 || value.length > MAX_QUERY_VALUE_LENGTH) return null;
    values.set(key, value);
  }
  return values;
}

/** True when the callback query has exactly the fields Shopify sends, all non-empty. */
export function hasExactCallbackFields(query) {
  for (const key of query.keys()) {
    if (!CALLBACK_QUERY_FIELDS.has(key)) return false;
  }
  for (const key of REQUIRED_CALLBACK_FIELDS) {
    if (!query.get(key)) return false;
  }
  return true;
}

/** Copy only the named headers; the SDK's bot filter reads the real User-Agent. */
export function forwardedHeaders(request, names) {
  const headers = {};
  for (const name of names) {
    if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
  }
  return headers;
}
