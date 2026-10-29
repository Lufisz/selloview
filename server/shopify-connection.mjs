import crypto from 'node:crypto';
import path from 'node:path';
import { ShopifyError, validateStore } from './shopify.mjs';
import { createShopifyFetch } from './shopify-http.mjs';
import { createSecurityHeaders, rawHeaderValues } from './static-files.mjs';
import { createTokenStore, REQUIRED_SCOPES } from './shopify-token-store.mjs';
import { createGrantManager } from './shopify-grant-manager.mjs';
import {
  PENDING_ATTEMPT_TTL_MS,
  STATE_COOKIE_NAMES,
  countCookie,
  createShopifySdk,
  extendCookieLifetime,
  forwardedHeaders,
  hasExactCallbackFields,
  parseAuthorizationUrl,
  parseQuery,
  runWithBoundedFetch,
} from './shopify-sdk.mjs';

/**
 * Standalone Shopify OAuth for ONE configured store, behind the existing owner gate.
 * The parent live server has already checked loopback, Host, owner identity and path.
 * Nothing here talks to Shopify except through the bounded `createShopifyFetch` transport.
 */

export const CALLBACK_PATH = '/auth/shopify/callback';
export const STATUS_PATH = '/api/connection';
export const START_PATH = '/auth/shopify/start';
export const DISCONNECT_PATH = '/api/connection/disconnect';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const MAX_BODY_BYTES = 4096;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_PENDING_ATTEMPTS = 3;
const START_RATE_LIMIT = { count: 6, windowMs: 60_000 };
const CONNECTED_REDIRECT = '/?connection=connected#/connections';
const FAILED_REDIRECT = '/?connection=failed#/connections';

const SAFE_HEADERS = createSecurityHeaders({ allowApiRequests: true });

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const CLIENT_SECRET_PATTERN = /^[\x21-\x7e]{16,256}$/;

export function invalidConfig() {
  return new ShopifyError('invalid_connection_config');
}

export function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function parseOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw invalidConfig();
  }
  const isPlainHttps =
    parsed.protocol === 'https:' &&
    parsed.pathname === '/' &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.username &&
    !parsed.password;
  if (!isPlainHttps) throw invalidConfig();
  return parsed.origin;
}

export function parseEncryptionKey(text) {
  if (typeof text !== 'string') throw invalidConfig();
  const key = Buffer.from(text, 'base64');
  const isCanonical = key.length === 32 && key.toString('base64') === text;
  if (!isCanonical) throw invalidConfig();
  return key;
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  const escapesParent = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!escapesParent && !path.isAbsolute(relative));
}

function parseTokenStorePath(value) {
  const isAbsoluteAndClean =
    typeof value === 'string' &&
    !value.includes('\0') &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    path.basename(value) !== '' &&
    !value.endsWith(path.sep);
  if (!isAbsoluteAndClean) throw invalidConfig();
  // The project root contains public/, so this also keeps tokens out of anything served.
  if (isInside(PROJECT_ROOT, value)) throw invalidConfig();
  return value;
}

export function hideSecrets(target, secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    // Non-enumerable: console.log / JSON.stringify of the config cannot print secrets.
    Object.defineProperty(target, name, { value, enumerable: false });
  }
  return Object.freeze(target);
}

/**
 * Build the connection configuration. Pure; never reads files. Throws
 * ShopifyError('invalid_connection_config') (no details) for malformed or partial settings.
 */
