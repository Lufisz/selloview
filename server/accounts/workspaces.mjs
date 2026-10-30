// One owner, one workspace. The owner is always an authenticated user id taken from a verified
// session on the server; nothing here accepts an owner or workspace id from a browser.
import crypto from 'node:crypto';
import { inTransaction } from './private-database.mjs';

const DEFAULT_WORKSPACE_NAME = 'My MetricTV';
const MAX_REVISION = 1_000_000_000;
const PERIOD_VALUES = Object.freeze(['today', 'week', 'month', 'days60']);
const THEME_VALUES = Object.freeze(['light', 'dark']);
const DEFAULT_SETTINGS = Object.freeze({ period: 'week', theme: 'light' });

const WORKSPACE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY NOT NULL,
    owner_user_id TEXT NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_settings (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    period TEXT NOT NULL CHECK (period IN ('today', 'week', 'month', 'days60')),
    theme TEXT NOT NULL CHECK (theme IN ('light', 'dark')),
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * Call after Better Auth's migration: workspace.owner_user_id references its user table. The
 * schema version is owned by accounts.mjs, which applies every table group together.
 */
export function applyWorkspaceSchema(database) {
  database.exec(WORKSPACE_SCHEMA);
}

const WORKSPACE_SELECT = `SELECT workspace.id, workspace.name, settings.period, settings.theme,
    settings.revision
  FROM workspace
  JOIN workspace_settings AS settings ON settings.workspace_id = workspace.id`;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidField(name, value) {
  if (name === 'period') return PERIOD_VALUES.includes(value);
  if (name === 'theme') return THEME_VALUES.includes(value);
  return false;
}

/** Non-empty subset of the known settings fields, or null. */
function parseSettingsPatch(value) {
  if (!isPlainObject(value)) return null;
  const names = Object.keys(value);
  if (names.length === 0) return null;
  for (const name of names) {
    if (!isValidField(name, value[name])) return null;
  }
  return { ...value };
}

function toWorkspace(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    settings: { period: row.period, theme: row.theme },
  };
}

function readWorkspace(database, ownerUserId) {
  const row = database
    .prepare(`${WORKSPACE_SELECT} WHERE workspace.owner_user_id = ?`)
    .get(ownerUserId);
  return toWorkspace(row);
}

/** For display sessions, which know their workspace id but never an owner. */
export function readWorkspaceById(database, workspaceId) {
  const row = database.prepare(`${WORKSPACE_SELECT} WHERE workspace.id = ?`).get(workspaceId);
  return toWorkspace(row);
}

/**
 * Returns the owner's workspace, creating it once. The UNIQUE owner column makes concurrent
 * first requests converge on the same row; the loser's insert is ignored.
 */
export function ensureWorkspace(database, ownerUserId) {
  const existing = readWorkspace(database, ownerUserId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const workspaceId = crypto.randomUUID();
  inTransaction(database, () => {
    const inserted = database
      .prepare(
        `INSERT OR IGNORE INTO workspace (id, owner_user_id, name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(workspaceId, ownerUserId, DEFAULT_WORKSPACE_NAME, now);
    if (inserted.changes === 1) {
      database
        .prepare(
          `INSERT INTO workspace_settings (workspace_id, period, theme, revision, updated_at)
           VALUES (?, ?, ?, 0, ?)`,
        )
        .run(workspaceId, DEFAULT_SETTINGS.period, DEFAULT_SETTINGS.theme, now);
    }
  });
  return readWorkspace(database, ownerUserId);
}

/**
 * Applies a validated settings patch if the caller saw the current revision.
 * Returns { status: 'ok' | 'conflict' | 'invalid', workspace }.
 */
export function updateWorkspaceSettings(database, ownerUserId, { patch, expectedRevision }) {
  const validPatch = parseSettingsPatch(patch);
  const revisionIsValid =
    Number.isSafeInteger(expectedRevision) &&
    expectedRevision >= 0 &&
    expectedRevision < MAX_REVISION;
  if (!validPatch || !revisionIsValid) return { status: 'invalid' };

  const workspace = ensureWorkspace(database, ownerUserId);
  const nextSettings = { ...workspace.settings, ...validPatch };
  const result = database
    .prepare(
      `UPDATE workspace_settings
       SET period = ?, theme = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND revision = ?`,
    )
    .run(
      nextSettings.period,
      nextSettings.theme,
      new Date().toISOString(),
      workspace.id,
      expectedRevision,
    );
  const status = result.changes === 1 ? 'ok' : 'conflict';
  return { status, workspace: readWorkspace(database, ownerUserId) };
}
