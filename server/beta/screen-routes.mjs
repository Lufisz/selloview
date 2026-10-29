// HTTP routes for TV pairing, display sessions and the owner's Screens list.
//
// Three kinds of caller, kept apart on purpose:
//   - an anonymous TV, identified only by its challenge cookie (pairing) or display cookie;
//   - a signed-in owner, identified by the Better Auth session (and CSRF token when changing);
//   - nobody else. A display cookie never reaches an owner route: owner routes read only the
//     Better Auth session cookie, which is a different cookie.
import {
  RequestRejection,
  assertSameOriginJson,
  buildCookie,
  readCookie,
  readJsonObject,
} from './http-guards.mjs';
import { createRateLimiter } from './rate-limiter.mjs';
import { ensureWorkspace, readWorkspaceById } from './workspaces.mjs';
import { projectBoardForDisplay } from './display-board.mjs';
import {
  CHALLENGE_LIFETIME_MS,
  DISPLAY_LIFETIME_MS,
  approveChallenge,
  createChallenge,
  discardChallenge,
  exchangeChallenge,
  formatCode,
  isScreenId,
  listScreens,
  normalizeCode,
  parseScreenName,
  readChallenge,
  readDisplaySession,
  recordDisplaySeen,
  renewDisplaySession,
  revokeScreen,
} from './screens.mjs';

export const TV_CHALLENGE_PATH = '/api/tv/challenge';
export const TV_PAIRING_PATH = '/api/tv/pairing';
export const TV_EXCHANGE_PATH = '/api/tv/pairing/exchange';
export const DISPLAY_PATH = '/api/display';
export const DISPLAY_LOGO_PATH = '/api/display/logo';
export const SCREENS_PATH = '/api/beta/screens';
export const PAIR_SCREEN_PATH = '/api/beta/screens/pair';
export const REVOKE_SCREEN_PATH = '/api/beta/screens/revoke';

const MINUTE_MS = 60 * 1000;
const CHALLENGE_COOKIE = 'metrictv_tv_challenge';
const DISPLAY_COOKIE = 'metrictv_tv_display';
const SECURE_COOKIE_PREFIX = '__Host-';
// The logo URL carries its version, so the TV may keep the image for a day without re-asking.
const LOGO_CACHE_CONTROL = 'private, max-age=86400';

function describeDisplayConnection({ state, sync }) {
  if (!sync) return { state };
  return { state, sync: { state: sync.state, errorCode: sync.errorCode } };
}

/** One limiter per kind of event; each limiter keeps its own bounded set of keys. */
function createLimiters() {
  return {
    createChallengePerAddress: createRateLimiter({ limit: 6, windowMs: MINUTE_MS }),
    tvRequestPerAddress: createRateLimiter({ limit: 240, windowMs: MINUTE_MS }),
    pollPerChallenge: createRateLimiter({ limit: 40, windowMs: MINUTE_MS }),
    pollPerDisplay: createRateLimiter({ limit: 30, windowMs: MINUTE_MS }),
    pairAttemptPerOwner: createRateLimiter({ limit: 10, windowMs: MINUTE_MS }),
    failedCodePerOwner: createRateLimiter({ limit: 5, windowMs: CHALLENGE_LIFETIME_MS }),
  };
}

/**
 * @param {object} dependencies
 * @param {import('node:sqlite').DatabaseSync} dependencies.database
 * @param {string} dependencies.origin
 * @param {(response, status, body, extraHeaders?) => void} dependencies.reply
 * @param {Record<string, string>} dependencies.responseHeaders  security headers for every reply
 * @param {(request) => Promise<object|null>} dependencies.lookupSession  Owner session or null.
 * @param {(request, response) => Promise<object|null>} dependencies.requireCsrfSession
 *   Owner session after the CSRF check, or null after having sent the denial.
 * @param {(request) => string} dependencies.clientAddress
 * @param {{inspectForDisplay: (workspaceId: string) => Promise<object>,
 *   logoForDisplay: (workspaceId: string) => Promise<object|null>}} dependencies.shopify
 * @param {() => string} dependencies.appVersion  fingerprint of the served page files
 * @returns {Map<string, Function>} handlers keyed by `METHOD /path`
 */