export function loadConnectionConfig(env, { store, origin }) {
  validateStore(store);
  const safeOrigin = parseOrigin(origin);
  const requestedMode = isBlank(env.SHOPIFY_AUTH_MODE) ? 'cli' : env.SHOPIFY_AUTH_MODE;
  if (requestedMode === 'cli') return Object.freeze({ mode: 'cli', store, origin: safeOrigin });
  if (requestedMode !== 'oauth') throw invalidConfig();

  const names = [
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    'SHOPIFY_TOKEN_STORE_PATH',
  ];
  const presentCount = names.filter((name) => !isBlank(env[name])).length;
  if (presentCount === 0) {
    return Object.freeze({ mode: 'oauth', setupRequired: true, store, origin: safeOrigin });
  }
  if (presentCount !== names.length) throw invalidConfig();

  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  if (!CLIENT_ID_PATTERN.test(clientId)) throw invalidConfig();
  if (!CLIENT_SECRET_PATTERN.test(clientSecret)) throw invalidConfig();
  return hideSecrets(
    { mode: 'oauth', setupRequired: false, store, origin: safeOrigin },
    {
      clientId,
      clientSecret,
      encryptionKey: parseEncryptionKey(env.SHOPIFY_TOKEN_ENCRYPTION_KEY),
      tokenStorePath: parseTokenStorePath(env.SHOPIFY_TOKEN_STORE_PATH),
    },
  );
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

function sendJson(response, statusCode, body, { headers = {}, headOnly = false } = {}) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...SAFE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(headOnly ? undefined : text);
}

function sendError(response, statusCode, code, headers) {
  sendJson(response, statusCode, { error: code }, { headers });
}

function sendRedirect(response, location, cookies = []) {
  const headers = { ...SAFE_HEADERS, Location: location, 'Content-Length': 0 };
  if (cookies.length > 0) headers['Set-Cookie'] = cookies;
  response.writeHead(303, headers);
  response.end();
}

function hasAmbiguousHeaders(request) {
  const guarded = ['content-type', 'content-length', 'origin', 'x-csrf-token', 'transfer-encoding'];
  for (const name of guarded) {
    if (rawHeaderValues(request.rawHeaders ?? [], name).length > 1) return true;
  }
  return false;
}

async function readJsonObject(request) {
  const contentType = request.headers['content-type'] ?? '';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return { error: 'unsupported_media_type', status: 415 };
  const declared = request.headers['content-length'];
  if (declared !== undefined && !/^\d+$/.test(declared))
    return { error: 'bad_request', status: 400 };
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    return { error: 'payload_too_large', status: 413 };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { error: 'payload_too_large', status: 413 };
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    return { error: 'bad_request', status: 400 };
  }
  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!isObject) return { error: 'bad_request', status: 400 };
  return { body: parsed };
}

function hasOnlyKeys(object, allowedKeys) {
  return Object.keys(object).every((key) => allowedKeys.includes(key));
}

