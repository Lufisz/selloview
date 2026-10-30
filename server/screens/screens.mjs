// TV pairing challenges and display sessions.
//
// A TV page creates a challenge: a random secret kept in its HttpOnly cookie plus a short code
// shown on screen. An owner submits the code; that only marks the challenge approved for the
// owner's workspace. The approved challenge can then be exchanged exactly once, and only by the
// holder of the challenge secret, for an opaque display-only credential.
//
// Credentials look like `<id>.<secret>`. Only a SHA-256 hash of the secret is stored, and it is
// compared in constant time. Nothing here reads an owner or workspace id from a browser.
import crypto from 'node:crypto';
import { inTransaction } from '../accounts/private-database.mjs';
import { constantTimeEqual, sha256Hex } from '../hashing.mjs';

export const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
export const DISPLAY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// ceiling: 200 pairing codes open at once for the whole server (about 40 screens pairing per
// minute), upgrade: per-address caps when a large fleet starts at the same time
export const MAX_OPEN_CHALLENGES = 200;
export const MAX_SCREENS_PER_WORKSPACE = 10;
export const MAX_SCREEN_NAME_LENGTH = 40;

const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
// A screen in use keeps its pairing: at most once a day, activity moves the expiry back to a
// full 30 days ahead. Only a screen that stays off for 30 days has to be paired again.
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ID_BYTES = 16;
const SECRET_BYTES = 32;
const CODE_ATTEMPTS_PER_CREATION = 5;
// 32 symbols without look-alikes (no 0/O, 1/I): 8 symbols is 40 bits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CREDENTIAL_PATTERN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const SCREEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SCREEN_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

