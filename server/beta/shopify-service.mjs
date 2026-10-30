// Workspace-scoped Shopify connection for the invite-only beta.
//
// One shared official-SDK client; one encrypted grant file, grant manager and snapshot cache per
// linked workspace. Everything that touches a store starts from a workspace the server derived
// from a verified owner session or display session. A shop name in a request is never enough.
//
// The pilot restricts which owner and which exact store may be linked (`config`); the data model
// stays workspace-bound so lifting that restriction later does not change any isolation rule.
import crypto from 'node:crypto';
import path from 'node:path';
import { createAdminRunner } from '../shopify-admin.mjs';
import { createShopifyFetch } from '../shopify-http.mjs';
import { createShopSnapshotCache, REFRESH_MS } from '../shopify/snapshot-cache.mjs';
import { createTokenStore } from '../shopify-token-store.mjs';
import { createGrantManager } from '../shopify-grant-manager.mjs';
import {
  PENDING_ATTEMPT_TTL_MS,
  STATE_COOKIE_NAMES,
  createShopifySdk,
  forwardedHeaders,
  hasExactCallbackFields,
  parseAuthorizationUrl,
  parseQuery,
  runWithBoundedFetch,
} from '../shopify-sdk.mjs';
import { SIGNED_COOKIE_VALUE_PATTERN, readCookie } from '../http/guards.mjs';
import { createRateLimiter } from '../http/rate-limiter.mjs';
import { fetchShopLogo } from './shop-logo.mjs';
import {
  claimStore,
  consumeAttempt,
  createAttempt,
  discardAttemptsForWorkspace,
  hashesMatch,
  readLink,
  readLinkByShop,
  readLiveSession,
  readWorkspaceOwnerEmail,
  removeLink,
  restoreLink,
  setLinkState,
  sha256Hex,
  workspaceIsOwnedBy,
} from './shopify-links.mjs';

export const SHOPIFY_CALLBACK_PATH = '/auth/beta/shopify/callback';

const WORKSPACE_ID_PATTERN = /^[0-9a-f-]{36}$/;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_CONCURRENT_REFRESHES = 2;
// A logo rarely changes: check once a day, and retry sooner when a read failed.
const LOGO_RECHECK_MS = 24 * 60 * 60 * 1000;
const LOGO_RETRY_MS = 30 * 60 * 1000;
const START_RATE_LIMIT = { limit: 6, windowMs: 60_000 };
const STATES_THAT_MAY_CONNECT = new Set(['not_connected', 'connected', 'reconnect_required']);

// Dedicated cookie names: the SDK's defaults would collide with the private OAuth cookies when
// both services share a hostname (browsers key cookies by host, not by port).
const BETA_STATE_COOKIE_SUFFIXES = Object.freeze(['metrictv_beta_oauth_state', '.sig']);
const BINDING_COOKIE_BASE = 'metrictv_beta_oauth_bind';

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {{status: string}} options.config  From loadBetaShopifyConfig.
 * @param {string} options.origin  Exact public beta origin.
 */
