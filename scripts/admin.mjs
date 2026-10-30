// Operator commands for a MetricTV server. Local only; sends no email and opens no port.
//
//   npm run admin -- init                      create the private database (fails if it exists)
//   npm run admin -- migrate                   bring an existing database to the current schema
//   npm run admin -- invite owner@example.com  register one exact email as an owner
//   npm run admin -- revoke owner@example.com  sign that owner out everywhere
//   npm run admin -- owners                    list invited owners (emails and workspace ids)
//
// Configuration comes from the environment: METRICTV_DB_PATH, METRICTV_AUTH_SECRET, METRICTV_ORIGIN.
import { loadBetaConfig } from '../server/config.mjs';
import {
  initializeDatabase,
  inviteOwner,
  listOwners,
  migrateDatabase,
  openInitializedDatabase,
  revokeOwnerSessions,
} from '../server/accounts/accounts.mjs';

const USAGE = 'Usage: npm run admin -- init | migrate | invite <email> | revoke <email> | owners';

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
  const config = loadBetaConfig();
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
    console.log(`All sessions for ${result.email} were revoked.`);
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
