// Operator configuration for the app server and the admin CLI, read from environment variables.
// Everything unsafe or missing throws; nothing falls back to a default location or secret.
import { parseDatabasePath } from './accounts/private-database.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 4330;
const MIN_SECRET_LENGTH = 32;
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