export function createBetaShopifyService({
  database,
  config,
  origin,
  fetchImpl = fetch,
  now = Date.now,
  refreshIntervalMs = REFRESH_MS,
  fetchLogo = fetchShopLogo,
}) {
  const isReady = config.status === 'ready';
  const isSecure = new URL(origin).protocol === 'https:';
  const cookiePrefix = isSecure ? '__Secure-' : '';
  const stateCookieName = `${cookiePrefix}${BETA_STATE_COOKIE_SUFFIXES[0]}`;
  const signatureCookieName = `${stateCookieName}${BETA_STATE_COOKIE_SUFFIXES[1]}`;
  const bindingCookieName = `${cookiePrefix}${BINDING_COOKIE_BASE}`;
  const callbackUrl = `${origin}${SHOPIFY_CALLBACK_PATH}`;
  const startLimiter = createRateLimiter(START_RATE_LIMIT);
  const runtimes = new Map();
  let activeRefreshes = 0;

  let shopify = null;
  let boundedFetch = null;
  if (isReady) {
    shopify = createShopifySdk({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      origin,
    });
    boundedFetch = createShopifyFetch({
      store: config.store,
      fetchImpl,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    });
  }

  function isPilotOwner(email) {
    return isReady && typeof email === 'string' && email.toLowerCase() === config.ownerEmail;
  }

  // ---- per-workspace runtime (grant file, grant manager, snapshot cache) ----------------------

  function handleGrantChange(runtime, { state }) {
    // Any credential change makes cached figures untrustworthy; late collector results from
    // before the change are dropped by the cache's generation counter.
    runtime.cache.clear();
    runtime.lastTriggeredAt = null;
    if (state === 'reconnect_required') {
      setLinkState(database, {
        workspaceId: runtime.workspaceId,
        state: 'reconnect_required',
        nowMs: now(),
      });
    }
    if (state === 'connected') maybeRefresh(runtime);
  }

  function runtimeFor(workspaceId) {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('invalid workspace id');
    const existing = runtimes.get(workspaceId);
    if (existing) return existing;
    const tokenStore = createTokenStore({
      filePath: path.join(config.tokenDirectory, `${workspaceId}.grant.json`),
      key: config.encryptionKey,
      clientId: config.clientId,
      store: config.store,
      workspaceId,
    });
    const runtime = {
      workspaceId,
      lastTriggeredAt: null,
      logo: { image: null, nextCheckAt: 0, inflight: false },
    };
    runtime.manager = createGrantManager({
      tokenStore,
      shopify,
      boundedFetch,
      store: config.store,
      clientId: config.clientId,
      now,
      onChange: (event) => handleGrantChange(runtime, event),
    });
    runtime.cache = createShopSnapshotCache({
      store: config.store,
      run: createAdminRunner({ store: config.store, connection: runtime.manager, fetchImpl }),
      now,
    });
    runtimes.set(workspaceId, runtime);
    return runtime;
  }

  /** Background collection: one at a time per workspace, rate-spaced, globally bounded. */
  function maybeRefresh(runtime) {
    const isDue =
      runtime.lastTriggeredAt === null || now() - runtime.lastTriggeredAt >= refreshIntervalMs;
    if (!isDue || runtime.cache.inflight) return;
    if (activeRefreshes >= MAX_CONCURRENT_REFRESHES) return;
    runtime.lastTriggeredAt = now();
    activeRefreshes += 1;
    runtime.cache.refresh().finally(() => {
      activeRefreshes -= 1;
    });
  }

  /** Keeps the store logo current in the background. A failed read keeps the last good logo. */
  function maybeRefreshLogo(runtime) {
    const { logo } = runtime;
    if (logo.inflight || now() < logo.nextCheckAt) return;
    logo.inflight = true;
    fetchLogo({ store: config.store, fetchImpl })
      .then((image) => {
        logo.image = image;
        logo.nextCheckAt = now() + LOGO_RECHECK_MS;
      })
      .catch(() => {
        logo.nextCheckAt = now() + LOGO_RETRY_MS;
      })
      .finally(() => {
        logo.inflight = false;
      });
  }

  // ---- reading state --------------------------------------------------------------------------

  /**
   * The single decision about what a workspace may see. Returns { state, runtime? }. A runtime is
   * returned only for a workspace that is linked to the configured store, belongs to the pilot
   * owner, and still holds a usable grant.
   */
  async function resolve(workspaceId, ownerEmail) {
    if (!isReady) return { state: 'setup_required' };
    if (!isPilotOwner(ownerEmail)) return { state: 'pilot_unavailable' };
    const link = readLink(database, workspaceId);
    if (!link) return { state: 'not_connected' };
    if (link.shop !== config.store) return { state: 'pilot_unavailable' };
    if (link.state === 'reconnect_required') return { state: 'reconnect_required' };
    const runtime = runtimeFor(workspaceId);
    const grantState = await runtime.manager.currentState();
    // A missing or unreadable grant file is not "connected", whatever the table says.
    if (grantState !== 'connected') return { state: 'reconnect_required' };
    return { state: 'connected', runtime };
  }

  function describeConnection(resolved, ownerEmail) {
    const { state, runtime } = resolved;
    const connection = { state };
    if (isPilotOwner(ownerEmail)) {
      connection.store = config.store;
      connection.canConnect = STATES_THAT_MAY_CONNECT.has(state);
    } else {
      connection.canConnect = false;
    }
    if (runtime) {
      maybeRefresh(runtime);
      connection.sync = runtime.cache.sync();
    }
    return connection;
  }

  // ---- finishing the flow ---------------------------------------------------------------------

  function ownerStillAllowed(attempt) {
    const session = readLiveSession(database, attempt.session_id, now());
    if (!session || session.userId !== attempt.user_id) return false;
    if (!isPilotOwner(session.email)) return false;
    return workspaceIsOwnedBy(database, attempt.workspace_id, session.userId);
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
      await runtime.manager.disconnect().catch(() => {});
      runtime.cache.clear();
      return false;
    }
    return true;
  }

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

  /** Restores the SDK's own cookie names; its signature covers "name=value". */
  function buildSdkCookieHeader(request) {
    const state = readCookie(request, stateCookieName, SIGNED_COOKIE_VALUE_PATTERN);
    const signature = readCookie(request, signatureCookieName, SIGNED_COOKIE_VALUE_PATTERN);
    if (!state || !signature) return null;
    const [stateName, signatureName] = STATE_COOKIE_NAMES;
    return `${stateName}=${state}; ${signatureName}=${signature}`;
  }

  function callbackCookie(name, value) {
    const parts = [`${name}=${value}`, `Path=${SHOPIFY_CALLBACK_PATH}`, 'HttpOnly', 'SameSite=Lax'];
    parts.push(value === '' ? 'Max-Age=0' : `Max-Age=${PENDING_ATTEMPT_TTL_MS / 1000}`);
    if (isSecure) parts.push('Secure');
    return parts.join('; ');
  }

  return {
    configured: isReady,
    isPilotOwner,

    /** Owner dashboard: connection summary plus the full safe snapshot when one exists. */
    async inspect(workspaceId, ownerEmail) {
      const resolved = await resolve(workspaceId, ownerEmail);
      const connection = describeConnection(resolved, ownerEmail);
      let snapshot = null;
      if (resolved.runtime?.cache.snapshot) {
        snapshot = { ...resolved.runtime.cache.snapshot, sync: resolved.runtime.cache.sync() };
      }
      return { connection, snapshot };
    },

    /** TV: the workspace's state and its cached full snapshot; the caller projects it. */
    async inspectForDisplay(workspaceId) {
      const ownerEmail = readWorkspaceOwnerEmail(database, workspaceId);
      const resolved = await resolve(workspaceId, ownerEmail);
      const { runtime } = resolved;
      if (!runtime) return { state: resolved.state, snapshot: null, sync: null };
      maybeRefresh(runtime);
      maybeRefreshLogo(runtime);
      const sync = runtime.cache.sync();
      const logoVersion = runtime.logo.image ? runtime.logo.image.version : null;
      return { state: resolved.state, snapshot: runtime.cache.snapshot, sync, logoVersion };
    },

    /** TV: the cached logo image of a connected workspace, or null. Never fetches. */
    async logoForDisplay(workspaceId) {
      const ownerEmail = readWorkspaceOwnerEmail(database, workspaceId);
      const { runtime } = await resolve(workspaceId, ownerEmail);
      return runtime ? runtime.logo.image : null;
    },

    /** Starts the SDK flow. Returns { status: 'ok', authorizationUrl, cookies } or a denial. */
    async begin({ workspaceId, owner, sessionId, userAgent, store }) {
      if (!isReady) return { status: 'setup_required' };
      if (!isPilotOwner(owner.email)) return { status: 'pilot_unavailable' };
      if (store !== config.store) return { status: 'store_not_allowed' };
      const holder = readLinkByShop(database, config.store);
      if (holder && holder.workspace_id !== workspaceId) return { status: 'store_in_use' };
      if (!startLimiter.consume(workspaceId).allowed) return { status: 'rate_limited' };

      const sdkRequest = new Request(`${origin}/auth/beta/shopify/start`, {
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
    },

    /** Cookies that end a flow (success or failure) so nothing lingers in the browser. */
    clearingCookies() {
      return [stateCookieName, signatureCookieName, bindingCookieName].map((name) =>
        callbackCookie(name, ''),
      );
    },

    /**
     * Finishes the flow for a browser that arrives from Shopify. Returns true only when a grant
     * was stored for the workspace that started this exact attempt. Every refusal is the same
     * `false`; the caller shows one fixed failure page.
     */
    async complete(request) {
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
      if (!bindingSecret || !hashesMatch(sha256Hex(bindingSecret), attempt.binding_hash)) {
        return false;
      }
      const sdkCookieHeader = buildSdkCookieHeader(request);
      if (!sdkCookieHeader) return false;
      if (!ownerStillAllowed(attempt)) return false;

      const runtime = runtimeFor(attempt.workspace_id);
      const startingEpoch = runtime.manager.epoch;
      const sdkRequest = new Request(`${origin}${request.url}`, {
        headers: {
          cookie: sdkCookieHeader,
          ...forwardedHeaders(request, ['user-agent']),
        },
      });
      let session;
      try {
        const result = await runWithBoundedFetch(boundedFetch, () =>
          shopify.auth.callback({ expiring: true, rawRequest: sdkRequest }),
        );
        session = result.session;
      } catch {
        return false;
      }
      // The code exchange takes network time; sign-out or revocation meanwhile cancels the finish.
      if (!ownerStillAllowed(attempt)) return false;
      return installGrant(runtime, attempt, session, startingEpoch);
    },

    /** Local disconnect: link, pending attempts, cached figures and the grant file all go. */
    async disconnect({ workspaceId, ownerEmail }) {
      if (!isReady) return { status: 'setup_required' };
      if (!isPilotOwner(ownerEmail)) return { status: 'pilot_unavailable' };
      discardAttemptsForWorkspace(database, workspaceId);
      removeLink(database, workspaceId);
      const runtime = runtimeFor(workspaceId);
      let removalFailed = false;
      try {
        await runtime.manager.disconnect();
      } catch {
        removalFailed = true;
      }
      runtime.cache.clear();
      runtimes.delete(workspaceId);
      return { status: removalFailed ? 'disconnect_failed' : 'ok' };
    },
  };
}
