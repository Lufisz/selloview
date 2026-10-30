// Opt-in beta entry point: invite-only owner login (Better Auth), owner session view, logout,
// per-workspace appearance settings, and TV pairing with revocable display sessions. Loopback
// only; a tunnel or proxy in front is the operator's separate, explicitly approved step.
//
// It serves its own pages and the shared presentation files. The only Shopify access is the
// optional, workspace-scoped store connection (server/beta/shopify-*.mjs); it never touches the
// private single-store live backend or its credentials, and it never shows demo data.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromNodeHeaders } from 'better-auth/node';
import {
  AUTH_BASE_PATH,
  CLIENT_IP_HEADER,
  SEND_CODE_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  createAuth,
  trackCodeDelivery,
} from '../accounts/auth.mjs';
import { openInitializedDatabase } from '../accounts/accounts.mjs';
import {
  closedRegistration,
  createRegistrationPolicy,
  loadRegistrationConfig,
} from '../accounts/registration.mjs';
import { parseDatabasePath } from '../accounts/private-database.mjs';
import {
  createResendTransport,
  loadMailConfig,
  unconfiguredTransport,
} from '../accounts/mail-transport.mjs';
import {
  RequestRejection,
  assertExpectedHost,
  assertSameOriginJson,
  createResponseHeaders,
  readJsonObject,
  sendJson,
} from '../http/guards.mjs';
import { ensureWorkspace, updateWorkspaceSettings } from '../accounts/workspaces.mjs';
import { loadBetaShopifyConfig } from './shopify-config.mjs';
import { createBetaShopifyService } from './shopify-service.mjs';
import { createShopifyRoutes } from './shopify-routes.mjs';
import { BETA_PUBLIC_FILES } from '../http/public-files.mjs';
import { createAppVersion } from './app-version.mjs';
import { createScreenRoutes } from './screen-routes.mjs';
import {
  SERVER_OPTIONS,
  applyServerLimits,
  findPublicFile,
  isReadMethod,
  parseRequestPath,
  singleHeaderValue,
} from '../http/static-files.mjs';

const DEFAULT_PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
);
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 4330;
const MIN_SECRET_LENGTH = 32;
const SESSION_PATH = '/api/beta/session';
const SETTINGS_PATH = '/api/beta/settings';
const REGISTRATION_PATH = '/api/beta/registration';
const CODE_PATTERN = /^\d{6}$/;
const TV_PAGE_PATH = '/tv';
const MAX_EMAIL_LENGTH = 254;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HEADER_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** Reads operator configuration from environment variables; throws on anything unsafe. */
export function loadBetaConfig(env = process.env) {
  const databasePath = parseDatabasePath(env.BETA_DB_PATH);

  const secret = env.BETA_AUTH_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETA_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const origin = parseOrigin(env.BETA_ORIGIN);

  const portText = env.BETA_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
    throw new Error('BETA_PORT must be a TCP port');
  }

  // Only set when a trusted proxy in front always overwrites this header (e.g. cf-connecting-ip).
  const trustedIpHeader = (env.BETA_TRUSTED_IP_HEADER ?? '').toLowerCase();
  if (trustedIpHeader !== '' && !HEADER_NAME_PATTERN.test(trustedIpHeader)) {
    throw new Error('BETA_TRUSTED_IP_HEADER is not a valid header name');
  }

  return { databasePath, secret, origin, port, host: LOOPBACK_HOST, trustedIpHeader };
}

function parseOrigin(configured) {
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('BETA_ORIGIN must be an exact origin such as https://beta.example.com');
  }
  const isExact = configured === url.origin;
  const isSecure = url.protocol === 'https:';
  const isLoopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!isExact || !(isSecure || isLoopbackHttp)) {
    throw new Error('BETA_ORIGIN must be an https origin (http only for loopback)');
  }
  return url.origin;
}

/** CSRF token bound to one server-side session; the browser keeps it in memory only. */
function csrfTokenFor(secret, sessionId) {
  return crypto.createHmac('sha256', secret).update(`beta-csrf\n${sessionId}`).digest('base64url');
}