function clearingCookies() {
  const expired = 'Thu, 01 Jan 1970 00:00:00 GMT';
  return STATE_COOKIE_NAMES.map(
    (name) =>
      `${name}=; Path=${CALLBACK_PATH}; Expires=${expired}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export function createShopifyConnection({
  config,
  fetchImpl = fetch,
  now = Date.now,
  onChange = async () => {},
}) {
  const callbackUrl = `${config.origin}${CALLBACK_PATH}`;
  const isOauth = config.mode === 'oauth';
  const isReady = isOauth && config.setupRequired === false;
  const csrfSecret = crypto.randomBytes(32);

  let grantManager = null;
  let boundedFetch = null;
  let shopify = null;
  const pendingAttempts = new Map();
  let startTimes = [];
  if (isReady) {
    const tokenStore = createTokenStore({
      filePath: config.tokenStorePath,
      key: config.encryptionKey,
      clientId: config.clientId,
      store: config.store,
    });
    boundedFetch = createShopifyFetch({
      store: config.store,
      fetchImpl,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    });
    shopify = createShopifySdk({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      origin: config.origin,
    });
    grantManager = createGrantManager({
      tokenStore,
      shopify,
      boundedFetch,
      store: config.store,
      clientId: config.clientId,
      now,
      onChange,
      onDiscard: () => pendingAttempts.clear(),
    });
  }

  // ---- credentials -------------------------------------------------------------------------

  async function disconnect() {
    if (!isReady) return;
    await grantManager.disconnect();
  }

  async function markReauthorizationRequired(options) {
    if (!isReady) return;
    await grantManager.markReauthorizationRequired(options);
  }

  async function getAccessToken(options) {
    if (!isReady) throw new ShopifyError('setup_required');
    return grantManager.getAccessToken(options);
  }

  // ---- status ------------------------------------------------------------------------------

  function csrfTokenFor(principal) {
    return crypto.createHmac('sha256', csrfSecret).update(`csrf\n${principal}`).digest('base64url');
  }

  function isValidCsrf(request, principal) {
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || typeof principal !== 'string' || !principal) return false;
    const expected = Buffer.from(csrfTokenFor(principal));
    const received = Buffer.from(supplied);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  async function currentState() {
    if (!isOauth) return 'cli_pilot';
    if (!isReady) return 'setup_required';
    return grantManager.currentState();
  }

  async function status(principal) {
    const state = await currentState();
    const canUseForms =
      state === 'not_connected' || state === 'connected' || state === 'reconnect_required';
    return {
      mode: config.mode,
      state,
      store: config.store,
      scopes: [...REQUIRED_SCOPES],
      csrfToken: canUseForms && principal ? csrfTokenFor(principal) : '',
      callbackUrl,
    };
  }

  // ---- OAuth start -------------------------------------------------------------------------

  function prunePending() {
    const current = now();
    for (const [state, attempt] of pendingAttempts) {
      if (attempt.expiresAt <= current) pendingAttempts.delete(state);
    }
  }

  function isRateLimited() {
    const current = now();
    startTimes = startTimes.filter((time) => current - time < START_RATE_LIMIT.windowMs);
    return startTimes.length >= START_RATE_LIMIT.count;
  }

  async function startAttempt(request, response, principal) {
    const rawBody = await readJsonObject(request);
    if (rawBody.error) return sendError(response, rawBody.status, rawBody.error);
    const body = rawBody.body;
    if (!hasOnlyKeys(body, ['store']) || body.store !== config.store) {
      return sendError(response, 400, 'invalid_store');
    }
    prunePending();
    for (const [state, attempt] of pendingAttempts) {
      if (attempt.principal === principal) pendingAttempts.delete(state);
    }
    if (isRateLimited()) return sendError(response, 429, 'rate_limited', { 'Retry-After': '60' });
    if (pendingAttempts.size >= MAX_PENDING_ATTEMPTS) {
      return sendError(response, 429, 'too_many_attempts', { 'Retry-After': '60' });
    }
    startTimes.push(now());

    const sdkRequest = new Request(`${config.origin}${START_PATH}`, {
      method: 'POST',
      headers: forwardedHeaders(request, ['user-agent']),
    });
    let sdkResponse;
    try {
      sdkResponse = await runWithBoundedFetch(boundedFetch, () =>
        shopify.auth.begin({
          shop: config.store,
          callbackPath: CALLBACK_PATH,
          isOnline: false,
          rawRequest: sdkRequest,
        }),
      );
    } catch {
      return sendError(response, 502, 'start_failed');
    }
    const authorization = parseAuthorizationUrl(sdkResponse.headers.get('location') ?? '', {
      store: config.store,
      clientId: config.clientId,
      callbackUrl,
    });
    const cookies = sdkResponse.headers
      .getSetCookie()
      .map((cookie) => extendCookieLifetime(cookie, now()));
    const hasBothCookies = STATE_COOKIE_NAMES.every((name) =>
      cookies.some((cookie) => cookie.startsWith(`${name}=`)),
    );
    if (sdkResponse.status === 410) return sendError(response, 400, 'unsupported_client');
    if (sdkResponse.status !== 302 || !authorization || !hasBothCookies) {
      return sendError(response, 502, 'start_failed');
    }
    pendingAttempts.set(authorization.state, {
      principal,
      store: config.store,
      expiresAt: now() + PENDING_ATTEMPT_TTL_MS,
    });
    return sendJson(
      response,
      200,
      { authorizationUrl: authorization.href },
      { headers: { 'Set-Cookie': cookies } },
    );
  }

  // ---- OAuth callback ----------------------------------------------------------------------

  /** One-use: the attempt is removed before anything else can fail or be replayed. */
  function takeAttempt(state, principal) {
    prunePending();
    const attempt = pendingAttempts.get(state);
    pendingAttempts.delete(state);
    if (!attempt) return null;
    if (attempt.principal !== principal || attempt.store !== config.store) return null;
    return attempt;
  }

  async function completeCallback(request, principal) {
    const query = parseQuery(request.url ?? '');
    if (!query) return false;
    const state = query.get('state');
    if (query.has('error')) {
      if (state) pendingAttempts.delete(state);
      return false;
    }
    if (!hasExactCallbackFields(query)) return false;
    if (query.get('shop') !== config.store) {
      pendingAttempts.delete(state);
      return false;
    }
    if (!takeAttempt(state, principal)) return false;
    const cookieHeader = request.headers.cookie ?? '';
    for (const name of STATE_COOKIE_NAMES) {
      if (countCookie(cookieHeader, name) !== 1) return false;
    }

    const startingEpoch = grantManager.epoch;
    const sdkRequest = new Request(`${config.origin}${request.url}`, {
      headers: forwardedHeaders(request, ['cookie', 'user-agent']),
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
    return grantManager.installSession(session, startingEpoch);
  }

  // ---- routing -----------------------------------------------------------------------------

  function checkMutationRequest(request, response, principal) {
    if (!isOauth) {
      sendError(response, 409, 'not_available_in_cli_mode');
      return false;
    }
    if (!isReady) {
      sendError(response, 503, 'setup_required');
      return false;
    }
    if (hasAmbiguousHeaders(request) || request.url.includes('?')) {
      sendError(response, 400, 'bad_request');
      return false;
    }
    if (request.headers.origin !== config.origin) {
      sendError(response, 403, 'forbidden');
      return false;
    }
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      sendError(response, 403, 'forbidden');
      return false;
    }
    if (!isValidCsrf(request, principal)) {
      sendError(response, 403, 'invalid_csrf');
      return false;
    }
    return true;
  }

  async function handleStatus(request, response, principal) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendError(response, 405, 'method_not_allowed', { Allow: 'GET, HEAD' });
    }
    if (request.url.includes('?')) return sendError(response, 400, 'bad_request');
    return sendJson(response, 200, await status(principal), {
      headOnly: request.method === 'HEAD',
    });
  }

  async function handleStart(request, response, principal) {
    if (request.method !== 'POST') {
      return sendError(response, 405, 'method_not_allowed', { Allow: 'POST' });
    }
    if (!checkMutationRequest(request, response, principal)) return undefined;
    return startAttempt(request, response, principal);
  }

  async function handleDisconnect(request, response, principal) {
    if (request.method !== 'POST') {
      return sendError(response, 405, 'method_not_allowed', { Allow: 'POST' });
    }
    if (!checkMutationRequest(request, response, principal)) return undefined;
    const rawBody = await readJsonObject(request);
    if (rawBody.error) return sendError(response, rawBody.status, rawBody.error);
    if (Object.keys(rawBody.body).length !== 0) return sendError(response, 400, 'bad_request');
    try {
      // Local deletion only. Uninstalling the app stays a deliberate action inside Shopify.
      await disconnect();
    } catch {
      return sendError(response, 500, 'disconnect_failed');
    }
    return sendJson(response, 200, { disconnected: true });
  }

  async function handleCallback(request, response, principal) {
    if (request.method !== 'GET') {
      return sendError(response, 405, 'method_not_allowed', { Allow: 'GET' });
    }
    if (!isOauth) return sendError(response, 409, 'not_available_in_cli_mode');
    if (!isReady) return sendError(response, 503, 'setup_required');
    let succeeded = false;
    try {
      succeeded = await completeCallback(request, principal);
    } catch {
      succeeded = false;
    }
    return sendRedirect(
      response,
      succeeded ? CONNECTED_REDIRECT : FAILED_REDIRECT,
      clearingCookies(),
    );
  }

  const routes = new Map([
    [STATUS_PATH, handleStatus],
    [START_PATH, handleStart],
    [DISCONNECT_PATH, handleDisconnect],
    [CALLBACK_PATH, handleCallback],
  ]);

  async function handle(request, response, { pathname, principal }) {
    const route = routes.get(pathname);
    if (!route) return false;
    try {
      await route(request, response, principal);
    } catch {
      if (!response.headersSent) sendError(response, 500, 'connection_error');
    }
    return true;
  }

  return {
    status,
    handle,
    getAccessToken,
    markReauthorizationRequired,
    disconnect,
  };
}
