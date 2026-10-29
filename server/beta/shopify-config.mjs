// Optional Shopify settings for the beta, read from the private runtime environment.
//
// All six names absent: the beta honestly reports "setup required" and offers no connection.
// Some but not all, or any malformed value: startup fails (fail closed) with a code only.
// The values never reach a browser, a log or a serialized config object.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStore } from '../shopify.mjs';
import {
  CLIENT_ID_PATTERN,
  CLIENT_SECRET_PATTERN,
  hideSecrets,
  invalidConfig,
  isBlank,
  isInside,
  parseEncryptionKey,
} from '../shopify-connection.mjs';
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
