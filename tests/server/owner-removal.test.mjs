// Removing an owner: deleting an invited address together with everything it owned, so the address
// is uninvited again. Tested through the function and through scripts/admin.mjs as a real process.
// Accounts, database and grant files are real; only Shopify's answers are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inviteOwner,
  listOwners,
  openInitializedDatabase,
  removeOwner,
} from '../../server/accounts/accounts.mjs';
import { loadShopifyConfig } from '../../server/shopify/config.mjs';
import { createWorkspaceTokenStore } from '../../server/shopify/token-store.mjs';
import { runCli } from '../helpers/admin-cli.mjs';
import { createAppEnvironment, curlAvailable } from '../helpers/app-server.mjs';
import {
  ALICE,
  BOB,
  SYNTHETIC_STORE,
  connectOwner,
  createScenario,
  pairTv,
  shopifyEnvironment,
} from '../helpers/shopify-scenario.mjs';

const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

function idsOf(database, email) {
  return database
    .prepare(
      `SELECT "user".id AS userId, workspace.id AS workspaceId
       FROM "user" JOIN workspace ON workspace.owner_user_id = "user".id
       WHERE "user".email = ?`,
    )
    .get(email);
}

/**
 * Every row, in any table, that still points at the user or the workspace. The tables come from the
 * schema, so one added later is checked too.
 */