function isValidCsrf(request, secret, sessionId) {
  const supplied = singleHeaderValue(request.rawHeaders, 'x-csrf-token');
  if (supplied === null) return false;
  const expected = Buffer.from(csrfTokenFor(secret, sessionId));
  const received = Buffer.from(supplied);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function clientAddress(request, trustedIpHeader) {
  if (trustedIpHeader !== '') {
    const forwarded = singleHeaderValue(request.rawHeaders, trustedIpHeader);
    if (forwarded !== null && net.isIP(forwarded) !== 0) return forwarded;
  }
  return request.socket.remoteAddress ?? '';
}

function isEmailText(value) {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && value.includes('@');
}

// Per-endpoint body shape and validation. Unknown keys (name, image, ...) are rejected so the
// browser cannot set profile fields or reach other Better Auth options.
const AUTH_ROUTES = Object.freeze({
  [SEND_CODE_PATH]: {
    keys: ['email', 'type'],
    isValid: (body) => isEmailText(body.email) && body.type === 'sign-in',
    needsSession: false,
  },
  [SIGN_IN_PATH]: {
    keys: ['email', 'otp'],
    isValid: (body) => isEmailText(body.email) && CODE_PATTERN.test(String(body.otp)),
    needsSession: false,
  },
  [SIGN_OUT_PATH]: { keys: [], isValid: () => true, needsSession: true },
});

/**
 * @param {object} dependencies
 * @param {ReturnType<typeof createAuth>} dependencies.auth
 * @param {import('node:sqlite').DatabaseSync} dependencies.database
 * @param {{origin: string, secret: string, trustedIpHeader?: string}} dependencies.config
 * @param {{configured: boolean}} dependencies.mailTransport
 * @param {ReturnType<typeof createRegistrationPolicy>} [dependencies.registration]
 *   Defaults to closed (invite-only).
 * @param {ReturnType<typeof createBetaShopifyService>} [dependencies.shopify]
 *   Defaults to a service that reports "setup required" and never contacts Shopify.
 */
export function createBetaHandler({
  auth,
  database,
  config,
  mailTransport,
  registration = closedRegistration,
  shopify = createBetaShopifyService({
    database,
    config: { status: 'setup_required' },
    origin: config.origin,
  }),
  publicDir = DEFAULT_PUBLIC_DIR,
}) {
  const { origin, secret, trustedIpHeader = '' } = config;
  const responseHeaders = createResponseHeaders(origin);
  const appVersion = createAppVersion(publicDir, BETA_PUBLIC_FILES);

  function reply(response, status, body, extraHeaders) {
    return sendJson(response, responseHeaders, status, body, extraHeaders);
  }

  async function lookupSession(request) {
    return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  // Resolves the signed-in owner and checks the session-bound CSRF token.
  // Returns session data, or null after having sent the denial.
  async function requireCsrfSession(request, response) {
    const sessionData = await lookupSession(request);
    if (!sessionData) {
      reply(response, 401, { error: 'unauthenticated' });
      return null;
    }
    if (!isValidCsrf(request, secret, sessionData.session.id)) {
      reply(response, 403, { error: 'invalid_csrf' });
      return null;
    }
    return sessionData;
  }

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

  function forwardedAuthRequest(request, authPath, bodyText) {
    const headers = fromNodeHeaders(request.headers);
    // Never trust a browser-supplied address header; Better Auth keys rate limits on this one.
    headers.set(CLIENT_IP_HEADER, clientAddress(request, trustedIpHeader));
    headers.delete('content-length');
    return new Request(`${origin}${AUTH_BASE_PATH}${authPath}`, {
      method: 'POST',
      headers,
      body: bodyText,
    });
  }

  // Better Auth bodies (tokens, user records, error text) are never passed through; only its
  // cookies and rate-limit delay are.
  function respondToAuthResult(response, authPath, authResponse, deliveryFailed) {
    const extraHeaders = { 'Set-Cookie': authResponse.headers.getSetCookie() };
    if (authResponse.status === 429) {
      const retryAfter = authResponse.headers.get('retry-after');
      if (retryAfter && /^\d{1,6}$/.test(retryAfter)) extraHeaders['Retry-After'] = retryAfter;
      return reply(response, 429, { error: 'rate_limited' }, extraHeaders);
    }
    if (authPath === SEND_CODE_PATH && deliveryFailed) {
      return reply(response, 502, { error: 'delivery_failed' });
    }
    if (authResponse.ok) return reply(response, 200, { ok: true }, extraHeaders);
    if (authPath === SEND_CODE_PATH && authResponse.status >= 500) {
      return reply(response, 502, { error: 'delivery_failed' });
    }
    if (authPath === SIGN_IN_PATH) return reply(response, 400, { error: 'invalid_code' });
    return reply(response, 400, { error: 'invalid_request' });
  }

  // Existing owners are unaffected. A code for an address without an account costs email, so it
  // needs room and fits the request limits. A full service answers like the closed one: no mail,
  // success-shaped reply, nothing that tells a stranger which addresses have accounts.
  function checkNewAddressRequest(request, email) {
    if (registration.emailHasAccount(email.toLowerCase())) return null;
    if (!registration.hasRoom()) return { silent: true };
    const limit = registration.consumeNewAddressCode(clientAddress(request, trustedIpHeader));
    return limit.allowed ? null : { retryAfterSeconds: limit.retryAfterSeconds };
  }

  function respondToRegistrationRefusal(response, refusal) {
    if (refusal.silent) return reply(response, 200, { ok: true });
    const extraHeaders = { 'Retry-After': String(refusal.retryAfterSeconds) };
    return reply(response, 429, { error: 'rate_limited' }, extraHeaders);
  }

  async function serveAuthRoute(request, response, authPath) {
    const route = Object.hasOwn(AUTH_ROUTES, authPath) ? AUTH_ROUTES[authPath] : null;
    if (!route) return reply(response, 404, { error: 'not_found' });
    if (request.method !== 'POST') {
      return reply(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    assertSameOriginJson(request, origin);

    if (route.needsSession && !(await requireCsrfSession(request, response))) return;
    if (authPath === SEND_CODE_PATH && !mailTransport.configured) {
      return reply(response, 503, { error: 'delivery_not_configured' });
    }

    const body = await readJsonObject(request, route.keys);
    if (!route.isValid(body)) throw new RequestRejection(400, 'invalid_request');
    if (authPath === SEND_CODE_PATH && registration.enabled) {
      const refusal = checkNewAddressRequest(request, body.email);
      if (refusal) return respondToRegistrationRefusal(response, refusal);
    }
    const authRequest = forwardedAuthRequest(request, authPath, JSON.stringify(body));
    const forwardToAuth = () => trackCodeDelivery(() => auth.handler(authRequest));
    // Verification can create an account, so it queues behind other verifications.
    const { result, deliveryFailed } =
      authPath === SIGN_IN_PATH
        ? await registration.runExclusive(forwardToAuth)
        : await forwardToAuth();
    return respondToAuthResult(response, authPath, result, deliveryFailed);
  }

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

  const PAGE_FILES = {
    '/': '/landing.html',
    '/app': '/beta.html',
    '/register': '/beta.html',
    '/demo': '/index.html',
    [TV_PAGE_PATH]: '/tv.html',
  };

  async function serveStatic(request, response, pathname) {
    const requestedPath = Object.hasOwn(PAGE_FILES, pathname) ? PAGE_FILES[pathname] : pathname;
    if (!BETA_PUBLIC_FILES.has(requestedPath)) return reply(response, 404, { error: 'not_found' });
    const file = await findPublicFile(publicDir, requestedPath, { indexFile: 'beta.html' });
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
      console.error(`beta request failed: ${error?.name ?? 'Error'}`);
      return reply(response, 500, { error: 'server_error' });
    }
  };
}

export function createBetaServer(dependencies) {
  return applyServerLimits(createServer(SERVER_OPTIONS, createBetaHandler(dependencies)));
}

function startFromEnvironment() {
  const config = loadBetaConfig();
  const mailConfig = loadMailConfig();
  const mailTransport = mailConfig ? createResendTransport(mailConfig) : unconfiguredTransport;
  const shopifyConfig = loadBetaShopifyConfig(process.env);
  const registrationConfig = loadRegistrationConfig(process.env);
  const database = openInitializedDatabase(config.databasePath);
  const registration = createRegistrationPolicy({ database, config: registrationConfig });
  const auth = createAuth({
    database,
    secret: config.secret,
    origin: config.origin,
    mailTransport,
    registration,
  });
  const shopify = createBetaShopifyService({
    database,
    config: shopifyConfig,
    origin: config.origin,
  });
  const server = createBetaServer({ auth, database, config, mailTransport, registration, shopify });
  server.listen(config.port, config.host, () => {
    const delivery = mailTransport.configured
      ? 'configured'
      : 'NOT configured (sign-in codes cannot be sent)';
    console.log(`MetricTV beta on http://${config.host}:${config.port} for ${config.origin}`);
    console.log(`Email delivery: ${delivery}`);
    const signUp = registration.enabled
      ? `OPEN, capped at ${registrationConfig.maxAccounts} accounts`
      : 'closed (invite-only)';
    console.log(`Self-service registration: ${signUp}`);
    const connection = shopify.configured ? 'configured' : 'NOT configured (setup required)';
    console.log(`Shopify store connection: ${connection}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startFromEnvironment();
  } catch (error) {
    console.error(`MetricTV beta cannot start: ${error.message}`);
    process.exit(1);
  }
}
