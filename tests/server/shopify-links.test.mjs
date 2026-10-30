// Store links, one-use OAuth attempts and the schema 3 migration that adds their tables.
// Data here is SYNTHETIC and labelled as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OPEN_ATTEMPTS,
  claimStore,
  consumeAttempt,
  createAttempt,
  readLiveSession,
  readLink,
  removeLink,
  restoreLink,
} from '../../server/shopify/links.mjs';
import {
  AccountError,
  migrateDatabase,
  openInitializedDatabase,
} from '../../server/accounts/accounts.mjs';
import { createBetaEnvironment } from '../helpers/app-server.mjs';
import { SYNTHETIC_STORE } from '../helpers/synthetic-shopify.mjs';

const OWNER = 'owner@example.test';

// ---- links and attempts ------------------------------------------------------------------------

async function databaseWithOwners(t, emails) {
  const environment = await createBetaEnvironment(t, { invites: emails });
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  const workspaces = emails.map((email) =>
    database
      .prepare(
        `SELECT workspace.id AS workspaceId, "user".id AS userId FROM workspace
           JOIN "user" ON "user".id = workspace.owner_user_id WHERE "user".email = ?`,
      )
      .get(email),
  );
  return { environment, database, workspaces };
}

test('a store belongs to one workspace; the unique constraint decides, not a prior read', async (t) => {
  const { database, workspaces } = await databaseWithOwners(t, [OWNER, 'second@example.test']);
  const [first, second] = workspaces;
  const nowMs = Date.now();
  assert.equal(
    claimStore(database, {
      workspaceId: first.workspaceId,
      shop: SYNTHETIC_STORE,
      state: 'connected',
      nowMs,
    }),
    'ok',
  );
  assert.equal(
    claimStore(database, {
      workspaceId: second.workspaceId,
      shop: SYNTHETIC_STORE,
      state: 'connected',
      nowMs,
    }),
    'conflict',
  );
  assert.equal(readLink(database, second.workspaceId), null);
  // Claiming again from the owner updates, it does not fail.
  assert.equal(
    claimStore(database, {
      workspaceId: first.workspaceId,
      shop: SYNTHETIC_STORE,
      state: 'reconnect_required',
      nowMs,
    }),
    'ok',
  );
  assert.equal(readLink(database, first.workspaceId).state, 'reconnect_required');

  // Putting a failed attempt back restores exactly what was there before.
  const previous = readLink(database, first.workspaceId);
  claimStore(database, {
    workspaceId: first.workspaceId,
    shop: SYNTHETIC_STORE,
    state: 'connected',
    nowMs,
  });
  restoreLink(database, { workspaceId: first.workspaceId, previous, nowMs });
  assert.equal(readLink(database, first.workspaceId).state, 'reconnect_required');
  removeLink(database, first.workspaceId);
  restoreLink(database, { workspaceId: first.workspaceId, previous: null, nowMs });
  assert.equal(readLink(database, first.workspaceId), null);
});

test('a pending attempt is one-use, one per workspace and bounded overall', async (t) => {
  const { database, workspaces } = await databaseWithOwners(t, [OWNER, 'second@example.test']);
  const [first, second] = workspaces;
  const nowMs = Date.now();
  const attempt = (workspace, state) => ({
    state,
    bindingSecret: `binding-${state}`,
    workspaceId: workspace.workspaceId,
    userId: workspace.userId,
    sessionId: 'session-id',
    shop: SYNTHETIC_STORE,
    nowMs,
    lifetimeMs: 60_000,
  });
  assert.equal(createAttempt(database, attempt(first, 'state-one')), true);
  assert.equal(createAttempt(database, attempt(first, 'state-two')), true);
  assert.equal(consumeAttempt(database, 'state-one'), null, 'a newer start replaced it');
  assert.equal(createAttempt(database, attempt(second, 'state-three')), true);

  const taken = consumeAttempt(database, 'state-two');
  assert.equal(taken.workspace_id, first.workspaceId);
  assert.equal(taken.binding_hash.includes('binding'), false, 'only hashes are stored');
  assert.equal(consumeAttempt(database, 'state-two'), null, 'consuming is one-use');

  database.prepare('DELETE FROM shopify_oauth_attempt').run();
  const insertRow = database.prepare(
    `INSERT INTO shopify_oauth_attempt
       (id, state_hash, binding_hash, workspace_id, user_id, session_id, shop, created_at, expires_at)
     VALUES (?, ?, 'h', ?, ?, 's', ?, ?, ?)`,
  );
  for (let index = 0; index < MAX_OPEN_ATTEMPTS; index += 1) {
    insertRow.run(
      `id-${index}`,
      `hash-${index}`,
      first.workspaceId,
      first.userId,
      SYNTHETIC_STORE,
      nowMs,
      nowMs + 60_000,
    );
  }
  assert.equal(createAttempt(database, attempt(second, 'state-over-cap')), false);
  // Expired rows do not count against the cap.
  database.prepare('UPDATE shopify_oauth_attempt SET expires_at = ?').run(nowMs - 1);
  assert.equal(createAttempt(database, attempt(second, 'state-after-expiry')), true);
});

