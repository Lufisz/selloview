// Expired rows are deleted on a timer, not on every request. Real SQLite, synthetic rows: each
// table gets one row that can never be used again and one that still can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openInitializedDatabase } from '../../server/accounts/accounts.mjs';
import { purgeExpiredRows, startHousekeeping } from '../../server/housekeeping.mjs';
import { createAppEnvironment } from '../helpers/app-server.mjs';

const OWNER = 'owner@example.test';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = Date.parse('2026-10-30T12:00:00Z');

async function openDatabaseWithOwner(t) {
  const environment = await createAppEnvironment(t, { invites: [OWNER] });
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  const userId = database.prepare('SELECT id FROM "user" WHERE email = ?').get(OWNER).id;
  const workspaceId = database
    .prepare('SELECT id FROM workspace WHERE owner_user_id = ?')
    .get(userId).id;
  return { database, userId, workspaceId };
}

function insertChallenge(database, id, expiresAt) {
  database
    .prepare(
      `INSERT INTO pairing_challenge (id, secret_hash, code_hash, state, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, 'a'.repeat(64), `code-${id}`, NOW, expiresAt);
}

function insertDisplaySession(database, workspaceId, id, expiresAt) {
  database
    .prepare(
      `INSERT INTO display_session (id, secret_hash, workspace_id, name, created_at, expires_at)
       VALUES (?, ?, ?, 'TV', ?, ?)`,
    )
    .run(id, 'b'.repeat(64), workspaceId, NOW, expiresAt);
}

// Better Auth stores its expiry times as ISO text.
function insertSession(database, userId, id, expiresAt) {
  const timestamp = new Date(NOW).toISOString();
  database
    .prepare(
      `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, new Date(expiresAt).toISOString(), `token-${id}`, timestamp, timestamp, userId);
}

function insertSignInCode(database, id, expiresAt) {
  const timestamp = new Date(NOW).toISOString();
  database
    .prepare(
      `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, 'hashed-code', ?, ?, ?)`,
    )
    .run(
      id,
      `sign-in-otp-${id}@example.test`,
      new Date(expiresAt).toISOString(),
      timestamp,
      timestamp,
    );
}

function insertRateLimit(database, id, lastRequest) {
  database
    .prepare('INSERT INTO rateLimit (id, key, count, lastRequest) VALUES (?, ?, 1, ?)')
    .run(id, `127.0.0.1|/${id}`, lastRequest);
}

function remainingIds(database, table) {
  return database
    .prepare(`SELECT id FROM "${table}" ORDER BY id`)
    .all()
    .map((row) => row.id);
}

test('expired rows are deleted from every table and live rows are kept', async (t) => {
  const { database, userId, workspaceId } = await openDatabaseWithOwner(t);
  const past = NOW - HOUR_MS;
  const future = NOW + HOUR_MS;
  insertChallenge(database, 'expired', past);
  insertChallenge(database, 'live', future);
  insertDisplaySession(database, workspaceId, 'expired', past);
  insertDisplaySession(database, workspaceId, 'live', future);
  insertSession(database, userId, 'expired', past);
  insertSession(database, userId, 'live', future);
  insertSignInCode(database, 'expired', past);
  insertSignInCode(database, 'live', future);
  // A rate-limit row older than its one-minute window no longer limits anything.
  insertRateLimit(database, 'expired', NOW - 2 * MINUTE_MS);
  insertRateLimit(database, 'live', NOW - 10_000);

  purgeExpiredRows(database, NOW);

  const tables = ['pairing_challenge', 'display_session', 'session', 'verification', 'rateLimit'];
  for (const table of tables) {
    assert.deepEqual(remainingIds(database, table), ['live'], table);
  }
});

test('housekeeping purges at start and every hour, and stops when asked', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { database } = await openDatabaseWithOwner(t);
  const expiredAt = Date.now() - HOUR_MS; // the timer purges against the real clock

  insertChallenge(database, 'before-start', expiredAt);
  const stop = startHousekeeping(database);
  assert.deepEqual(remainingIds(database, 'pairing_challenge'), [], 'purged once at start');

  insertChallenge(database, 'during-the-hour', expiredAt);
  t.mock.timers.tick(59 * MINUTE_MS);
  assert.deepEqual(remainingIds(database, 'pairing_challenge'), ['during-the-hour']);
  t.mock.timers.tick(MINUTE_MS);
  assert.deepEqual(remainingIds(database, 'pairing_challenge'), [], 'purged after an hour');

  stop();
  insertChallenge(database, 'after-stop', expiredAt);
  t.mock.timers.tick(2 * HOUR_MS);
  assert.deepEqual(remainingIds(database, 'pairing_challenge'), ['after-stop']);
});

test('a failing purge is logged by name and does not stop the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { database } = await openDatabaseWithOwner(t);
  const logged = [];
  t.mock.method(console, 'error', (line) => logged.push(line));
  const stop = startHousekeeping(database);
  t.after(stop);

  database.prepare('DROP TABLE pairing_challenge').run();
  t.mock.timers.tick(HOUR_MS);

  assert.equal(logged.length, 1);
  const entry = JSON.parse(logged[0]);
  assert.equal(entry.event, 'housekeeping_failed');
  assert.equal(typeof entry.error, 'string');
  t.mock.timers.tick(HOUR_MS);
  assert.equal(logged.length, 2, 'the next hour tries again');
});
