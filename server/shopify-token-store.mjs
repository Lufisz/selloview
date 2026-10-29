import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { ShopifyError } from './shopify.mjs';

/**
 * Encrypted, restart-persistent storage for the ONE offline Shopify grant of this instance.
 *
 * The file holds a small JSON envelope. The grant inside is encrypted with AES-256-GCM using a
 * random IV; the app client id and store are authenticated (but not secret) additional data, so a
 * file copied from another app or store fails to decrypt instead of being trusted.
 *
 * Epochs make disconnect race-safe: every `remove()` and `replace()` starts a new epoch, and a
 * write that was prepared under an older epoch is refused. A refresh that finishes after the owner
 * disconnected therefore cannot bring the deleted credentials back.
 */

export const ENVELOPE_FORMAT = 'metrictv-shopify-token-store';
export const ENVELOPE_VERSION = 1;
export const REQUIRED_SCOPES = Object.freeze([
  'read_all_orders',
  'read_orders',
  'read_products',
  'read_inventory',
]);

const MAX_FILE_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 4096;
const MAX_ACCESS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REFRESH_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/** True only for exactly the approved read-only scope set, in any order. */
export function hasExactRequiredScopes(scopes) {
  if (!Array.isArray(scopes)) return false;
  if (scopes.length !== REQUIRED_SCOPES.length) return false;
  const received = new Set(scopes);
  if (received.size !== REQUIRED_SCOPES.length) return false;
  for (const scope of REQUIRED_SCOPES) {
    if (!received.has(scope)) return false;
  }
  return true;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isToken(value) {
  return typeof value === 'string' && value.length <= MAX_TOKEN_LENGTH && TOKEN_PATTERN.test(value);
}

/**
 * Validate a decrypted or about-to-be-saved grant and return a clean copy.
 * Throws ShopifyError('invalid_grant') for anything unexpected.
 */
export function validateGrant(grant, { clientId, store, savedAtLimit } = {}) {
  if (!isPlainObject(grant)) throw new ShopifyError('invalid_grant');
  if (grant.shop !== store || grant.clientId !== clientId) throw new ShopifyError('invalid_grant');
  if (grant.offline !== true) throw new ShopifyError('invalid_grant');
  if (!hasExactRequiredScopes(grant.scopes)) throw new ShopifyError('invalid_grant');
  if (!isToken(grant.accessToken) || !isToken(grant.refreshToken)) {
    throw new ShopifyError('invalid_grant');
  }
  if (!isTimestamp(grant.savedAt)) throw new ShopifyError('invalid_grant');
  if (!isTimestamp(grant.accessTokenExpiresAt) || !isTimestamp(grant.refreshTokenExpiresAt)) {
    throw new ShopifyError('invalid_grant');
  }
  const accessLifetime = grant.accessTokenExpiresAt - grant.savedAt;
  const refreshLifetime = grant.refreshTokenExpiresAt - grant.savedAt;
  if (accessLifetime > MAX_ACCESS_LIFETIME_MS) throw new ShopifyError('invalid_grant');
  if (refreshLifetime > MAX_REFRESH_LIFETIME_MS) throw new ShopifyError('invalid_grant');
  if (savedAtLimit !== undefined && grant.savedAt > savedAtLimit) {
    throw new ShopifyError('invalid_grant');
  }
  return {
    shop: grant.shop,
    clientId: grant.clientId,
    offline: true,
    scopes: [...REQUIRED_SCOPES],
    accessToken: grant.accessToken,
    accessTokenExpiresAt: grant.accessTokenExpiresAt,
    refreshToken: grant.refreshToken,
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
    savedAt: grant.savedAt,
  };
}

// `workspaceId` is only set by the multi-workspace beta: it binds a file to one workspace, so a
// copy placed under another workspace's name fails to decrypt. Without it the data is unchanged.
function associatedData(clientId, store, workspaceId) {
  const base = `${ENVELOPE_FORMAT}/v${ENVELOPE_VERSION}\nclient:${clientId}\nstore:${store}`;
  return Buffer.from(workspaceId === undefined ? base : `${base}\nworkspace:${workspaceId}`);
}

function encryptGrant(grant, { key, clientId, store, workspaceId }) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(clientId, store, workspaceId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

/** Recognise our own file format without needing the key (used before replace/delete). */
function parseEnvelopeShape(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(envelope)) return null;
  if (envelope.format !== ENVELOPE_FORMAT || envelope.version !== ENVELOPE_VERSION) return null;
  const fields = ['iv', 'tag', 'data'];
  for (const field of fields) {
    if (typeof envelope[field] !== 'string') return null;
  }
  return envelope;
}

function decryptGrant(envelope, { key, clientId, store, workspaceId }) {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new ShopifyError('token_store');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(clientId, store, workspaceId));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    // Wrong key, other app/store binding, tampering, or corruption: all fail closed alike.
    throw new ShopifyError('token_store');
  }
}

function currentUserId() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function isOwnedByUs(stats) {
  const uid = currentUserId();
  return uid === undefined || stats.uid === uid;
}