function rowsPointingAt(database, { userId, workspaceId }) {
  const idByTable = new Map([
    ['user', userId],
    ['workspace', workspaceId],
  ]);
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const found = [];
  for (const { name: table } of tables) {
    // The user and workspace tables are matched by their own id, every table by what it references.
    const columns = [{ column: 'id', id: idByTable.get(table) }];
    for (const key of database.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
      columns.push({ column: key.from, id: idByTable.get(key.table) });
    }
    for (const { column, id } of columns) {
      if (id === undefined) continue;
      const { count } = database
        .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE "${column}" = ?`)
        .get(id);
      if (count > 0) found.push({ table, column, count });
    }
  }
  return found;
}

function ownerEmails(database) {
  return listOwners(database).map((owner) => owner.email);
}

/** Deletes stored credentials the way the operator command does once the Shopify settings are set. */
function grantRemover(scenario) {
  const shopifyConfig = loadShopifyConfig(
    shopifyEnvironment({ tokenDirectory: scenario.tokenDirectory, key: scenario.key }),
  );
  return (workspaceId) => createWorkspaceTokenStore(shopifyConfig, workspaceId).remove();
}

function removeFrom(scenario, email, removeGrant) {
  return removeOwner({
    database: scenario.handle.database,
    secret: scenario.environment.secret,
    origin: scenario.environment.origin,
    email,
    removeGrant,
  });
}

function cliEnvironment(environment) {
  return {
    METRICTV_DB_PATH: environment.databasePath,
    METRICTV_AUTH_SECRET: environment.secret,
    METRICTV_ORIGIN: environment.origin,
  };
}

test(
  'removing an owner deletes the account, workspace, screens and stored credentials, and no one else',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { database, mailTransport } = scenario.handle;
    const alice = await scenario.signIn(ALICE);
    const bob = await scenario.signIn(BOB);
    await connectOwner(alice.browser);
    const aliceScreen = await pairTv(scenario.handle, alice.browser);
    const bobScreen = await pairTv(scenario.handle, bob.browser);
    const aliceIds = idsOf(database, ALICE);
    const bobIds = idsOf(database, BOB);
    const aliceRowsBefore = rowsPointingAt(database, aliceIds);
    const bobRowsBefore = rowsPointingAt(database, bobIds);
    for (const table of ['session', 'workspace', 'workspace_settings', 'display_session']) {
      assert.ok(
        aliceRowsBefore.some((row) => row.table === table),
        `${table} has rows to remove`,
      );
    }
    assert.ok(aliceRowsBefore.some((row) => row.table === 'workspace_store'));
    assert.deepEqual(await scenario.grantFiles(), [`${aliceIds.workspaceId}.grant.json`]);

    const result = await removeFrom(scenario, ALICE, grantRemover(scenario));

    assert.deepEqual(result, {
      email: ALICE,
      workspaceId: aliceIds.workspaceId,
      shop: SYNTHETIC_STORE,
    });
    assert.deepEqual(rowsPointingAt(database, aliceIds), []);
    assert.deepEqual(await scenario.grantFiles(), [], 'the stored Shopify credentials are gone');
    assert.equal((await alice.browser.loadSession()).status, 401, 'the old cookie stops working');
    assert.equal((await aliceScreen.loadDisplay()).status, 401, 'a paired screen is signed out');
    assert.equal((await bob.browser.loadSession()).status, 200);
    assert.equal((await bobScreen.loadDisplay()).status, 200);
    assert.deepEqual(
      rowsPointingAt(database, bobIds),
      bobRowsBefore,
      'the other owner is untouched',
    );

    const codesBefore = mailTransport.messages.length;
    assert.equal((await alice.browser.requestCode(ALICE)).status, 200, 'same reply as any address');
    assert.equal(mailTransport.messages.length, codesBefore, 'no code goes to a removed address');
  },
);

test('inviting a removed address again starts from nothing', async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE, BOB] });
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  const credentials = { database, secret: environment.secret, origin: environment.origin };
  const oldWorkspaceId = idsOf(database, ALICE).workspaceId;

  await removeOwner({ ...credentials, email: ALICE, removeGrant: null });
  assert.deepEqual(ownerEmails(database), [BOB]);

  const again = await inviteOwner({ ...credentials, email: ALICE });
  assert.equal(again.alreadyInvited, false);
  assert.notEqual(again.workspaceId, oldWorkspaceId);
  assert.deepEqual(ownerEmails(database), [ALICE, BOB]);
});

test(
  'credentials that cannot be deleted stop the removal before anything else is touched',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { database } = scenario.handle;
    const alice = await scenario.signIn(ALICE);
    await connectOwner(alice.browser);
    const aliceIds = idsOf(database, ALICE);
    const rowsBefore = rowsPointingAt(database, aliceIds);
    const failingRemover = async () => {
      throw new Error('synthetic disk failure');
    };

    await assert.rejects(removeFrom(scenario, ALICE, failingRemover), {
      code: 'grant_not_removed',
    });

    assert.deepEqual(
      rowsPointingAt(database, aliceIds),
      rowsBefore,
      'account and workspace remain',
    );
    assert.equal((await alice.browser.loadSession()).status, 200, 'the owner is still signed in');
    assert.equal((await scenario.grantFiles()).length, 1);

    await removeFrom(scenario, ALICE, grantRemover(scenario));
    assert.deepEqual(rowsPointingAt(database, aliceIds), [], 'a second try finishes the job');
    assert.deepEqual(await scenario.grantFiles(), []);
  },
);

test(
  'an owner with a connected store is not removed without the Shopify settings that find its credentials',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const { database } = scenario.handle;
    const alice = await scenario.signIn(ALICE);
    await connectOwner(alice.browser);
    const aliceIds = idsOf(database, ALICE);
    const rowsBefore = rowsPointingAt(database, aliceIds);

    await assert.rejects(removeFrom(scenario, ALICE, null), { code: 'shopify_settings_missing' });

    assert.deepEqual(rowsPointingAt(database, aliceIds), rowsBefore);
    assert.equal((await alice.browser.loadSession()).status, 200);
    assert.equal((await scenario.grantFiles()).length, 1);

    await removeFrom(scenario, BOB, null);
    assert.deepEqual(
      ownerEmails(database),
      [ALICE],
      'an owner who never linked a store needs none',
    );
  },
);

test('removing an address that is not an invited owner changes nothing', async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE] });
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  const credentials = {
    database,
    secret: environment.secret,
    origin: environment.origin,
    removeGrant: null,
  };

  await assert.rejects(removeOwner({ ...credentials, email: BOB }), { code: 'unknown_email' });
  await assert.rejects(removeOwner({ ...credentials, email: 'not-an-email' }), {
    code: 'invalid_email',
  });
  await assert.rejects(removeOwner({ ...credentials, email: undefined }), {
    code: 'invalid_email',
  });
  assert.deepEqual(ownerEmails(database), [ALICE]);
});

test('operator CLI removes an owner, lists the rest and lets the address be invited again', async (t) => {
  const environment = await createAppEnvironment(t, { invites: [ALICE, BOB] });
  const env = cliEnvironment(environment);

  const removal = await runCli(['remove', 'Alice@Example.test'], env);
  assert.equal(removal.code, 0, removal.stderr);
  assert.match(removal.stdout, /alice@example\.test was removed/);

  const owners = await runCli(['owners'], env);
  assert.equal(owners.stdout.includes(ALICE), false);
  assert.match(owners.stdout, /bob@example\.test/);
  assert.match(owners.stdout, /1 owner\(s\)/);

  const again = await runCli(['remove', ALICE], env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /unknown_email/);
  const noAddress = await runCli(['remove'], env);
  assert.equal(noAddress.code, 1);
  assert.match(noAddress.stderr, /invalid_email/);

  const invite = await runCli(['invite', ALICE], env);
  assert.match(invite.stdout, /is now invited/, 'a removed address is not "already invited"');
  for (const output of [removal, owners, again, noAddress, invite]) {
    assert.equal((output.stdout + output.stderr).includes(environment.secret), false);
  }
});

test(
  'operator CLI removal deletes the stored Shopify credentials, and refuses to leave them behind',
  http,
  async (t) => {
    const scenario = await createScenario(t);
    const alice = await scenario.signIn(ALICE);
    await connectOwner(alice.browser);
    const workspaceId = scenario.workspaceId(ALICE);
    // The documented order: the service is stopped while an owner is removed.
    await scenario.handle.close();
    const withoutShopify = cliEnvironment(scenario.environment);
    const withShopify = {
      ...withoutShopify,
      ...shopifyEnvironment({ tokenDirectory: scenario.tokenDirectory, key: scenario.key }),
    };

    const refused = await runCli(['remove', ALICE], withoutShopify);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /shopify_settings_missing/);
    assert.deepEqual(await scenario.grantFiles(), [`${workspaceId}.grant.json`], 'nothing removed');
    assert.match((await runCli(['owners'], withoutShopify)).stdout, /2 owner\(s\)/);

    const removal = await runCli(['remove', ALICE], withShopify);
    assert.equal(removal.code, 0, removal.stderr);
    assert.match(removal.stdout, /alice@example\.test was removed/);
    assert.match(removal.stdout, /stored Shopify credentials were deleted/);
    assert.ok(removal.stdout.includes(`stays installed in ${SYNTHETIC_STORE}`));
    assert.deepEqual(await scenario.grantFiles(), []);
    assert.match((await runCli(['owners'], withShopify)).stdout, /1 owner\(s\)/);
    for (const output of [refused, removal]) {
      assert.equal((output.stdout + output.stderr).includes(scenario.key), false);
    }
  },
);
