// The MetricTV app: invite-only owner login (Better Auth), owner session view, logout,
// per-workspace appearance settings, TV pairing with revocable display sessions, and the optional,
// workspace-scoped Shopify store connection. It serves its own pages and the shared presentation
// files, and it never shows demo data. Loopback only: a tunnel or proxy in front is the operator's
// separate, explicitly approved step.
//
// This file only routes: checks the Host, then hands the request to the module that owns the path.
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_BASE_PATH } from './accounts/auth.mjs';
import { createAuthGateway } from './accounts/auth-gateway.mjs';
import { createOwnerRoutes } from './accounts/owner-routes.mjs';
import { createOwnerSession } from './accounts/owner-session.mjs';
import { closedRegistration } from './accounts/registration.mjs';
import { createClientAddress } from './http/client-address.mjs';
import {
  RequestRejection,
  assertExpectedHost,
  createResponseHeaders,
  sendJson,
} from './http/guards.mjs';
import { logEvent } from './log.mjs';
import { createShopifyService } from './shopify/connection-service.mjs';
import { createShopifyRoutes } from './shopify/routes.mjs';
import { APP_PAGES, APP_PUBLIC_FILES, publicPathFor } from './http/public-files.mjs';
import { createAppVersion } from './screens/app-version.mjs';
import { createScreenRoutes } from './screens/screen-routes.mjs';
import {
  SERVER_OPTIONS,
  applyServerLimits,
  findPublicFile,
  isReadMethod,
  parseRequestPath,
  sendPublicFile,
} from './http/static-files.mjs';

const DEFAULT_PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
);
const HEALTH_PATH = '/healthz';

/**
 * @param {object} dependencies
 * @param {ReturnType<typeof import('./accounts/auth.mjs').createAuth>} dependencies.auth
 * @param {import('node:sqlite').DatabaseSync} dependencies.database
 * @param {{origin: string, secret: string, trustedIpHeader?: string}} dependencies.config
 * @param {{configured: boolean}} dependencies.mailTransport
 * @param {ReturnType<typeof import('./accounts/registration.mjs').createRegistrationPolicy>} [dependencies.registration]
 *   Defaults to closed (invite-only).
 * @param {ReturnType<typeof createShopifyService>} [dependencies.shopify]
 *   Defaults to a service that reports "setup required" and never contacts Shopify.
 */
function createAppHandler({
  auth,
  database,
  config,
  mailTransport,
  registration = closedRegistration,
  shopify = createShopifyService({
    database,
    config: { status: 'setup_required' },
    origin: config.origin,
  }),
  publicDir = DEFAULT_PUBLIC_DIR,
}) {
  const { origin, secret, trustedIpHeader = '' } = config;
  const responseHeaders = createResponseHeaders(origin);
  const clientAddress = createClientAddress({ trustedIpHeader });

  function reply(response, status, body, extraHeaders) {
    return sendJson(response, responseHeaders, status, body, extraHeaders);
  }

  // For uptime monitors and container probes: up or down, nothing else. Reading the schema
  // version proves the database file is still readable.
  function serveHealth(request, response) {
    try {
      database.prepare('PRAGMA user_version').get();
    } catch {
      return reply(response, 503, { status: 'unavailable' });
    }
    return reply(response, 200, { status: 'ok' });
  }

  async function serveStatic(request, response, pathname) {
    const requestedPath = publicPathFor(APP_PAGES, pathname);
    const file = await findPublicFile(publicDir, requestedPath, APP_PUBLIC_FILES);
    if (!file) return reply(response, 404, { error: 'not_found' });
    const sent = await sendPublicFile(request, response, responseHeaders, file);
    if (!sent) return reply(response, 404, { error: 'not_found' });
  }

  // What every route module needs. Each one takes only the parts it uses.
  const { lookupSession, requireCsrfSession, csrfTokenFor } = createOwnerSession({
    auth,
    secret,
    reply,
  });
  const routeContext = {
    database,
    origin,
    registration,
    shopify,
    appVersion: createAppVersion(publicDir, APP_PUBLIC_FILES),
    reply,
    responseHeaders,
    lookupSession,
    requireCsrfSession,
    csrfTokenFor,
    clientAddress,
  };

  const serveAuthRoute = createAuthGateway({ ...routeContext, auth, mailTransport });
  const routes = new Map([
    ...createOwnerRoutes(routeContext),
    ...createScreenRoutes(routeContext),
    ...createShopifyRoutes(routeContext),
    [`GET ${HEALTH_PATH}`, serveHealth],
    [`HEAD ${HEALTH_PATH}`, serveHealth],
  ]);

  async function route(request, response) {
    assertExpectedHost(request, origin);
    const parsed = parseRequestPath(request.url);
    if (parsed.rejection === 'bad_request') throw new RequestRejection(400, 'bad_request');
    if (parsed.rejection) throw new RequestRejection(404, 'not_found');
    const { pathname } = parsed;

    if (pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return serveAuthRoute(request, response, pathname.slice(AUTH_BASE_PATH.length));
    }
    const serveRoute = routes.get(`${request.method} ${pathname}`);
    if (serveRoute) return serveRoute(request, response);
    if (isReadMethod(request.method)) return serveStatic(request, response, pathname);
    return reply(response, 405, { error: 'method_not_allowed' });
  }

  return async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (error instanceof RequestRejection) {
        return reply(response, error.status, { error: error.code });
      }
      logEvent('request_failed', { error: error?.name ?? 'Error' });
      return reply(response, 500, { error: 'server_error' });
    }
  };
}

export function createAppServer(dependencies) {
  return applyServerLimits(createServer(SERVER_OPTIONS, createAppHandler(dependencies)));
}