/**
 * Create the store for one fixed app client and store.
 * `key` must be a 32 byte Buffer. No I/O happens until a method is called.
 */
export function createTokenStore({ filePath, key, clientId, store, workspaceId }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new ShopifyError('token_store');
  }
  if (path.normalize(filePath) !== filePath) throw new ShopifyError('token_store');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new ShopifyError('token_store');
  if (typeof clientId !== 'string' || typeof store !== 'string') {
    throw new ShopifyError('token_store');
  }
  if (workspaceId !== undefined && typeof workspaceId !== 'string') {
    throw new ShopifyError('token_store');
  }

  const directory = path.dirname(filePath);
  let epoch = 0;
  let queueTail = Promise.resolve();

  /** Run tasks strictly one after another; a failed task never blocks the next one. */
  function enqueue(task) {
    const result = queueTail.then(task, task);
    queueTail = result.catch(() => {});
    return result;
  }

  async function assertPrivateDirectory({ create }) {
    let stats = await fs.lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw new ShopifyError('token_store');
    });
    if (!stats) {
      if (!create) return false;
      await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      stats = await fs.lstat(directory);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ShopifyError('token_store');
    if (!isOwnedByUs(stats)) throw new ShopifyError('token_store');
    if ((stats.mode & GROUP_AND_OTHER_BITS) !== 0) throw new ShopifyError('token_store');
    // A symlinked ancestor would let another path alias the private directory.
    const resolved = await fs.realpath(directory);
    if (resolved !== directory) throw new ShopifyError('token_store');
    return true;
  }

  /** Read the file safely; returns null when absent. Never follows a symlink. */
  async function readFileText() {
    const directoryExists = await assertPrivateDirectory({ create: false });
    if (!directoryExists) return null;
    let handle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new ShopifyError('token_store');
    }
    try {
      const stats = await handle.stat();
      const isSafeFile =
        stats.isFile() &&
        stats.nlink === 1 &&
        isOwnedByUs(stats) &&
        (stats.mode & GROUP_AND_OTHER_BITS) === 0 &&
        stats.size <= MAX_FILE_BYTES;
      if (!isSafeFile) throw new ShopifyError('token_store');
      const buffer = Buffer.alloc(stats.size);
      const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async function syncDirectory() {
    const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function assertCanReplaceExisting() {
    const text = await readFileText();
    if (text === null) return;
    if (!parseEnvelopeShape(text)) throw new ShopifyError('token_store');
  }

  async function writeAtomically(envelope) {
    await assertPrivateDirectory({ create: true });
    await assertCanReplaceExisting();
    const temporaryPath = path.join(
      directory,
      `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
      await handle.writeFile(JSON.stringify(envelope), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, filePath);
      await syncDirectory();
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error instanceof ShopifyError ? error : new ShopifyError('token_store');
    }
  }

  async function saveUnderEpoch(grant, expectedEpoch, { startsNewLineage }) {
    const clean = validateGrant(grant, { clientId, store });
    return await enqueue(async () => {
      if (expectedEpoch !== epoch) throw new ShopifyError('stale_write');
      await writeAtomically(encryptGrant(clean, { key, clientId, store, workspaceId }));
      // Removal can invalidate the lineage while an awaited fsync/rename is in progress.
      // The queued removal cleans the disk; this write must not be published back to memory.
      if (expectedEpoch !== epoch) throw new ShopifyError('stale_write');
      if (startsNewLineage) epoch += 1;
      return epoch;
    });
  }

  return {
    /** Increases on every remove/replace. Capture it before slow work, pass it back to save. */
    get epoch() {
      return epoch;
    },

    /** Returns a validated grant, or null when nothing is stored. Throws on corruption/wrong key. */
    load() {
      return enqueue(async () => {
        const text = await readFileText();
        if (text === null) return null;
        const envelope = parseEnvelopeShape(text);
        if (!envelope) throw new ShopifyError('token_store');
        const decrypted = decryptGrant(envelope, { key, clientId, store, workspaceId });
        try {
          return validateGrant(decrypted, { clientId, store });
        } catch {
          throw new ShopifyError('token_store');
        }
      });
    },

    /** Persist a refreshed grant of the CURRENT lineage. Refused if a disconnect/reconnect intervened. */
    save(grant, expectedEpoch) {
      return saveUnderEpoch(grant, expectedEpoch, { startsNewLineage: false });
    },

    /** Persist a freshly authorized grant. Invalidates every refresh prepared under older epochs. */
    replace(grant, expectedEpoch) {
      return saveUnderEpoch(grant, expectedEpoch, { startsNewLineage: true });
    },

    /**
     * Delete local credentials. The epoch changes immediately (before the delete is queued) so
     * anything already in flight can no longer save. Only our own file format is deleted.
     */
    remove() {
      epoch += 1;
      return enqueue(async () => {
        const text = await readFileText();
        if (text === null) return;
        if (!parseEnvelopeShape(text)) throw new ShopifyError('token_store');
        await fs.unlink(filePath);
        await syncDirectory();
      });
    },
  };
}