test('a session counts as live only while its row exists and has not expired', async (t) => {
  const { database, environment } = await databaseWithOwners(t, [OWNER]);
  const user = database.prepare('SELECT id FROM "user"').get();
  const insert = database.prepare(
    `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const nowMs = Date.now();
  const later = new Date(nowMs + 60_000).toISOString();
  const earlier = new Date(nowMs - 60_000).toISOString();
  insert.run('live-session', later, 'token-one', earlier, earlier, user.id);
  insert.run('old-session', earlier, 'token-two', earlier, earlier, user.id);
  assert.equal(readLiveSession(database, 'live-session', nowMs).email, OWNER);
  assert.equal(readLiveSession(database, 'old-session', nowMs), null);
  assert.equal(readLiveSession(database, 'missing', nowMs), null);
  database.prepare('DELETE FROM session WHERE id = ?').run('live-session');
  assert.equal(readLiveSession(database, 'live-session', nowMs), null);
  assert.ok(environment.databasePath);
});

// ---- migration ---------------------------------------------------------------------------------

test('schema 2 is refused until migrated; migration keeps accounts, sessions, screens and settings', async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [OWNER] });
  const database = openInitializedDatabase(environment.databasePath);
  const user = database.prepare('SELECT id FROM "user"').get();
  const workspace = database.prepare('SELECT id FROM workspace').get();
  database
    .prepare(
      `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES ('kept-session', '2099-01-01T00:00:00.000Z', 'kept-token', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(user.id);
  database
    .prepare(
      `INSERT INTO display_session (id, secret_hash, workspace_id, name, created_at, expires_at, last_seen_at)
       VALUES ('kept-screen', 'hash', ?, 'Kept TV', 1, 4102444800000, NULL)`,
    )
    .run(workspace.id);
  database
    .prepare("UPDATE workspace_settings SET period = 'month', theme = 'dark', revision = 4")
    .run();

  // Emulate a version 2 file: the two tables version 3 adds do not exist.
  database.exec(
    'DROP TABLE shopify_oauth_attempt; DROP TABLE workspace_store; PRAGMA user_version = 2;',
  );
  database.close();
  assert.throws(
    () => openInitializedDatabase(environment.databasePath),
    (error) => error instanceof AccountError && error.code === 'schema_not_current',
  );

  const credentials = {
    databasePath: environment.databasePath,
    secret: environment.secret,
    origin: environment.origin,
  };
  await migrateDatabase(credentials);
  await migrateDatabase(credentials); // idempotent

  const migrated = openInitializedDatabase(environment.databasePath);
  t.after(() => migrated.close());
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(migrated.prepare('SELECT email FROM "user"').get().email, OWNER);
  assert.equal(
    migrated.prepare("SELECT id FROM session WHERE id = 'kept-session'").get().id,
    'kept-session',
  );
  assert.equal(
    migrated.prepare("SELECT name FROM display_session WHERE id = 'kept-screen'").get().name,
    'Kept TV',
  );
  assert.deepEqual(
    { ...migrated.prepare('SELECT period, theme, revision FROM workspace_settings').get() },
    { period: 'month', theme: 'dark', revision: 4 },
  );
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM workspace_store').get().n, 0);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM shopify_oauth_attempt').get().n, 0);
});
