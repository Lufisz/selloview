// The MetricTV app: invite-only owner login (Better Auth), owner session view, logout,
// per-workspace appearance settings, TV pairing with revocable display sessions, and the optional,
// workspace-scoped Shopify store connection. It serves its own pages and the shared presentation
// files, and it never shows demo data. Loopback only: a tunnel or proxy in front is the operator's
// separate, explicitly approved step.
import fs from 'node:fs/promises';
import net from 'node:net';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_BASE_PATH } from './accounts/auth.mjs';
import { createAuthGateway } from './accounts/auth-gateway.mjs';
import { createOwnerSession, csrfTokenFor } from './accounts/owner-session.mjs';
import { closedRegistration } from './accounts/registration.mjs';
import {
  RequestRejection,
  assertExpectedHost,
  assertSameOriginJson,
  createResponseHeaders,
  readJsonObject,
  sendJson,
} from './http/guards.mjs';
import { ensureWorkspace, updateWorkspaceSettings } from './accounts/workspaces.mjs';
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
  singleHeaderValue,
} from './http/static-files.mjs';

const DEFAULT_PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
);
const SESSION_PATH = '/api/session';
const SETTINGS_PATH = '/api/settings';
const REGISTRATION_PATH = '/api/registration';
const HEALTH_PATH = '/healthz';

function clientAddress(request, trustedIpHeader) {
  if (trustedIpHeader !== '') {
    const forwarded = singleHeaderValue(request.rawHeaders, trustedIpHeader);
    if (forwarded !== null && net.isIP(forwarded) !== 0) return forwarded;
  }
  return request.socket.remoteAddress ?? '';
}

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
export function createAppHandler({
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
  const appVersion = createAppVersion(publicDir, APP_PUBLIC_FILES);

  function reply(response, status, body, extraHeaders) {
    return sendJson(response, responseHeaders, status, body, extraHeaders);
  }

  const { lookupSession, requireCsrfSession } = createOwnerSession({ auth, secret, reply });

  async function describeOwner(sessionData) {
    const workspace = ensureWorkspace(database, sessionData.user.id);
    const { connection } = await shopify.inspect(workspace.id, sessionData.user.email);
    return {
      owner: { email: sessionData.user.email },
      sessionExpiresAt: new Date(sessionData.session.expiresAt).toISOString(),
      workspace: {
        name: workspace.name,
        revision: workspace.revision,
        settings: workspace.settings,
      },
      storeConnection: connection,
      csrfToken: csrfTokenFor(secret, sessionData.session.id),
    };
  }

  // Safe to show anyone: whether sign-up exists and has room, never counts or emails.
  function serveRegistrationStatus(response) {
    return reply(response, 200, registration.status(), { 'Cache-Control': 'no-store' });
  }

  // For uptime monitors and container probes: up or down, nothing else. Reading the schema
  // version proves the database file is still readable.
  function serveHealth(response) {
    try {
      database.prepare('PRAGMA user_version').get();
    } catch {
      return reply(response, 503, { status: 'unavailable' });
    }
    return reply(response, 200, { status: 'ok' });
  }

  async function serveSession(request, response) {
    const sessionData = await lookupSession(request);
    if (!sessionData) return reply(response, 401, { error: 'unauthenticated' });
    return reply(response, 200, await describeOwner(sessionData));
  }

  async function saveSettings(request, response) {
    assertSameOriginJson(request, origin);
    const sessionData = await requireCsrfSession(request, response);
    if (!sessionData) return;
    const body = await readJsonObject(request, ['settings', 'revision']);
    // The workspace is the session user's; no workspace or owner id is read from the request.
    const result = updateWorkspaceSettings(database, sessionData.user.id, {
      patch: body.settings,
      expectedRevision: body.revision,
    });
    if (result.status === 'invalid') return reply(response, 400, { error: 'invalid_request' });
    const status = result.status === 'ok' ? 200 : 409;
    return reply(response, status, {
      status: result.status,
      revision: result.workspace.revision,
      settings: result.workspace.settings,
    });
  }

  const serveAuthRoute = createAuthGateway({
    auth,
    origin,
    mailTransport,
    registration,
    reply,
    requireCsrfSession,
    clientAddress: (request) => clientAddress(request, trustedIpHeader),
  });

  const screenRoutes = createScreenRoutes({
    database,
    origin,
    reply,
    responseHeaders,
    lookupSession,
    requireCsrfSession,
    clientAddress: (request) => clientAddress(request, trustedIpHeader),
    shopify,
    appVersion,
  });
  const shopifyRoutes = createShopifyRoutes({
    shopify,
    database,
    origin,
    reply,
    responseHeaders,
    lookupSession,
    requireCsrfSession,
    clientAddress: (request) => clientAddress(request, trustedIpHeader),
  });

  async function serveStatic(request, response, pathname) {
    const requestedPath = publicPathFor(APP_PAGES, pathname);
    const file = await findPublicFile(publicDir, requestedPath, APP_PUBLIC_FILES);
    if (!file) return reply(response, 404, { error: 'not_found' });
    const data = await fs.readFile(file.filePath);
    response.writeHead(200, {
      ...responseHeaders,
      'Content-Type': file.contentType,
      'Content-Length': data.length,
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  }

  async function route(request, response) {
    assertExpectedHost(request, origin);
    const parsed = parseRequestPath(request.url);
    if (parsed.rejection === 'bad_request') throw new RequestRejection(400, 'bad_request');
    if (parsed.rejection) throw new RequestRejection(404, 'not_found');
    const { pathname } = parsed;

    if (pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return serveAuthRoute(request, response, pathname.slice(AUTH_BASE_PATH.length));
    }
    if (pathname === REGISTRATION_PATH && request.method === 'GET') {
      return serveRegistrationStatus(response);
    }
    if (pathname === HEALTH_PATH && isReadMethod(request.method)) return serveHealth(response);
    if (pathname === SESSION_PATH && request.method === 'GET')
      return serveSession(request, response);
    if (pathname === SETTINGS_PATH && request.method === 'POST')
      return saveSettings(request, response);
    const routeKey = `${request.method} ${pathname}`;
    const screenRoute = screenRoutes.get(routeKey);
    if (screenRoute) return screenRoute(request, response);
    const shopifyRoute = shopifyRoutes.get(routeKey);
    if (shopifyRoute) return shopifyRoute(request, response);
    if (isReadMethod(request.method)) return serveStatic(request, response, pathname);
    return reply(response, 405, { error: 'method_not_allowed' });
  }

  return async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (error instanceof RequestRejection)
        return reply(response, error.status, { error: error.code });
      logEvent('request_failed', { error: error?.name ?? 'Error' });
      return reply(response, 500, { error: 'server_error' });
    }
  };
}

export function createAppServer(dependencies) {
  return applyServerLimits(createServer(SERVER_OPTIONS, createAppHandler(dependencies)));
}
