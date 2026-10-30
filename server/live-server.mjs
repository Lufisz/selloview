// Loopback-only live dashboard backend. Trusts only the local Tailscale Serve proxy.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliRunner, validateStore } from './shopify.mjs';
import { createAdminRunner } from './shopify-admin.mjs';
import { createShopSnapshotCache } from './shopify/snapshot-cache.mjs';
import { BETA_ONLY_PATHS } from './beta/public-files.mjs';
import { createShopifyConnection, loadConnectionConfig } from './shopify-connection.mjs';
import {
  createSettingsService,
  createSettingsStore,
  loadSettingsConfig,
} from './live-settings.mjs';
import {
  applyServerLimits,
  createSecurityHeaders,
  findPublicFile,
  isReadMethod,
  parseRequestPath,
  SERVER_OPTIONS,
  singleHeaderValue,
} from './static-files.mjs';

// The pilot's tests still import these names from here; they go away with the pilot.
export { createSnapshotCache as createCache, toSafeErrorCode } from './shopify/snapshot-cache.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const IDENTITY_HEADER = 'tailscale-user-login';

// The public demo has its own entry files; shared assets (styles.css, model.js, mark.svg) stay available.
const DEMO_ONLY_PATHS = new Set(['/index.html', '/app.js', '/data.js', ...BETA_ONLY_PATHS]);

const RESPONSE_HEADERS = createSecurityHeaders({ allowApiRequests: true });

/**
 * @typedef {object} LiveConfig
 * @property {string} store   Validated *.myshopify.com domain.
 * @property {Set<string>} users  Lower-case allowed Tailscale logins.
 * @property {string} host    Lower-case host[:port] the proxy must send in Host.
 * @property {number} port
 */

/** @returns {LiveConfig} Throws on any invalid setting (fail closed). */
export function loadConfig(env = process.env) {
  const store = validateStore(env.SHOPIFY_STORE);
  const users = String(env.LIVE_ALLOWED_USERS || '')
    .split(',')
    .map((user) => user.trim().toLowerCase())
    .filter(Boolean);
  if (users.length === 0) throw new Error('LIVE_ALLOWED_USERS required');

  let origin;
  try {
    origin = new URL(env.LIVE_ORIGIN);
  } catch {
    throw new Error('LIVE_ORIGIN must be an HTTPS origin');
  }
  const isPlainHttpsOrigin =
    origin.protocol === 'https:' &&
    origin.pathname === '/' &&
    !origin.search &&
    !origin.hash &&
    !origin.username &&
    !origin.password;
  if (!isPlainHttpsOrigin) throw new Error('LIVE_ORIGIN must be an HTTPS origin');

  const port = env.PORT === undefined || env.PORT === '' ? 4318 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('bad PORT');
  return { store, users: new Set(users), host: origin.host.toLowerCase(), port };
}

export function isLoopback(address) {
  return LOOPBACK_ADDRESSES.has(address);
}

// Exactly one non-empty, non-comma-joined identity header, lower-cased; otherwise null.
function readIdentity(request) {
  const value = singleHeaderValue(request.rawHeaders, IDENTITY_HEADER);
  return value ? value.toLowerCase() : null;
}

// Exactly one Host header; a repeated or comma-joined Host is never trusted.
function readHost(request) {
  const value = singleHeaderValue(request.rawHeaders, 'host');
  return value ? value.toLowerCase() : null;
}

