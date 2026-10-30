// Operator configuration for the app server and the admin CLI, read from environment variables.
// Everything unsafe or missing throws; nothing falls back to a default location or secret.
import { DatabaseSync } from 'node:sqlite';
import { parseDatabasePath } from './accounts/private-database.mjs';

const MINIMUM_NODE_VERSION = '22.16';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 4330;
const MIN_SECRET_LENGTH = 32;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HEADER_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

// These settings were called BETA_* before the project went public. A leftover one stops the
// server and the admin CLI: an environment file that is only half renamed would otherwise run with
// the old half silently ignored (a missing secret is caught, an ignored port or proxy header is not).
// Temporary: delete this table once no deployment still sets the old names.
const RENAMED_SETTINGS = Object.freeze({
  BETA_DB_PATH: 'METRICTV_DB_PATH',
  BETA_AUTH_SECRET: 'METRICTV_AUTH_SECRET',
  BETA_ORIGIN: 'METRICTV_ORIGIN',
  BETA_PORT: 'METRICTV_PORT',
  BETA_TRUSTED_IP_HEADER: 'METRICTV_TRUSTED_IP_HEADER',
  BETA_RESEND_API_KEY: 'METRICTV_RESEND_API_KEY',
  BETA_MAIL_FROM: 'METRICTV_MAIL_FROM',
  BETA_SELF_REGISTRATION: 'METRICTV_SELF_REGISTRATION',
  BETA_REGISTRATION_MAX_ACCOUNTS: 'METRICTV_REGISTRATION_MAX_ACCOUNTS',
  BETA_SHOPIFY_CLIENT_ID: 'METRICTV_SHOPIFY_CLIENT_ID',
  BETA_SHOPIFY_CLIENT_SECRET: 'METRICTV_SHOPIFY_CLIENT_SECRET',
  BETA_SHOPIFY_ENCRYPTION_KEY: 'METRICTV_SHOPIFY_ENCRYPTION_KEY',
  BETA_SHOPIFY_TOKEN_DIR: 'METRICTV_SHOPIFY_TOKEN_DIR',
  BETA_SHOPIFY_ALLOWED_STORE: 'METRICTV_SHOPIFY_ALLOWED_STORE',
  BETA_SHOPIFY_OWNER_EMAIL: 'METRICTV_SHOPIFY_OWNER_EMAIL',
});

/** Throws when a setting is still under its old name, even if empty. Never prints a value. */
function assertNoRenamedSettings(env) {
  const leftovers = [];
  for (const [oldName, newName] of Object.entries(RENAMED_SETTINGS)) {
    if (Object.hasOwn(env, oldName)) {
      leftovers.push(`${oldName} is now ${newName}`);
    }
  }
  if (leftovers.length > 0) {
    throw new Error(`Rename these settings and start again: ${leftovers.join(', ')}`);
  }
}

// Better Auth's SQLite adapter calls statement.columns(), which node:sqlite has from Node 22.16.
// An older Node starts and then fails on the first sign-in from inside the library, so refuse here.
export function assertSupportedRuntime(Database = DatabaseSync) {
  const probe = new Database(':memory:');
  const hasColumns = typeof probe.prepare('SELECT 1').columns === 'function';
  probe.close();
  if (!hasColumns) {
    throw new Error(
      `Node.js ${process.versions.node} is too old: use Node.js ${MINIMUM_NODE_VERSION} or later`,
    );
  }
}

/** Reads operator configuration from environment variables; throws on anything unsafe. */
export function loadServerConfig(env = process.env, Database = DatabaseSync) {
  assertSupportedRuntime(Database);
  assertNoRenamedSettings(env);
  const databasePath = parseDatabasePath(env.METRICTV_DB_PATH);

  const secret = env.METRICTV_AUTH_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`METRICTV_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const origin = parseOrigin(env.METRICTV_ORIGIN);

  const portText = env.METRICTV_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
    throw new Error('METRICTV_PORT must be a TCP port');
  }

  // Only set when a trusted proxy in front always overwrites this header (e.g. cf-connecting-ip).
  const trustedIpHeader = (env.METRICTV_TRUSTED_IP_HEADER ?? '').toLowerCase();
  if (trustedIpHeader !== '' && !HEADER_NAME_PATTERN.test(trustedIpHeader)) {
    throw new Error('METRICTV_TRUSTED_IP_HEADER is not a valid header name');
  }

  return { databasePath, secret, origin, port, host: LOOPBACK_HOST, trustedIpHeader };
}

function parseOrigin(configured) {
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('METRICTV_ORIGIN must be an exact origin such as https://metrictv.example.com');
  }
  const isExact = configured === url.origin;
  const isSecure = url.protocol === 'https:';
  const isLoopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!isExact || !(isSecure || isLoopbackHttp)) {
    throw new Error('METRICTV_ORIGIN must be an https origin (http only for loopback)');
  }
  return url.origin;
}
