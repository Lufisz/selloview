// Opt-in, server-persisted dashboard settings (reporting period and theme).
//
// This is shared presentation state for the one configured store, not an account system.
// Access is decided by the owner gate in live-server.mjs before any route here runs; this
// module adds its own CSRF/Origin checks for writes and never trusts the client for paths,
// store names or field names.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createSecurityHeaders, rawHeaderValues } from './static-files.mjs';

export const SETTINGS_PATH = '/api/settings';
export const SETTINGS_FORMAT = 'metrictv-dashboard-settings';
export const SETTINGS_VERSION = 1;
export const PERIOD_VALUES = Object.freeze(['today', 'week', 'month', 'days60']);
export const THEME_VALUES = Object.freeze(['light', 'dark']);
export const DEFAULT_SETTINGS = Object.freeze({ period: 'week', theme: 'light' });

const MAX_FILE_BYTES = 2048;
const MAX_BODY_BYTES = 1024;
// Far below Number.MAX_SAFE_INTEGER; reaching it means something is wrong, not busy.
const MAX_REVISION = 1_000_000_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const RESPONSE_HEADERS = createSecurityHeaders({ allowApiRequests: true });

/** Failure with a stable code; messages never contain paths or file content. */
export class SettingsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SettingsError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(object, keys) {
  const actualKeys = Object.keys(object);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(object, key));
}

function isValidField(name, value) {
  if (name === 'period') return PERIOD_VALUES.includes(value);
  if (name === 'theme') return THEME_VALUES.includes(value);
  return false;
}

/** Complete settings object with exactly the known fields, or null. */
export function parseCompleteSettings(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ['period', 'theme'])) return null;
  if (!isValidField('period', value.period) || !isValidField('theme', value.theme)) return null;
  return { period: value.period, theme: value.theme };
}

/** Non-empty subset of the known fields, or null. */
export function parseSettingsPatch(value) {
  if (!isPlainObject(value)) return null;
  const names = Object.keys(value);
  if (names.length === 0) return null;
  for (const name of names) {
    if (!isValidField(name, value[name])) return null;
  }
  return { ...value };
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;
}

/**
 * Reads LIVE_SETTINGS_PATH. Returns null when the feature is not configured (the default).
 * A configured but unsafe value throws so a typo can never silently disable or relocate it.
 */
export function loadSettingsConfig(env = process.env) {
  const configured = env.LIVE_SETTINGS_PATH;
  if (configured === undefined || configured === '') return null;
  const isSafePath =
    typeof configured === 'string' &&
    !configured.includes('\0') &&
    path.isAbsolute(configured) &&
    path.normalize(configured) === configured &&
    configured.endsWith('.json');
  if (!isSafePath) throw new Error('LIVE_SETTINGS_PATH must be an absolute normalized .json path');
  return { filePath: configured };
}

function currentUserId() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function isOwnedByUs(stats) {
  const uid = currentUserId();
  return uid === undefined || stats.uid === uid;
}

/**
 * File-backed settings for exactly one store. The file records the store it was written for,
 * so a copy from another store's instance fails closed instead of being adopted.
 * Writes are serialized and compare the caller's revision, so two devices cannot silently
 * overwrite each other.
 */
