// Private SQLite file: accounts, sessions, rate limits, workspaces, screens and store links.
//
// The path is explicit operator configuration. Serving never creates the file, so a typo or a
// wiped disk cannot silently start a fresh, empty (and therefore takeover-able) account store.
// Creation is a separate operator command (`npm run admin -- init`).
//
// ceiling: one SQLite file used by one server process, upgrade: Postgres when a second instance is
// needed (the SQL is confined to the accounts, screens and shopify/links modules)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const BUSY_TIMEOUT_MS = 5000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Failure with a stable code; messages never contain file content. */
export class PrivateDatabaseError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'PrivateDatabaseError';
    this.code = code;
  }
}

function isInside(directory, candidate) {
  return candidate === directory || candidate.startsWith(directory + path.sep);
}

/** Validates METRICTV_DB_PATH. Throws instead of falling back to a default location. */
export function parseDatabasePath(configured, projectRoot = PROJECT_ROOT) {
  const isSafePath =
    typeof configured === 'string' &&
    configured !== '' &&
    !configured.includes('\0') &&
    path.isAbsolute(configured) &&
    path.normalize(configured) === configured &&
    configured.endsWith('.sqlite');
  if (!isSafePath) {
    throw new PrivateDatabaseError(
      'invalid_path',
      'METRICTV_DB_PATH must be an absolute normalized path ending in .sqlite',
    );
  }
  if (isInside(projectRoot, configured)) {
    throw new PrivateDatabaseError(
      'inside_project',
      'METRICTV_DB_PATH must be outside the project',
    );
  }
  return configured;
}

function currentUserId() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertPrivate(stats, code) {
  const uid = currentUserId();
  if (uid !== undefined && stats.uid !== uid) throw new PrivateDatabaseError(code);
  if ((stats.mode & GROUP_AND_OTHER_BITS) !== 0) throw new PrivateDatabaseError(code);
}

function assertPrivateDirectory(directory) {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory()) throw new PrivateDatabaseError('unsafe_directory');
  assertPrivate(stats, 'unsafe_directory');
}

function assertPrivateFile(filePath) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile()) throw new PrivateDatabaseError('unsafe_file');
  assertPrivate(stats, 'unsafe_file');
}

function configureConnection(database) {
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

/** Creates the directory (0700) and an empty file (0600). Refuses to touch an existing file. */
export function createPrivateDatabaseFile(databasePath) {
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(directory);
  let descriptor;
  try {
    descriptor = fs.openSync(databasePath, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    if (error.code === 'EEXIST') throw new PrivateDatabaseError('already_exists');
    throw error;
  }
  fs.closeSync(descriptor);
  assertPrivateFile(databasePath);
}

/** Opens an existing, private, regular database file. Never creates one. */
export function openPrivateDatabase(databasePath) {
  let missing = false;
  try {
    assertPrivateDirectory(path.dirname(databasePath));
    assertPrivateFile(databasePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missing = true;
  }
  if (missing) {
    throw new PrivateDatabaseError('not_initialized', 'Run `npm run admin -- init` first');
  }
  return configureConnection(new DatabaseSync(databasePath));
}
