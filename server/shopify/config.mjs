// Optional Shopify settings, read from the private runtime environment.
//
// All six names absent: the app honestly reports "setup required" and offers no connection.
// Some but not all, or any malformed value: startup fails (fail closed) and names the settings to
// fix. The values never reach a browser, a log or a serialized config object.
import path from 'node:path';
import { ShopifyError, validateStore } from './shop-data.mjs';
import { normalizeInviteEmail } from '../accounts/accounts.mjs';
import { PROJECT_ROOT, isCleanAbsolutePath, isInside } from '../private-files.mjs';

const SETTING_NAMES = Object.freeze([
  'METRICTV_SHOPIFY_CLIENT_ID',
  'METRICTV_SHOPIFY_CLIENT_SECRET',
  'METRICTV_SHOPIFY_ENCRYPTION_KEY',
  'METRICTV_SHOPIFY_TOKEN_DIR',
  'METRICTV_SHOPIFY_ALLOWED_STORE',
  'METRICTV_SHOPIFY_OWNER_EMAIL',
]);

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLIENT_SECRET_PATTERN = /^[\x21-\x7e]{16,256}$/;

// The message is for the operator at start-up: it names settings, never a value.
function invalidConfig(...settingNames) {
  return new ShopifyError(
    'invalid_connection_config',
    `invalid_connection_config: missing or malformed: ${settingNames.join(', ')}`,
  );
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function parseEncryptionKey(text) {
  if (typeof text !== 'string') throw invalidConfig('METRICTV_SHOPIFY_ENCRYPTION_KEY');
  const key = Buffer.from(text, 'base64');
  const isCanonical = key.length === 32 && key.toString('base64') === text;
  if (!isCanonical) throw invalidConfig('METRICTV_SHOPIFY_ENCRYPTION_KEY');
  return key;
}

function hideSecrets(target, secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    // Non-enumerable: console.log / JSON.stringify of the config cannot print secrets.
    Object.defineProperty(target, name, { value, enumerable: false });
  }
  return Object.freeze(target);
}

function parseTokenDirectory(value, projectRoot) {
  const isUsableDirectory =
    isCleanAbsolutePath(value) && !value.endsWith(path.sep) && value !== path.parse(value).root;
  if (!isUsableDirectory) throw invalidConfig('METRICTV_SHOPIFY_TOKEN_DIR');
  // The project root contains public/, so this also keeps credentials out of anything served.
  if (isInside(projectRoot, value)) throw invalidConfig('METRICTV_SHOPIFY_TOKEN_DIR');
  return value;
}

function parseOwnerEmail(value) {
  try {
    return normalizeInviteEmail(value);
  } catch {
    throw invalidConfig('METRICTV_SHOPIFY_OWNER_EMAIL');
  }
}

function parseStore(value) {
  try {
    return validateStore(value);
  } catch {
    throw invalidConfig('METRICTV_SHOPIFY_ALLOWED_STORE');
  }
}

/**
 * Pure: never reads files. Returns `{ status: 'setup_required' }` or a frozen ready config whose
 * secrets are non-enumerable. Throws ShopifyError('invalid_connection_config'), whose message
 * names the settings to fix and never a value.
 */
export function loadShopifyConfig(env, { projectRoot = PROJECT_ROOT } = {}) {
  const missingNames = SETTING_NAMES.filter((name) => isBlank(env[name]));
  if (missingNames.length === SETTING_NAMES.length) {
    return Object.freeze({ status: 'setup_required' });
  }
  if (missingNames.length > 0) throw invalidConfig(...missingNames);

  const clientId = env.METRICTV_SHOPIFY_CLIENT_ID;
  const clientSecret = env.METRICTV_SHOPIFY_CLIENT_SECRET;
  if (!CLIENT_ID_PATTERN.test(clientId)) throw invalidConfig('METRICTV_SHOPIFY_CLIENT_ID');
  if (!CLIENT_SECRET_PATTERN.test(clientSecret)) {
    throw invalidConfig('METRICTV_SHOPIFY_CLIENT_SECRET');
  }
  return hideSecrets(
    {
      status: 'ready',
      store: parseStore(env.METRICTV_SHOPIFY_ALLOWED_STORE),
      ownerEmail: parseOwnerEmail(env.METRICTV_SHOPIFY_OWNER_EMAIL),
    },
    {
      clientId,
      clientSecret,
      encryptionKey: parseEncryptionKey(env.METRICTV_SHOPIFY_ENCRYPTION_KEY),
      tokenDirectory: parseTokenDirectory(env.METRICTV_SHOPIFY_TOKEN_DIR, projectRoot),
    },
  );
}
