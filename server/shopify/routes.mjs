// HTTP routes for the owner's Shopify connection. Owner routes need the Better Auth session
// (and, when changing anything, exact Origin, JSON and the session-bound CSRF token). The OAuth
// callback is different: it arrives from Shopify as a cross-site navigation, so the SameSite=Strict
// session cookie is absent by design. It is authorized by the signed SDK state, the single-use
// pending attempt and the path-scoped binding cookie instead (see connection-service.mjs).
import { validateStore } from './shop-data.mjs';
import { RequestRejection, assertSameOriginJson, readJsonObject } from '../http/guards.mjs';
import { createRateLimiter } from '../http/rate-limiter.mjs';
import { ensureWorkspace } from '../accounts/workspaces.mjs';
import { SHOPIFY_CALLBACK_PATH } from './connection-service.mjs';

export const SHOPIFY_STATUS_PATH = '/api/shopify';
export const SHOPIFY_START_PATH = '/api/shopify/start';
export const SHOPIFY_DISCONNECT_PATH = '/api/shopify/disconnect';
export { SHOPIFY_CALLBACK_PATH };

const MINUTE_MS = 60 * 1000;
const CONNECTED_REDIRECT = '/?shopify=connected';
const FAILED_REDIRECT = '/?shopify=failed';

// Fixed HTTP answers for the refusals the service can report on start.
const START_DENIALS = Object.freeze({
  setup_required: { status: 503, error: 'setup_required' },
  pilot_unavailable: { status: 403, error: 'pilot_unavailable' },
  store_not_allowed: { status: 403, error: 'store_not_allowed' },
  store_in_use: { status: 409, error: 'store_in_use' },
  rate_limited: { status: 429, error: 'rate_limited' },
  unsupported_client: { status: 400, error: 'unsupported_client' },
  busy: { status: 429, error: 'rate_limited' },
  start_failed: { status: 502, error: 'start_failed' },
});

/**
 * @param {object} dependencies
 * @param {ReturnType<import('./connection-service.mjs').createBetaShopifyService>} dependencies.shopify
 * @param {import('node:sqlite').DatabaseSync} dependencies.database
 * @param {string} dependencies.origin
 * @param {Readonly<Record<string, string>>} dependencies.responseHeaders  Security headers.
 * @param {(request) => string} dependencies.clientAddress
 */
export function createShopifyRoutes({
  shopify,
  database,
  origin,
  reply,
  responseHeaders,
  lookupSession,
  requireCsrfSession,
  clientAddress,
}) {
  const callbackLimiter = createRateLimiter({ limit: 30, windowMs: MINUTE_MS });

  async function serveStatus(request, response) {
    const sessionData = await lookupSession(request);
    if (!sessionData) return reply(response, 401, { error: 'unauthenticated' });
    const workspace = ensureWorkspace(database, sessionData.user.id);
    const view = await shopify.inspect(workspace.id, sessionData.user.email);
    return reply(response, 200, view);
  }

  async function startConnection(request, response) {
    assertSameOriginJson(request, origin);
    const sessionData = await requireCsrfSession(request, response);
    if (!sessionData) return;
    const body = await readJsonObject(request, ['store']);
    try {
      validateStore(body.store);
    } catch {
      throw new RequestRejection(400, 'invalid_store');
    }
    // The workspace and owner come from the verified session, never from the request body.
    const workspace = ensureWorkspace(database, sessionData.user.id);
    const result = await shopify.begin({
      workspaceId: workspace.id,
      owner: { id: sessionData.user.id, email: sessionData.user.email },
      sessionId: sessionData.session.id,
      userAgent: request.headers['user-agent'],
      store: body.store,
    });
    if (result.status !== 'ok') {
      const denial = START_DENIALS[result.status] ?? START_DENIALS.start_failed;
      const headers = denial.status === 429 ? { 'Retry-After': '60' } : {};
      return reply(response, denial.status, { error: denial.error }, headers);
    }
    return reply(
      response,
      200,
      { authorizationUrl: result.authorizationUrl },
      { 'Set-Cookie': result.cookies },
    );
  }

  async function disconnectConnection(request, response) {
    assertSameOriginJson(request, origin);
    const sessionData = await requireCsrfSession(request, response);
    if (!sessionData) return;
    await readJsonObject(request, []);
    const workspace = ensureWorkspace(database, sessionData.user.id);
    const result = await shopify.disconnect({
      workspaceId: workspace.id,
      ownerEmail: sessionData.user.email,
    });
    if (result.status === 'setup_required') {
      return reply(response, 503, { error: 'setup_required' });
    }
    if (result.status === 'pilot_unavailable') {
      return reply(response, 403, { error: 'pilot_unavailable' });
    }
    if (result.status === 'disconnect_failed') {
      return reply(response, 500, { error: 'disconnect_failed' });
    }
    return reply(response, 200, { disconnected: true });
  }

  async function finishAuthorization(request, response) {
    const verdict = callbackLimiter.consume(clientAddress(request));
    if (!verdict.allowed) {
      const headers = { 'Retry-After': String(verdict.retryAfterSeconds) };
      return reply(response, 429, { error: 'rate_limited' }, headers);
    }
    let succeeded = false;
    try {
      succeeded = await shopify.complete(request);
    } catch {
      succeeded = false;
    }
    // A fixed destination: nothing from the query string is echoed back.
    response.writeHead(303, {
      ...responseHeaders,
      Location: succeeded ? CONNECTED_REDIRECT : FAILED_REDIRECT,
      'Content-Length': 0,
      'Set-Cookie': shopify.clearingCookies(),
    });
    response.end();
  }

  return new Map([
    [`GET ${SHOPIFY_STATUS_PATH}`, serveStatus],
    [`POST ${SHOPIFY_START_PATH}`, startConnection],
    [`POST ${SHOPIFY_DISCONNECT_PATH}`, disconnectConnection],
    [`GET ${SHOPIFY_CALLBACK_PATH}`, finishAuthorization],
  ]);
}