export const SCREEN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pairing_challenge (
    id TEXT PRIMARY KEY NOT NULL,
    secret_hash TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved')),
    workspace_id TEXT REFERENCES workspace (id) ON DELETE CASCADE,
    screen_name TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    CHECK ((state = 'pending') = (workspace_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS pairing_challenge_expires ON pairing_challenge (expires_at);
  CREATE TABLE IF NOT EXISTS display_session (
    id TEXT PRIMARY KEY NOT NULL,
    secret_hash TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS display_session_workspace ON display_session (workspace_id);
`;

function secretMatches(secret, storedHash) {
  return constantTimeEqual(sha256Hex(secret), storedHash);
}

function newCredential() {
  const id = crypto.randomBytes(ID_BYTES).toString('base64url');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { id, secret, text: `${id}.${secret}`, secretHash: sha256Hex(secret) };
}

function parseCredential(text) {
  const match = typeof text === 'string' ? CREDENTIAL_PATTERN.exec(text) : null;
  return match ? { id: match[1], secret: match[2] } : null;
}

// ---- Codes ----------------------------------------------------------------------------------

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/** `ab cd-efgh` -> `ABCDEFGH`; null when it cannot be a code. */
export function normalizeCode(text) {
  if (typeof text !== 'string') return null;
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  const isValid = code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
  return isValid ? code : null;
}

/** `ABCDEFGH` -> `ABCD-EFGH`, the form shown on the TV. */
export function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Trimmed screen name, or null when empty, too long or containing unusual characters. */
export function parseScreenName(text) {
  if (typeof text !== 'string') return null;
  const name = text.normalize('NFC').trim();
  const isValid =
    name.length >= 1 && name.length <= MAX_SCREEN_NAME_LENGTH && SCREEN_NAME_PATTERN.test(name);
  return isValid ? name : null;
}

export function isScreenId(value) {
  return typeof value === 'string' && SCREEN_ID_PATTERN.test(value);
}

// ---- Challenges -----------------------------------------------------------------------------

/** Deletes expired challenges and display sessions. Every read already ignores them. */
export function purgeExpiredScreens(database, nowMs = Date.now()) {
  database.prepare('DELETE FROM pairing_challenge WHERE expires_at <= ?').run(nowMs);
  database.prepare('DELETE FROM display_session WHERE expires_at <= ?').run(nowMs);
}

/**
 * Creates a pending challenge. Returns null while too many challenges are open, so storage
 * stays bounded however many anonymous pages ask.
 */
export function createChallenge(database) {
  const nowMs = Date.now();
  const open = database
    .prepare('SELECT COUNT(*) AS total FROM pairing_challenge WHERE expires_at > ?')
    .get(nowMs).total;
  if (open >= MAX_OPEN_CHALLENGES) return null;

  const credential = newCredential();
  for (let attempt = 0; attempt < CODE_ATTEMPTS_PER_CREATION; attempt += 1) {
    const code = generateCode();
    try {
      database
        .prepare(
          `INSERT INTO pairing_challenge
             (id, secret_hash, code_hash, state, created_at, expires_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          credential.id,
          credential.secretHash,
          sha256Hex(code),
          nowMs,
          nowMs + CHALLENGE_LIFETIME_MS,
        );
      return { credential: credential.text, code, expiresAt: nowMs + CHALLENGE_LIFETIME_MS };
    } catch (error) {
      // Only a duplicate code is retried; anything else is a real failure.
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
  }
  return null;
}

/** The unexpired challenge whose secret matches, or null. The code is never needed here. */
export function readChallenge(database, credentialText) {
  const credential = parseCredential(credentialText);
  if (!credential) return null;
  const row = database
    .prepare(
      `SELECT id, secret_hash, state, workspace_id, screen_name, expires_at
       FROM pairing_challenge WHERE id = ? AND expires_at > ?`,
    )
    .get(credential.id, Date.now());
  if (!row || !secretMatches(credential.secret, row.secret_hash)) return null;
  return row;
}

/** A TV that asks for a new code drops its previous challenge. */
export function discardChallenge(database, credentialText) {
  const challenge = readChallenge(database, credentialText);
  if (challenge) database.prepare('DELETE FROM pairing_challenge WHERE id = ?').run(challenge.id);
}

/**
 * Owner approval. Wrong, expired and already-approved codes are indistinguishable.
 * @returns {'ok' | 'invalid_code' | 'screen_limit'}
 */
export function approveChallenge(database, { workspaceId, code, screenName }) {
  const codeHash = sha256Hex(code);
  const nowMs = Date.now();
  return inTransaction(database, () => {
    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM display_session
              WHERE workspace_id = ? AND expires_at > ?) +
           (SELECT COUNT(*) FROM pairing_challenge
              WHERE workspace_id = ? AND expires_at > ?) AS total`,
      )
      .get(workspaceId, nowMs, workspaceId, nowMs);
    if (counts.total >= MAX_SCREENS_PER_WORKSPACE) return 'screen_limit';
    const approved = database
      .prepare(
        `UPDATE pairing_challenge
         SET state = 'approved', workspace_id = ?, screen_name = ?
         WHERE code_hash = ? AND state = 'pending' AND expires_at > ?`,
      )
      .run(workspaceId, screenName, codeHash, nowMs);
    return approved.changes === 1 ? 'ok' : 'invalid_code';
  });
}

/**
 * Turns an approved challenge into a display session, once. The delete decides the race: only
 * the caller that removes the row creates the session.
 * @returns {{status: 'ok', credential: string, expiresAt: number} | {status: 'pending' | 'invalid'}}
 */
export function exchangeChallenge(database, credentialText) {
  const challenge = readChallenge(database, credentialText);
  if (!challenge) return { status: 'invalid' };
  if (challenge.state !== 'approved') return { status: 'pending' };

  const nowMs = Date.now();
  const session = newCredential();
  const expiresAt = nowMs + DISPLAY_LIFETIME_MS;
  return inTransaction(database, () => {
    const removed = database
      .prepare("DELETE FROM pairing_challenge WHERE id = ? AND state = 'approved'")
      .run(challenge.id);
    if (removed.changes !== 1) return { status: 'invalid' };
    database
      .prepare(
        `INSERT INTO display_session
           (id, secret_hash, workspace_id, name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.secretHash,
        challenge.workspace_id,
        challenge.screen_name,
        nowMs,
        expiresAt,
      );
    return { status: 'ok', credential: session.text, expiresAt };
  });
}

// ---- Display sessions -----------------------------------------------------------------------

/** The live display session for a credential, or null (unknown, wrong secret, expired, revoked). */
export function readDisplaySession(database, credentialText) {
  const credential = parseCredential(credentialText);
  if (!credential) return null;
  const row = database
    .prepare(
      `SELECT id, secret_hash, workspace_id, name, expires_at, last_seen_at
       FROM display_session WHERE id = ? AND expires_at > ?`,
    )
    .get(credential.id, Date.now());
  if (!row || !secretMatches(credential.secret, row.secret_hash)) return null;
  return row;
}

/** Records activity at most once a minute so polling does not turn into constant writes. */
export function recordDisplaySeen(database, session) {
  const nowMs = Date.now();
  const isFresh =
    session.last_seen_at !== null && nowMs - session.last_seen_at < LAST_SEEN_WRITE_INTERVAL_MS;
  if (isFresh) return;
  database
    .prepare('UPDATE display_session SET last_seen_at = ? WHERE id = ?')
    .run(nowMs, session.id);
}

/**
 * Pushes an active session's expiry to 30 days from now, at most once a day.
 * @returns {number|null} the new expiry when renewed, else null (not due, or revoked meanwhile)
 */
export function renewDisplaySession(database, session, nowMs = Date.now()) {
  const renewedExpiry = nowMs + DISPLAY_LIFETIME_MS;
  if (renewedExpiry - session.expires_at < RENEW_INTERVAL_MS) return null;
  const updated = database
    .prepare('UPDATE display_session SET expires_at = ? WHERE id = ?')
    .run(renewedExpiry, session.id);
  return updated.changes === 1 ? renewedExpiry : null;
}

/** Screens of one workspace, without any credential material. */
export function listScreens(database, workspaceId) {
  const rows = database
    .prepare(
      `SELECT id, name, created_at, last_seen_at, expires_at FROM display_session
       WHERE workspace_id = ? AND expires_at > ? ORDER BY created_at, id`,
    )
    .all(workspaceId, Date.now());
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    pairedAt: new Date(row.created_at).toISOString(),
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }));
}

/** Deletes one screen of this workspace. False when it does not exist or belongs to another. */
export function revokeScreen(database, workspaceId, screenId) {
  const removed = database
    .prepare('DELETE FROM display_session WHERE id = ? AND workspace_id = ?')
    .run(screenId, workspaceId);
  return removed.changes === 1;
}
