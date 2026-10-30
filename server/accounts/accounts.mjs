// Operator-side account administration. Used by scripts/admin.mjs and tests; never
// reachable from HTTP.
import { getMigrations } from 'better-auth/db/migration';
import { createAuth, createAuthOptions } from './auth.mjs';
import { applyWorkspaceSchema, ensureWorkspace } from './workspaces.mjs';
import { SCREEN_SCHEMA } from '../screens/screens.mjs';
import { SHOPIFY_SCHEMA, readLink } from '../shopify/links.mjs';
import { createPrivateDatabaseFile, openPrivateDatabase } from './private-database.mjs';
import { unconfiguredTransport } from './mail-transport.mjs';
import { CodedError } from '../errors.mjs';

const MAX_EMAIL_LENGTH = 254;
// 1: accounts + workspaces. 2: adds TV pairing challenges and display sessions.
// 3: adds workspace store links and pending Shopify OAuth attempts.
const SCHEMA_VERSION = 3;
const EMAIL_PATTERN = /^[^\s@<>"',;()]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Failure with a stable code for the operator CLI. */
export class AccountError extends CodedError {}

/** Better Auth lowercases emails, so the invited address is stored the same way. */
export function normalizeInviteEmail(rawEmail) {
  if (typeof rawEmail !== 'string') throw new AccountError('invalid_email');
  const email = rawEmail.trim().toLowerCase();
  const domain = email.split('@')[1] ?? '';
  const isValid =
    email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) && domain.includes('.');
  if (!isValid) throw new AccountError('invalid_email');
  return email;
}

async function applySchema(database, authOptions) {
  const { user_version: existingVersion } = database.prepare('PRAGMA user_version').get();
  if (existingVersion > SCHEMA_VERSION) {
    throw new Error('Database was written by a newer MetricTV version');
  }
  const migrations = await getMigrations(authOptions);
  await migrations.runMigrations();
  applyWorkspaceSchema(database);
  database.exec(SCREEN_SCHEMA);
  database.exec(SHOPIFY_SCHEMA);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Creates the private database file and its full schema. Fails if the file already exists. */
export async function initializeDatabase({ databasePath, secret, origin }) {
  createPrivateDatabaseFile(databasePath);
  const database = openPrivateDatabase(databasePath);
  try {
    const authOptions = createAuthOptions({
      database,
      secret,
      origin,
      mailTransport: unconfiguredTransport,
    });
    await applySchema(database, authOptions);
  } finally {
    database.close();
  }
}

/** Brings an existing database to the current schema after an upgrade. */
export async function migrateDatabase({ databasePath, secret, origin }) {
  const database = openPrivateDatabase(databasePath);
  try {
    await applySchema(
      database,
      createAuthOptions({ database, secret, origin, mailTransport: unconfiguredTransport }),
    );
  } finally {
    database.close();
  }
}

/** Opens an initialized database for serving; refuses an outdated schema. */
export function openInitializedDatabase(databasePath) {
  const database = openPrivateDatabase(databasePath);
  const { user_version: version } = database.prepare('PRAGMA user_version').get();
  if (version !== SCHEMA_VERSION) {
    database.close();
    throw new AccountError('schema_not_current');
  }
  return database;
}

/**
 * Registers one exact email as an owner and creates its workspace. No email is sent: the owner
 * later requests a code on the sign-in page. Re-inviting an existing owner changes nothing.
 */
export async function inviteOwner({ database, secret, origin, email: rawEmail }) {
  const email = normalizeInviteEmail(rawEmail);
  const auth = createAuth({
    database,
    secret,
    origin,
    mailTransport: unconfiguredTransport,
    allowUserCreation: true,
  });
  const { internalAdapter } = await auth.$context;
  const existing = await internalAdapter.findUserByEmail(email);
  let user = existing?.user;
  const alreadyInvited = Boolean(user);
  if (!user) {
    user = await internalAdapter.createUser({ email, name: '', emailVerified: false });
  }
  const workspace = ensureWorkspace(database, user.id);
  return { email, alreadyInvited, workspaceId: workspace.id };
}

/** Deletes every session of an exact email so existing browsers must sign in again. */
export async function revokeOwnerSessions({ database, secret, origin, email: rawEmail }) {
  const email = normalizeInviteEmail(rawEmail);
  const auth = createAuth({ database, secret, origin, mailTransport: unconfiguredTransport });
  const { internalAdapter } = await auth.$context;
  const found = await internalAdapter.findUserByEmail(email);
  if (!found) throw new AccountError('unknown_email');
  await internalAdapter.deleteUserSessions(found.user.id);
  return { email };
}

/**
 * Deletes an owner and everything that hangs off the account: sign-ins, workspace, settings, paired
 * screens, store link and pending Shopify attempts. The address is uninvited again.
 *
 * `removeGrant(workspaceId)` deletes the stored Shopify credentials. It runs first, so when it
 * fails the owner is untouched and the command can be run again. It is null when the Shopify
 * settings are not set, which is only acceptable for a workspace that never linked a store.
 */
export async function removeOwner({ database, secret, origin, email: rawEmail, removeGrant }) {
  const email = normalizeInviteEmail(rawEmail);
  const auth = createAuth({ database, secret, origin, mailTransport: unconfiguredTransport });
  const { internalAdapter } = await auth.$context;
  const found = await internalAdapter.findUserByEmail(email);
  if (!found) throw new AccountError('unknown_email');
  const workspace = database
    .prepare('SELECT id FROM workspace WHERE owner_user_id = ?')
    .get(found.user.id);
  const workspaceId = workspace?.id ?? null;
  const link = workspaceId === null ? null : readLink(database, workspaceId);
  if (link && !removeGrant) throw new AccountError('shopify_settings_missing');
  if (workspaceId !== null && removeGrant) {
    try {
      await removeGrant(workspaceId);
    } catch {
      throw new AccountError('grant_not_removed');
    }
  }
  await internalAdapter.deleteUser(found.user.id);
  return { email, workspaceId, shop: link?.shop ?? null };
}

/** Owner emails with workspace ids; no sessions, codes or tokens. */
export function listOwners(database) {
  return database
    .prepare(
      `SELECT "user".email AS email, workspace.id AS workspaceId
       FROM "user" LEFT JOIN workspace ON workspace.owner_user_id = "user".id
       ORDER BY "user".email`,
    )
    .all();
}
