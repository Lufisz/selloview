import test from 'node:test';
import assert from 'node:assert/strict';
import { openInitializedDatabase } from '../../server/accounts/accounts.mjs';
import { inTransaction } from '../../server/accounts/private-database.mjs';
import { createAppEnvironment } from '../helpers/app-server.mjs';

test('inTransaction keeps everything when the work succeeds and nothing when it throws', async (t) => {
  const environment = await createAppEnvironment(t);
  const database = openInitializedDatabase(environment.databasePath);
  t.after(() => database.close());
  database.prepare('CREATE TABLE sample (id INTEGER)').run();
  const insert = (id) => database.prepare('INSERT INTO sample (id) VALUES (?)').run(id);

  const result = inTransaction(database, () => {
    insert(1);
    return 'kept';
  });
  assert.equal(result, 'kept');

  assert.throws(
    () =>
      inTransaction(database, () => {
        insert(2);
        throw new Error('synthetic failure');
      }),
    /synthetic failure/,
  );

  const ids = database
    .prepare('SELECT id FROM sample ORDER BY id')
    .all()
    .map((row) => row.id);
  assert.deepEqual(ids, [1]);
  // The failed transaction was rolled back, so a new one can start.
  inTransaction(database, () => insert(3));
  assert.equal(database.prepare('SELECT COUNT(*) AS total FROM sample').get().total, 2);
});