export function createScreenRoutes({
  database,
  origin,
  reply,
  responseHeaders,
  lookupSession,
  requireCsrfSession,
  clientAddress,
  shopify,
  appVersion,
}) {
  const secure = new URL(origin).protocol === 'https:';
  const cookiePrefix = secure ? SECURE_COOKIE_PREFIX : '';
  const challengeCookieName = `${cookiePrefix}${CHALLENGE_COOKIE}`;
  const displayCookieName = `${cookiePrefix}${DISPLAY_COOKIE}`;
  const limiters = createLimiters();

  function setCookie(name, value, maxAgeMs) {
    const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
    return buildCookie({ name, value, maxAgeSeconds, secure });
  }

  function clearCookieHeaders(name) {
    return { 'Set-Cookie': setCookie(name, '', 0) };
  }

  /** Sends 429 and returns true when the limiter refuses. */
  function refuseWhenLimited(response, verdict) {
    if (verdict.allowed) return false;
    const headers = { 'Retry-After': String(verdict.retryAfterSeconds) };
    reply(response, 429, { error: 'rate_limited' }, headers);
    return true;
  }

  function limitedByAddress(request, response) {
    const verdict = limiters.tvRequestPerAddress.consume(clientAddress(request));
    return refuseWhenLimited(response, verdict);
  }

  // ---- TV: pairing --------------------------------------------------------------------------

  async function createTvChallenge(request, response) {
    assertSameOriginJson(request, origin);
    await readJsonObject(request, []);
    const verdict = limiters.createChallengePerAddress.consume(clientAddress(request));
    if (refuseWhenLimited(response, verdict)) return;

    // A TV asking again replaces its own earlier challenge, so one page holds at most one.
    discardChallenge(database, readCookie(request, challengeCookieName));
    const created = createChallenge(database);
    if (!created) return reply(response, 503, { error: 'busy' });
    const body = {
      code: formatCode(created.code),
      expiresAt: new Date(created.expiresAt).toISOString(),
    };
    const cookie = setCookie(challengeCookieName, created.credential, CHALLENGE_LIFETIME_MS);
    return reply(response, 201, body, { 'Set-Cookie': cookie });
  }

  // The challenge secret, not the visible code, is what identifies this TV from here on.
  function ownChallenge(request, response) {
    if (limitedByAddress(request, response)) return null;
    const challenge = readChallenge(database, readCookie(request, challengeCookieName));
    if (!challenge) {
      reply(response, 404, { error: 'invalid_challenge' }, clearCookieHeaders(challengeCookieName));
      return null;
    }
    if (refuseWhenLimited(response, limiters.pollPerChallenge.consume(challenge.id))) return null;
    return challenge;
  }

  function serveTvPairing(request, response) {
    const challenge = ownChallenge(request, response);
    if (!challenge) return;
    return reply(response, 200, {
      state: challenge.state,
      expiresAt: new Date(challenge.expires_at).toISOString(),
    });
  }

  async function exchangeTvPairing(request, response) {
    assertSameOriginJson(request, origin);
    await readJsonObject(request, []);
    if (!ownChallenge(request, response)) return;
    const result = exchangeChallenge(database, readCookie(request, challengeCookieName));
    if (result.status === 'pending') return reply(response, 409, { error: 'not_approved' });
    if (result.status !== 'ok') {
      return reply(
        response,
        404,
        { error: 'invalid_challenge' },
        clearCookieHeaders(challengeCookieName),
      );
    }
    // One response, two cookies: retire the challenge and start the display session.
    const cookies = [
      setCookie(challengeCookieName, '', 0),
      setCookie(displayCookieName, result.credential, DISPLAY_LIFETIME_MS),
    ];
    return reply(response, 200, { ok: true }, { 'Set-Cookie': cookies });
  }

  // ---- TV: display --------------------------------------------------------------------------

  /**
   * The paired screen behind this request, within its rate limit and with activity recorded.
   * Returns { session, credential }, or null after having sent the refusal.
   */
  function requireDisplaySession(request, response) {
    if (limitedByAddress(request, response)) return null;
    const credential = readCookie(request, displayCookieName);
    const session = readDisplaySession(database, credential);
    if (!session) {
      reply(response, 401, { error: 'unauthenticated' }, clearCookieHeaders(displayCookieName));
      return null;
    }
    if (refuseWhenLimited(response, limiters.pollPerDisplay.consume(session.id))) return null;
    recordDisplaySeen(database, session);
    return { session, credential };
  }

  async function serveDisplay(request, response) {
    const paired = requireDisplaySession(request, response);
    if (!paired) return;
    const { session, credential } = paired;
    // A renewed session also needs a renewed cookie, or the browser would drop it on day 30.
    const renewedUntil = renewDisplaySession(database, session);
    const renewalHeaders = renewedUntil
      ? { 'Set-Cookie': setCookie(displayCookieName, credential, DISPLAY_LIFETIME_MS) }
      : {};
    const workspace = readWorkspaceById(database, session.workspace_id);
    // Display data only: the screen's name, the workspace's appearance and an honest connection
    // state. No owner, workspace id, CSRF token or credential of any kind.
    const view = await shopify.inspectForDisplay(session.workspace_id);
    const body = {
      screen: { name: session.name },
      revision: workspace.revision,
      settings: workspace.settings,
      // The TV measures data age against the server's clock, not its own.
      serverTime: new Date().toISOString(),
      // The TV reloads itself when this changes, so it picks up new page code without a visit.
      appVersion: appVersion(),
      storeConnection: describeDisplayConnection(view),
    };
    if (view.snapshot) {
      body.board = projectBoardForDisplay(view.snapshot, view.sync, view.logoVersion);
    }
    return reply(response, 200, body, renewalHeaders);
  }

  /** The store logo for this screen's own workspace; 404 when there is none (yet). */
  async function serveDisplayLogo(request, response) {
    const paired = requireDisplaySession(request, response);
    if (!paired) return;
    const logo = await shopify.logoForDisplay(paired.session.workspace_id);
    if (!logo) return reply(response, 404, { error: 'not_found' });
    response.writeHead(200, {
      ...responseHeaders,
      'Cache-Control': LOGO_CACHE_CONTROL,
      'Content-Type': logo.contentType,
      'Content-Length': logo.bytes.length,
    });
    response.end(logo.bytes);
  }

  // ---- Owner: screens -----------------------------------------------------------------------

  async function serveScreenList(request, response) {
    const sessionData = await lookupSession(request);
    if (!sessionData) return reply(response, 401, { error: 'unauthenticated' });
    const workspace = ensureWorkspace(database, sessionData.user.id);
    return reply(response, 200, { screens: listScreens(database, workspace.id) });
  }

  async function pairScreen(request, response) {
    assertSameOriginJson(request, origin);
    const sessionData = await requireCsrfSession(request, response);
    if (!sessionData) return;
    const ownerId = sessionData.user.id;
    const body = await readJsonObject(request, ['code', 'name']);
    if (refuseWhenLimited(response, limiters.pairAttemptPerOwner.consume(ownerId))) return;
    // Checked before the lookup, so a locked-out owner learns nothing from further guesses.
    if (refuseWhenLimited(response, limiters.failedCodePerOwner.peek(ownerId))) return;

    const screenName = parseScreenName(body.name);
    if (!screenName) throw new RequestRejection(400, 'invalid_name');

    const code = normalizeCode(body.code);
    const workspace = ensureWorkspace(database, ownerId);
    const outcome = code
      ? approveChallenge(database, { workspaceId: workspace.id, code, screenName })
      : 'invalid_code';
    if (outcome === 'invalid_code') {
      limiters.failedCodePerOwner.consume(ownerId);
      return reply(response, 400, { error: 'invalid_code' });
    }
    if (outcome === 'screen_limit') return reply(response, 409, { error: 'screen_limit' });
    return reply(response, 200, { status: 'approved', name: screenName });
  }

  async function revokeOwnerScreen(request, response) {
    assertSameOriginJson(request, origin);
    const sessionData = await requireCsrfSession(request, response);
    if (!sessionData) return;
    const body = await readJsonObject(request, ['id']);
    if (!isScreenId(body.id)) throw new RequestRejection(400, 'invalid_request');
    const workspace = ensureWorkspace(database, sessionData.user.id);
    // Another owner's screen answers exactly like a screen that does not exist.
    if (!revokeScreen(database, workspace.id, body.id)) {
      return reply(response, 404, { error: 'not_found' });
    }
    return reply(response, 200, { status: 'revoked' });
  }

  return new Map([
    [`POST ${TV_CHALLENGE_PATH}`, createTvChallenge],
    [`GET ${TV_PAIRING_PATH}`, serveTvPairing],
    [`POST ${TV_EXCHANGE_PATH}`, exchangeTvPairing],
    [`GET ${DISPLAY_PATH}`, serveDisplay],
    [`GET ${DISPLAY_LOGO_PATH}`, serveDisplayLogo],
    [`GET ${SCREENS_PATH}`, serveScreenList],
    [`POST ${PAIR_SCREEN_PATH}`, pairScreen],
    [`POST ${REVOKE_SCREEN_PATH}`, revokeOwnerScreen],
  ]);
}
