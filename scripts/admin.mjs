// Operator commands for a MetricTV server. Local only; sends no email and opens no port.
//
//   npm run admin -- init                      create the private database (fails if it exists)
//   npm run admin -- migrate                   bring an existing database to the current schema
//   npm run admin -- invite owner@example.com  register one exact email as an owner
//   npm run admin -- revoke owner@example.com  sign that owner out everywhere; the address stays invited
//   npm run admin -- remove owner@example.com  delete that owner with the workspace, screens and
//                                              stored Shopify credentials; stop the service first
//   npm run admin -- owners                    list invited owners (emails and workspace ids)
//
// Configuration comes from the environment: METRICTV_DB_PATH, METRICTV_AUTH_SECRET, METRICTV_ORIGIN.
// `remove` also needs the server's METRICTV_SHOPIFY_* settings when the owner linked a store.
import { loadServerConfig } from '../server/config.mjs';
import {
  initializeDatabase,
  inviteOwner,
  listOwners,
  migrateDatabase,
  openInitializedDatabase,
  removeOwner,
  revokeOwnerSessions,
} from '../server/accounts/accounts.mjs';
import { loadShopifyConfig } from '../server/shopify/config.mjs';
import { createWorkspaceTokenStore } from '../server/shopify/token-store.mjs';

const USAGE =
  'Usage: npm run admin -- init | migrate | invite <email> | revoke <email> | remove <email> | owners';

async function runWithDatabase(config, action) {
  const database = openInitializedDatabase(config.databasePath);
  try {
    return await action(database);
  } finally {
    database.close();
  }
}

async function main(argv) {
  const [command, emailArgument] = argv;
  const config = loadServerConfig();
  const credentials = { secret: config.secret, origin: config.origin };

  if (command === 'init') {
    await initializeDatabase({ databasePath: config.databasePath, ...credentials });
    console.log('Private database created. Nothing has been invited yet.');
  } else if (command === 'migrate') {
    await migrateDatabase({ databasePath: config.databasePath, ...credentials });
    console.log('Database schema is current.');
  } else if (command === 'invite') {
    const result = await runWithDatabase(config, (database) =>
      inviteOwner({ database, ...credentials, email: emailArgument }),
    );
    const note = result.alreadyInvited ? 'was already invited' : 'is now invited';
    console.log(
      `${result.email} ${note}. No email was sent; the owner requests a code on the sign-in page.`,
    );
  } else if (command === 'revoke') {
    const result = await runWithDatabase(config, (database) =>
      revokeOwnerSessions({ database, ...credentials, email: emailArgument }),
    );
    console.log(
      `All sessions for ${result.email} were revoked. The address is still invited; ` +
        'use "remove" to delete the owner.',
    );
  } else if (command === 'remove') {
    const shopifyConfig = loadShopifyConfig(process.env);
    const removeGrant =
      shopifyConfig.status === 'ready'
        ? (workspaceId) => createWorkspaceTokenStore(shopifyConfig, workspaceId).remove()
        : null;
    const result = await runWithDatabase(config, (database) =>
      removeOwner({ database, ...credentials, email: emailArgument, removeGrant }),
    );
    console.log(`${result.email} was removed, with the workspace, its screens and every sign-in.`);
    if (result.shop) {
      console.log(
        'The stored Shopify credentials were deleted. The app stays installed in ' +
          `${result.shop} until someone uninstalls it in the Shopify admin.`,
      );
    }
  } else if (command === 'owners') {
    const owners = await runWithDatabase(config, async (database) => listOwners(database));
    for (const owner of owners) console.log(`${owner.email}\t${owner.workspaceId ?? '-'}`);
    console.log(`${owners.length} owner(s).`);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`admin failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
