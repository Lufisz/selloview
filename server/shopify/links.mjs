// Per-workspace Shopify store links and pending OAuth attempts (SQLite, schema version 3).
//
// A workspace is linked to at most one store and a store to at most one workspace (UNIQUE on
// both), which is what stops a second owner from ever reading the first owner's figures.
// Credentials are NOT here: they live in encrypted per-workspace grant files (connection-service).
import crypto from 'node:crypto';

export const SHOPIFY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_store (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    shop TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('connected', 'reconnect_required')),
    linked_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shopify_oauth_attempt (
    id TEXT PRIMARY KEY NOT NULL,
    state_hash TEXT NOT NULL UNIQUE,
    binding_hash TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    shop TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shopify_oauth_attempt_expires
    ON shopify_oauth_attempt (expires_at);
`;

// ceiling: 50 store connections waiting for Shopify's approval for the whole server (10 per
// minute), upgrade: per-workspace caps when many owners connect at once
export const MAX_OPEN_ATTEMPTS = 50;

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hashesMatch(firstHex, secondHex) {
  const first = Buffer.from(firstHex, 'hex');
  const second = Buffer.from(secondHex, 'hex');
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

// ---- store links -----------------------------------------------------------------------------

export function readLink(database, workspaceId) {
  return (
    database
      .prepare('SELECT workspace_id, shop, state FROM workspace_store WHERE workspace_id = ?')
      .get(workspaceId) ?? null
  );
}

export function readLinkByShop(database, shop) {
  return (
    database
      .prepare('SELECT workspace_id, shop, state FROM workspace_store WHERE shop = ?')
      .get(shop) ?? null
  );
}

/**
 * Links the workspace to the store in one statement. Returns 'ok', or 'conflict' when another
 * workspace already holds that store. The UNIQUE constraint decides races, not a prior read.
 */
export function claimStore(database, { workspaceId, shop, state, nowMs }) {
  try {
    database
      .prepare(
        `INSERT INTO workspace_store (workspace_id, shop, state, linked_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE
           SET shop = excluded.shop, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(workspaceId, shop, state, nowMs, nowMs);
    return 'ok';
  } catch (error) {
    if (/UNIQUE constraint failed/.test(String(error?.message))) return 'conflict';
    throw error;
  }
}

export function setLinkState(database, { workspaceId, state, nowMs }) {
  database
    .prepare('UPDATE workspace_store SET state = ?, updated_at = ? WHERE workspace_id = ?')
    .run(state, nowMs, workspaceId);
}

export function removeLink(database, workspaceId) {
  database.prepare('DELETE FROM workspace_store WHERE workspace_id = ?').run(workspaceId);
}

/** Puts a previously read link (or its absence) back after a failed connection attempt. */
export function restoreLink(database, { workspaceId, previous, nowMs }) {
  if (previous === null) return removeLink(database, workspaceId);
  claimStore(database, { workspaceId, shop: previous.shop, state: previous.state, nowMs });
}

// ---- pending OAuth attempts ------------------------------------------------------------------

/**
 * Records one pending attempt. Starting again replaces the workspace's earlier attempt, so at
 * most one is ever valid per workspace. Returns false when too many are open overall.
 */
export function createAttempt(database, attempt) {
  database.prepare('DELETE FROM shopify_oauth_attempt WHERE expires_at <= ?').run(attempt.nowMs);
  database
    .prepare('DELETE FROM shopify_oauth_attempt WHERE workspace_id = ?')
    .run(attempt.workspaceId);
  const { open } = database.prepare('SELECT COUNT(*) AS open FROM shopify_oauth_attempt').get();
  if (open >= MAX_OPEN_ATTEMPTS) return false;
  database
    .prepare(
      `INSERT INTO shopify_oauth_attempt
         (id, state_hash, binding_hash, workspace_id, user_id, session_id, shop,
          created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      sha256Hex(attempt.state),
      sha256Hex(attempt.bindingSecret),
      attempt.workspaceId,
      attempt.userId,
      attempt.sessionId,
      attempt.shop,
      attempt.nowMs,
      attempt.nowMs + attempt.lifetimeMs,
    );
  return true;
}

/** One-use: deleting the row is what consumes it, so a replay finds nothing. */
export function consumeAttempt(database, state) {
  return (
    database
      .prepare('DELETE FROM shopify_oauth_attempt WHERE state_hash = ? RETURNING *')
      .get(sha256Hex(state)) ?? null
  );
}

export function discardAttemptsForWorkspace(database, workspaceId) {
  database.prepare('DELETE FROM shopify_oauth_attempt WHERE workspace_id = ?').run(workspaceId);
}

// ---- who is still signed in ------------------------------------------------------------------

/**
 * The owner's Better Auth session, looked up by id, or null when it was deleted (sign-out,
 * revocation) or has expired. The callback cannot carry the SameSite=Strict session cookie, so
 * this is how it proves that the initiating session is still alive.
 */
export function readLiveSession(database, sessionId, nowMs) {
  const row = database
    .prepare(
      `SELECT session.id AS sessionId, session.userId AS userId,
              session.expiresAt AS expiresAt, "user".email AS email
       FROM session JOIN "user" ON "user".id = session.userId
       WHERE session.id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  const expiresAtMs = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
  return { sessionId: row.sessionId, userId: row.userId, email: row.email };
}

export function readWorkspaceOwnerEmail(database, workspaceId) {
  const row = database
    .prepare(
      `SELECT "user".email AS email FROM workspace
       JOIN "user" ON "user".id = workspace.owner_user_id WHERE workspace.id = ?`,
    )
    .get(workspaceId);
  return row ? row.email : null;
}

export function workspaceIsOwnedBy(database, workspaceId, userId) {
  const row = database
    .prepare('SELECT 1 AS owned FROM workspace WHERE id = ? AND owner_user_id = ?')
    .get(workspaceId, userId);
  return Boolean(row);
}