export function createSettingsStore({ filePath, store }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new SettingsError('settings_unavailable');
  }
  if (path.normalize(filePath) !== filePath) throw new SettingsError('settings_unavailable');
  if (typeof store !== 'string' || store === '') throw new SettingsError('settings_unavailable');

  const directory = path.dirname(filePath);
  let queueTail = Promise.resolve();

  function enqueue(task) {
    const result = queueTail.then(task, task);
    queueTail = result.catch(() => {});
    return result;
  }

  async function assertPrivateDirectory({ create }) {
    let stats = await fs.lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw new SettingsError('settings_unavailable');
    });
    if (!stats) {
      if (!create) return false;
      await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      stats = await fs.lstat(directory);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new SettingsError('settings_unavailable');
    if (!isOwnedByUs(stats)) throw new SettingsError('settings_unavailable');
    if ((stats.mode & GROUP_AND_OTHER_BITS) !== 0) throw new SettingsError('settings_unavailable');
    // A symlinked ancestor would let another path alias the private directory.
    if ((await fs.realpath(directory)) !== directory)
      throw new SettingsError('settings_unavailable');
    return true;
  }

  async function readFileText() {
    if (!(await assertPrivateDirectory({ create: false }))) return null;
    let handle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new SettingsError('settings_unavailable');
    }
    try {
      const stats = await handle.stat();
      const isSafeFile =
        stats.isFile() &&
        stats.nlink === 1 &&
        isOwnedByUs(stats) &&
        (stats.mode & GROUP_AND_OTHER_BITS) === 0 &&
        stats.size <= MAX_FILE_BYTES;
      if (!isSafeFile) throw new SettingsError('settings_unavailable');
      const buffer = Buffer.alloc(stats.size);
      const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  function parseStoredState(text) {
    let stored;
    try {
      stored = JSON.parse(text);
    } catch {
      throw new SettingsError('settings_unavailable');
    }
    const expectedKeys = ['format', 'version', 'store', 'revision', 'settings'];
    if (!isPlainObject(stored) || !hasExactKeys(stored, expectedKeys)) {
      throw new SettingsError('settings_unavailable');
    }
    if (stored.format !== SETTINGS_FORMAT || stored.version !== SETTINGS_VERSION) {
      throw new SettingsError('settings_unavailable');
    }
    if (stored.store !== store) throw new SettingsError('scope_mismatch');
    const settings = parseCompleteSettings(stored.settings);
    if (!settings || !isRevision(stored.revision) || stored.revision === 0) {
      throw new SettingsError('settings_unavailable');
    }
    return { revision: stored.revision, settings };
  }

  async function readState() {
    const text = await readFileText();
    // Revision 0 means "never saved": defaults, and clients keep their own local choices.
    if (text === null) return { revision: 0, settings: { ...DEFAULT_SETTINGS } };
    return parseStoredState(text);
  }

  async function writeAtomically(state) {
    await assertPrivateDirectory({ create: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    const text = JSON.stringify({
      format: SETTINGS_FORMAT,
      version: SETTINGS_VERSION,
      store,
      revision: state.revision,
      settings: state.settings,
    });
    let handle;
    try {
      handle = await fs.open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, filePath);
      const directoryHandle = await fs.open(
        directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error instanceof SettingsError ? error : new SettingsError('settings_unavailable');
    }
  }

  return {
    /** @returns {Promise<{revision: number, settings: {period: string, theme: string}}>} */
    load() {
      return enqueue(readState);
    },

    /**
     * Applies a validated patch if `expectedRevision` is still current.
     * Rejects with SettingsError('revision_conflict') carrying the current state otherwise.
     * A patch that changes nothing does not advance the revision.
     */
    update(expectedRevision, patch) {
      return enqueue(async () => {
        const current = await readState();
        if (current.revision !== expectedRevision) {
          const conflict = new SettingsError('revision_conflict');
          conflict.current = current;
          throw conflict;
        }
        const settings = { ...current.settings, ...patch };
        const changed =
          settings.period !== current.settings.period || settings.theme !== current.settings.theme;
        // The first save from a never-saved store must persist even if it equals the defaults.
        if (!changed && current.revision > 0) return current;
        if (current.revision >= MAX_REVISION) throw new SettingsError('settings_unavailable');
        const next = { revision: current.revision + 1, settings };
        await writeAtomically(next);
        return next;
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------------------------

function sendJson(response, status, payload, { headOnly = false, extraHeaders = {} } = {}) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    ...RESPONSE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  response.end(headOnly ? undefined : text);
}

function sendError(response, status, code, extraHeaders) {
  sendJson(response, status, { error: code }, { extraHeaders });
}

function hasAmbiguousHeaders(request) {
  const guarded = ['content-type', 'content-length', 'origin', 'x-csrf-token', 'transfer-encoding'];
  return guarded.some((name) => rawHeaderValues(request.rawHeaders ?? [], name).length > 1);
}

async function readSmallJsonObject(request) {
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
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
  if (!isPlainObject(parsed)) return { error: 'bad_request', status: 400 };
  return { body: parsed };
}

/**
 * @param {{ store: {load: Function, update: Function}, origin: string }} options
 *   `origin` is the exact HTTPS origin the owner uses (from LIVE_ORIGIN).
 * The CSRF secret is random per process and independent of any Shopify credential.
 */
export function createSettingsService({ store, origin }) {
  const csrfSecret = crypto.randomBytes(32);

  function csrfTokenFor(principal) {
    return crypto
      .createHmac('sha256', csrfSecret)
      .update(`settings-csrf\n${principal}`)
      .digest('base64url');
  }

  function isValidCsrf(request, principal) {
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string') return false;
    const expected = Buffer.from(csrfTokenFor(principal));
    const received = Buffer.from(supplied);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  async function handleRead(request, response, principal) {
    let state;
    try {
      state = await store.load();
    } catch {
      // Unreadable, corrupt or other-store files all look the same to the browser.
      return sendJson(
        response,
        503,
        { error: 'settings_unavailable' },
        { headOnly: request.method === 'HEAD' },
      );
    }
    return sendJson(
      response,
      200,
      {
        enabled: true,
        revision: state.revision,
        settings: state.settings,
        csrfToken: csrfTokenFor(principal),
      },
      { headOnly: request.method === 'HEAD' },
    );
  }

  function checkWriteRequest(request, response, principal) {
    if (hasAmbiguousHeaders(request)) {
      sendError(response, 400, 'bad_request');
      return false;
    }
    if (request.headers.origin !== origin) {
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

  async function handleWrite(request, response, principal) {
    if (!checkWriteRequest(request, response, principal)) return undefined;
    const read = await readSmallJsonObject(request);
    if (read.error) return sendError(response, read.status, read.error);
    const { body } = read;
    const patch = hasExactKeys(body, ['revision', 'settings'])
      ? parseSettingsPatch(body.settings)
      : null;
    if (!patch || !isRevision(body.revision)) return sendError(response, 400, 'bad_request');
    try {
      const saved = await store.update(body.revision, patch);
      return sendJson(response, 200, { revision: saved.revision, settings: saved.settings });
    } catch (error) {
      if (error instanceof SettingsError && error.code === 'revision_conflict') {
        return sendJson(response, 409, {
          error: 'revision_conflict',
          revision: error.current.revision,
          settings: error.current.settings,
        });
      }
      return sendError(response, 503, 'settings_unavailable');
    }
  }

  /** @returns {Promise<boolean>} true when the request was an /api/settings request and was answered. */
  async function handle(request, response, { pathname, principal }) {
    if (pathname !== SETTINGS_PATH) return false;
    try {
      if (request.url.includes('?')) {
        sendError(response, 400, 'bad_request');
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        await handleRead(request, response, principal);
      } else if (request.method === 'POST') {
        await handleWrite(request, response, principal);
      } else {
        sendError(response, 405, 'method_not_allowed', { Allow: 'GET, HEAD, POST' });
      }
    } catch {
      if (!response.headersSent) sendError(response, 500, 'settings_error');
    }
    return true;
  }

  return { handle, csrfTokenFor };
}
