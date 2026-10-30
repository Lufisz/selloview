// Connecting a store: the owner starts Shopify's authorization, Shopify sends the browser back with a
// code, and the resulting grant is stored for the workspace that started it.
//
// The callback is a cross-site navigation, so the owner's SameSite=Strict session cookie is absent
// by design. The browser proves itself with what only it holds instead: the SDK's signed state
// cookies, and a short-lived binding cookie whose hash is stored with a single-use attempt. Every
// refusal looks the same to the caller; the browser is shown one fixed failure page.
import crypto from 'node:crypto';
import {
  PENDING_ATTEMPT_TTL_MS,
  STATE_COOKIE_NAMES,
  forwardedHeaders,
  hasExactCallbackFields,
  parseAuthorizationUrl,
  parseQuery,
  runWithBoundedFetch,
} from './sdk.mjs';
import { SIGNED_COOKIE_VALUE_PATTERN, readCookie } from '../http/guards.mjs';
import { createRateLimiter } from '../http/rate-limiter.mjs';
import { constantTimeEqual, sha256Hex } from '../hashing.mjs';
import { logEvent } from '../log.mjs';
import {
  claimStore,
  consumeAttempt,
  createAttempt,
  readLink,
  readLinkByShop,
  readLiveSession,
  removeLink,
  restoreLink,
  workspaceIsOwnedBy,
} from './links.mjs';

// The redirect URL registered in each operator's Shopify app. The path is part of that
// registration, so it never changes.
export const SHOPIFY_CALLBACK_PATH = '/auth/beta/shopify/callback';

const START_RATE_LIMIT = { limit: 6, windowMs: 60_000 };

// Dedicated cookie names: the SDK's defaults would collide with other OAuth cookies when services
// share a hostname (browsers key cookies by host, not by port). The names keep their original
// prefix so an authorization that is in flight during an upgrade still completes.
const OAUTH_STATE_COOKIE_SUFFIXES = Object.freeze(['metrictv_beta_oauth_state', '.sig']);
const BINDING_COOKIE_BASE = 'metrictv_beta_oauth_bind';

// The SDK's state cookie and its signature, from the Set-Cookie headers of its answer.
function readSdkStateCookies(setCookieHeaders) {
  const values = new Map();
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator > 0) values.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const [stateName, signatureName] = STATE_COOKIE_NAMES;
  const state = values.get(stateName);
  const signature = values.get(signatureName);
  if (!state || !signature) return null;
  return { state, signature };
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {{store: string, clientId: string}} options.config  From loadShopifyConfig.
 * @param {string} options.origin  Exact public origin.
 * @param {boolean} options.isReady  False while the operator has not configured Shopify.
 * @param {(email: string) => boolean} options.isAllowedOwner
 * @param {object} options.shopify  Official SDK client from createShopifySdk.
 * @param {Function} options.boundedFetch  Transport from createShopifyFetch for the store.
 * @param {ReturnType<import('./workspace-runtimes.mjs').createWorkspaceRuntimes>} options.runtimes
 * @param {() => number} options.now
 */