function sendBody(
  response,
  status,
  body,
  { contentType = 'application/json; charset=utf-8', headOnly = false, extraHeaders = {} } = {},
) {
  response.writeHead(status, {
    ...RESPONSE_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(headOnly ? undefined : body);
}

function sendJson(response, status, payload, headOnly = false) {
  sendBody(response, status, JSON.stringify(payload), { headOnly });
}

/** Request order matters: loopback, host, owner identity, then method, then path/files/snapshot. */
export function createHandler({
  config,
  cache,
  connection,
  settings,
  publicDir = path.join(PROJECT_ROOT, 'public'),
}) {
  async function serveSnapshot(response, headOnly, principal) {
    if (connection) {
      const status = await connection.status(principal);
      if (status.mode === 'oauth' && status.state !== 'connected') {
        const errors = {
          reconnect_required: { status: 401, error: 'reauthorization_required' },
          not_connected: { status: 409, error: 'store_not_connected' },
          setup_required: { status: 503, error: 'setup_required' },
        };
        const denial = errors[status.state] ?? errors.setup_required;
        return sendJson(response, denial.status, { error: denial.error }, headOnly);
      }
    }
    const sync = cache.sync();
    if (!cache.snapshot) return sendJson(response, 503, { error: 'no_snapshot', sync }, headOnly);
    return sendJson(response, 200, { ...cache.snapshot, sync }, headOnly);
  }

  async function serveStaticFile(response, pathname, headOnly) {
    const file = await findPublicFile(publicDir, pathname, {
      indexFile: 'live.html',
      blockedPaths: DEMO_ONLY_PATHS,
    });
    if (!file) return sendJson(response, 404, { error: 'not_found' }, headOnly);
    let data;
    try {
      data = await fs.readFile(file.filePath);
    } catch {
      return sendJson(response, 404, { error: 'not_found' }, headOnly);
    }
    response.writeHead(200, {
      ...RESPONSE_HEADERS,
      'Content-Type': file.contentType,
      'Content-Length': data.length,
    });
    response.end(headOnly ? undefined : data);
  }

  async function handleRequest(request, response) {
    if (!isLoopback(request.socket?.remoteAddress))
      return sendJson(response, 403, { error: 'forbidden' });
    if (readHost(request) !== config.host) return sendJson(response, 403, { error: 'forbidden' });
    const user = readIdentity(request);
    if (!user || !config.users.has(user)) return sendJson(response, 403, { error: 'forbidden' });

    const parsed = parseRequestPath(request.url);
    if (parsed.rejection === 'bad_request')
      return sendJson(response, 400, { error: 'bad_request' }, request.method === 'HEAD');
    if (parsed.rejection)
      return sendJson(response, 404, { error: 'not_found' }, request.method === 'HEAD');

    // The owner gate above applies equally to OAuth start, callback, status and disconnect.
    if (
      connection &&
      (await connection.handle(request, response, { pathname: parsed.pathname, principal: user }))
    )
      return;

    // Opt-in shared settings. Same owner gate as above; without the service the route does not exist.
    if (
      settings &&
      (await settings.handle(request, response, { pathname: parsed.pathname, principal: user }))
    )
      return;

    if (!isReadMethod(request.method)) {
      return sendBody(response, 405, '{"error":"method_not_allowed"}', {
        extraHeaders: { Allow: 'GET, HEAD' },
      });
    }
    const headOnly = request.method === 'HEAD';

    if (parsed.pathname === '/api/snapshot') return serveSnapshot(response, headOnly, user);
    return serveStaticFile(response, parsed.pathname, headOnly);
  }

  return (request, response) => {
    handleRequest(request, response).catch(() => {
      if (response.headersSent) return response.destroy();
      sendJson(response, 503, { error: 'service_unavailable' }, request.method === 'HEAD');
    });
  };
}

export function createLiveServer({ config, cache, connection, settings, publicDir }) {
  return applyServerLimits(
    http.createServer(
      SERVER_OPTIONS,
      createHandler({ config, cache, connection, settings, publicDir }),
    ),
  );
}

export function createLiveCache(
  config,
  { connection, authMode = 'cli', fetchImpl = fetch, now = () => Date.now() } = {},
) {
  if (!['cli', 'oauth'].includes(authMode) || (authMode === 'oauth' && !connection)) {
    throw new Error('Invalid Shopify connection mode');
  }
  const run =
    authMode === 'oauth'
      ? createAdminRunner({ store: config.store, connection, fetchImpl })
      : createCliRunner({ store: config.store });
  return createShopSnapshotCache({ store: config.store, run, now });
}

/** Returns the settings service, or null unless LIVE_SETTINGS_PATH is explicitly configured. */
export function createConfiguredSettings(config, env = process.env) {
  const settingsConfig = loadSettingsConfig(env);
  if (!settingsConfig) return null;
  // Private operator state never belongs in the source tree, which may be served or committed.
  const relative = path.relative(PROJECT_ROOT, settingsConfig.filePath);
  const isInsideProject =
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (isInsideProject) throw new Error('LIVE_SETTINGS_PATH must be outside the project directory');
  return createSettingsService({
    store: createSettingsStore({ filePath: settingsConfig.filePath, store: config.store }),
    origin: `https://${config.host}`,
  });
}

export function startLive(env = process.env) {
  const config = loadConfig(env); // throws => fail closed
  const settings = createConfiguredSettings(config, env);
  const connectionConfig = loadConnectionConfig(env, {
    store: config.store,
    origin: `https://${config.host}`,
  });
  let cache;
  const connection = createShopifyConnection({
    config: connectionConfig,
    onChange: ({ state }) => {
      cache.clear();
      if (state === 'connected') void cache.refresh();
    },
  });
  cache = createLiveCache(config, { connection, authMode: connectionConfig.mode });
  const server = createLiveServer({ config, cache, connection, settings });
  server.listen(config.port, '127.0.0.1', () => cache.start());
  server.once('close', () => cache.stop());
  return { server, cache, config, connection };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startLive();
  } catch (error) {
    console.error('live-server: invalid configuration:', error.message);
    process.exit(1);
  }
}
