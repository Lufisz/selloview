// Optional Shopify settings for the beta, read from the private runtime environment.
//
// All six names absent: the beta honestly reports "setup required" and offers no connection.
// Some but not all, or any malformed value: startup fails (fail closed) with a code only.
// The values never reach a browser, a log or a serialized config object.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShopifyError, validateStore } from '../shopify.mjs';
import { normalizeInviteEmail } from './accounts.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETTING_NAMES = Object.freeze([
  'BETA_SHOPIFY_CLIENT_ID',
  'BETA_SHOPIFY_CLIENT_SECRET',
  'BETA_SHOPIFY_ENCRYPTION_KEY',
  'BETA_SHOPIFY_TOKEN_DIR',
  'BETA_SHOPIFY_ALLOWED_STORE',
  'BETA_SHOPIFY_OWNER_EMAIL',
]);

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLIENT_SECRET_PATTERN = /^[\x21-\x7e]{16,256}$/;

function invalidConfig() {
  return new ShopifyError('invalid_connection_config');
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function parseEncryptionKey(text) {
  if (typeof text !== 'string') throw invalidConfig();
  const key = Buffer.from(text, 'base64');
  const isCanonical = key.length === 32 && key.toString('base64') === text;
  if (!isCanonical) throw invalidConfig();
  return key;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  const escapesParent = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!escapesParent && !path.isAbsolute(relative));
}

function hideSecrets(target, secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    // Non-enumerable: console.log / JSON.stringify of the config cannot print secrets.
    Object.defineProperty(target, name, { value, enumerable: false });
  }
  return Object.freeze(target);
}

function parseTokenDirectory(value, projectRoot) {
  const isAbsoluteAndClean =
    typeof value === 'string' &&
    !value.includes('\0') &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !value.endsWith(path.sep) &&
    value !== path.parse(value).root;
  if (!isAbsoluteAndClean) throw invalidConfig();
  // The project root contains public/, so this also keeps credentials out of anything served.
  if (isInside(projectRoot, value)) throw invalidConfig();
  return value;
}

function parseOwnerEmail(value) {
  try {
    return normalizeInviteEmail(value);
  } catch {
    throw invalidConfig();
  }
}

function parseStore(value) {
  try {
    return validateStore(value);
  } catch {
    throw invalidConfig();
  }
}

/**
 * Pure: never reads files. Returns `{ status: 'setup_required' }` or a frozen ready config whose
 * secrets are non-enumerable. Throws ShopifyError('invalid_connection_config') without details.
 */
export function loadBetaShopifyConfig(env, { projectRoot = PROJECT_ROOT } = {}) {
  const presentCount = SETTING_NAMES.filter((name) => !isBlank(env[name])).length;
  if (presentCount === 0) return Object.freeze({ status: 'setup_required' });
  if (presentCount !== SETTING_NAMES.length) throw invalidConfig();

  const clientId = env.BETA_SHOPIFY_CLIENT_ID;
  const clientSecret = env.BETA_SHOPIFY_CLIENT_SECRET;
  if (!CLIENT_ID_PATTERN.test(clientId)) throw invalidConfig();
  if (!CLIENT_SECRET_PATTERN.test(clientSecret)) throw invalidConfig();
  return hideSecrets(
    {
      status: 'ready',
      store: parseStore(env.BETA_SHOPIFY_ALLOWED_STORE),
      ownerEmail: parseOwnerEmail(env.BETA_SHOPIFY_OWNER_EMAIL),
    },
    {
      clientId,
      clientSecret,
      encryptionKey: parseEncryptionKey(env.BETA_SHOPIFY_ENCRYPTION_KEY),
      tokenDirectory: parseTokenDirectory(env.BETA_SHOPIFY_TOKEN_DIR, projectRoot),
    },
  );
}