export function createConnectFlow({
  database,
  config,
  origin,
  isReady,
  isAllowedOwner,
  shopify,
  boundedFetch,
  runtimes,
  now,
}) {
  const isSecure = new URL(origin).protocol === 'https:';
  const cookiePrefix = isSecure ? '__Secure-' : '';
  const stateCookieName = `${cookiePrefix}${OAUTH_STATE_COOKIE_SUFFIXES[0]}`;
  const signatureCookieName = `${stateCookieName}${OAUTH_STATE_COOKIE_SUFFIXES[1]}`;
  const bindingCookieName = `${cookiePrefix}${BINDING_COOKIE_BASE}`;
  const callbackUrl = `${origin}${SHOPIFY_CALLBACK_PATH}`;
  const startLimiter = createRateLimiter(START_RATE_LIMIT);

  function callbackCookie(name, value) {
    const parts = [`${name}=${value}`, `Path=${SHOPIFY_CALLBACK_PATH}`, 'HttpOnly', 'SameSite=Lax'];
    parts.push(value === '' ? 'Max-Age=0' : `Max-Age=${PENDING_ATTEMPT_TTL_MS / 1000}`);
    if (isSecure) parts.push('Secure');
    return parts.join('; ');
  }

  /** Restores the SDK's own cookie names; its signature covers "name=value". */
  function buildSdkCookieHeader(request) {
    const state = readCookie(request, stateCookieName, SIGNED_COOKIE_VALUE_PATTERN);
    const signature = readCookie(request, signatureCookieName, SIGNED_COOKIE_VALUE_PATTERN);
    if (!state || !signature) return null;
    const [stateName, signatureName] = STATE_COOKIE_NAMES;
    return `${stateName}=${state}; ${signatureName}=${signature}`;
  }

  // ---- starting -------------------------------------------------------------------------------

  // Asks the SDK for the authorization URL and its signed state cookies. Returns
  // { status: 'ok', authorization, sdkCookies }, or a denial status when the SDK fails or answers
  // with anything else than a redirect.
  async function startSdkAuthorization(userAgent) {
    // The SDK reads only the user agent from this request; its URL is never served.
    const sdkRequest = new Request(`${origin}/api/shopify/start`, {
      method: 'POST',
      headers: typeof userAgent === 'string' ? { 'user-agent': userAgent } : {},
    });
    let sdkResponse;
    try {
      sdkResponse = await runWithBoundedFetch(boundedFetch, () =>
        shopify.auth.begin({
          shop: config.store,
          callbackPath: SHOPIFY_CALLBACK_PATH,
          isOnline: false,
          rawRequest: sdkRequest,
        }),
      );
    } catch {
      return { status: 'start_failed' };
    }
    if (sdkResponse.status === 410) return { status: 'unsupported_client' };
    const authorization = parseAuthorizationUrl(sdkResponse.headers.get('location') ?? '', {
      store: config.store,
      clientId: config.clientId,
      callbackUrl,
    });
    const sdkCookies = readSdkStateCookies(sdkResponse.headers.getSetCookie());
    if (sdkResponse.status !== 302 || !authorization || !sdkCookies) {
      return { status: 'start_failed' };
    }
    return { status: 'ok', authorization, sdkCookies };
  }

  /** Starts the SDK flow. Returns { status: 'ok', authorizationUrl, cookies } or a denial. */
  async function begin({ workspaceId, owner, sessionId, userAgent, store }) {
    if (!isReady) return { status: 'setup_required' };
    if (!isAllowedOwner(owner.email)) return { status: 'owner_not_allowed' };
    if (store !== config.store) return { status: 'store_not_allowed' };
    const holder = readLinkByShop(database, config.store);
    if (holder && holder.workspace_id !== workspaceId) return { status: 'store_in_use' };
    if (!startLimiter.consume(workspaceId).allowed) return { status: 'rate_limited' };

    const started = await startSdkAuthorization(userAgent);
    if (started.status !== 'ok') return { status: started.status };
    const { authorization, sdkCookies } = started;

    const bindingSecret = crypto.randomBytes(32).toString('base64url');
    const recorded = createAttempt(database, {
      state: authorization.state,
      bindingSecret,
      workspaceId,
      userId: owner.id,
      sessionId,
      shop: config.store,
      nowMs: now(),
      lifetimeMs: PENDING_ATTEMPT_TTL_MS,
    });
    if (!recorded) return { status: 'busy' };
    return {
      status: 'ok',
      authorizationUrl: authorization.href,
      cookies: [
        callbackCookie(stateCookieName, sdkCookies.state),
        callbackCookie(signatureCookieName, sdkCookies.signature),
        callbackCookie(bindingCookieName, bindingSecret),
      ],
    };
  }

  /** Cookies that end a flow (success or failure) so nothing lingers in the browser. */
  function clearingCookies() {
    return [stateCookieName, signatureCookieName, bindingCookieName].map((name) =>
      callbackCookie(name, ''),
    );
  }

  // ---- finishing ------------------------------------------------------------------------------

  function ownerStillAllowed(attempt) {
    const session = readLiveSession(database, attempt.session_id, now());
    if (!session || session.userId !== attempt.user_id) return false;
    if (!isAllowedOwner(session.email)) return false;
    return workspaceIsOwnedBy(database, attempt.workspace_id, session.userId);
  }

  // Lets the SDK check the signed state and exchange the code. Returns the session, or null.
  async function exchangeCode(request, sdkCookieHeader) {
    const sdkRequest = new Request(`${origin}${request.url}`, {
      headers: {
        cookie: sdkCookieHeader,
        ...forwardedHeaders(request, ['user-agent']),
      },
    });
    try {
      const result = await runWithBoundedFetch(boundedFetch, () =>
        shopify.auth.callback({ expiring: true, rawRequest: sdkRequest }),
      );
      return result.session;
    } catch {
      return null;
    }
  }

  async function installGrant(runtime, attempt, session, startingEpoch) {
    const previous = readLink(database, attempt.workspace_id);
    const claim = claimStore(database, {
      workspaceId: attempt.workspace_id,
      shop: attempt.shop,
      state: 'connected',
      nowMs: now(),
    });
    if (claim !== 'ok') return false;
    const installed = await runtime.manager.installSession(session, startingEpoch);
    if (!installed) {
      restoreLink(database, { workspaceId: attempt.workspace_id, previous, nowMs: now() });
      return false;
    }
    if (!ownerStillAllowed(attempt)) {
      // Signed out while the grant was being written: undo it completely.
      removeLink(database, attempt.workspace_id);
      // A grant file that could not be removed stays encrypted and unused until the next connect
      // replaces it, but the operator should know about it.
      await runtime.manager.disconnect().catch((error) => {
        logEvent('grant_cleanup_failed', {
          workspaceId: attempt.workspace_id,
          error: error?.name ?? 'Error',
        });
      });
      runtime.cache.clear();
      return false;
    }
    return true;
  }

  /**
   * Finishes the flow for a browser that arrives from Shopify. Returns true only when a grant
   * was stored for the workspace that started this exact attempt. Every refusal is the same
   * `false`; the caller shows one fixed failure page.
   */
  async function complete(request) {
    if (!isReady) return false;
    const query = parseQuery(request.url ?? '');
    if (!query || !hasExactCallbackFields(query)) return false;
    const attempt = consumeAttempt(database, query.get('state'));
    if (!attempt) return false;
    if (attempt.expires_at <= now()) return false;
    if (query.get('shop') !== attempt.shop || attempt.shop !== config.store) return false;

    // The owner's SameSite=Strict cookie is not sent on this cross-site navigation, so the
    // browser proves itself with the short-lived binding cookie instead.
    const bindingSecret = readCookie(request, bindingCookieName);
    if (!bindingSecret || !constantTimeEqual(sha256Hex(bindingSecret), attempt.binding_hash)) {
      return false;
    }
    const sdkCookieHeader = buildSdkCookieHeader(request);
    if (!sdkCookieHeader) return false;
    if (!ownerStillAllowed(attempt)) return false;

    const runtime = runtimes.forWorkspace(attempt.workspace_id);
    const startingEpoch = runtime.manager.epoch;
    const session = await exchangeCode(request, sdkCookieHeader);
    if (!session) return false;
    // The code exchange takes network time; sign-out or revocation meanwhile cancels the finish.
    if (!ownerStillAllowed(attempt)) return false;
    return installGrant(runtime, attempt, session, startingEpoch);
  }

  return { begin, complete, clearingCookies };
}
