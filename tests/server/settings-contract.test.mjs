// The reporting periods and themes are listed in more than one place: the browser (the table in
// public/shared/periods.js and the settings form), the snapshot builder (server/metrics.mjs) and
// the settings the server accepts (server/accounts/workspaces.mjs). Changing one list and not the
// others would break the board quietly, so these tests make it loud.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  applyWorkspaceSchema,
  updateWorkspaceSettings,
} from '../../server/accounts/workspaces.mjs';
import { renderOwner } from '../../public/owner/owner-view.js';
import { PERIODS } from '../../public/shared/periods.js';
import { syntheticSnapshot } from '../helpers/synthetic-snapshot.mjs';

const OWNER_ID = 'owner-1';

function createWorkspaceDatabase() {
  const database = new DatabaseSync(':memory:');
  database.prepare('CREATE TABLE "user" (id TEXT PRIMARY KEY NOT NULL)').run();
  database.prepare('INSERT INTO "user" (id) VALUES (?)').run(OWNER_ID);
  applyWorkspaceSchema(database);
  return database;
}

// The options of one <select> in the owner page's settings form.
function offeredValues(selectId) {
  const html = renderOwner({
    session: {
      owner: { email: 'owner@example.test' },
      workspace: { name: 'Synthetic', revision: 0, settings: { period: 'week', theme: 'light' } },
      csrfToken: 'synthetic-token',
    },
    message: '',
    tone: 'info',
    screens: { status: 'ready', items: [] },
    confirmRevokeId: '',
    screenMessage: '',
    screenTone: 'info',
  });
  const select = html.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
  return [...select[1].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
}

function saveSettings(database, patch, revision) {
  return updateWorkspaceSettings(database, OWNER_ID, { patch, expectedRevision: revision });
}

test('the snapshot has a period and a chart for exactly the periods the browser lists', () => {
  const snapshot = syntheticSnapshot();
  const known = Object.keys(PERIODS).sort();

  assert.deepEqual(Object.keys(snapshot.periods).sort(), known);
  assert.deepEqual(Object.keys(snapshot.charts).sort(), known);
  for (const key of known) {
    const { current, previous } = snapshot.charts[key];
    assert.ok(current.length > 0, `${key} has points`);
    assert.ok(current.length <= PERIODS[key].maxChartPoints, `${key} current series`);
    assert.ok(previous.length <= PERIODS[key].maxChartPoints, `${key} previous series`);
  }
});

test('the server accepts every period and theme the settings form offers', () => {
  const periods = offeredValues('owner-period');
  const themes = offeredValues('owner-theme');
  assert.deepEqual(periods, Object.keys(PERIODS), 'the form offers every period');
  assert.deepEqual(themes, ['light', 'dark']);

  const database = createWorkspaceDatabase();
  const patches = [...periods.map((period) => ({ period })), ...themes.map((theme) => ({ theme }))];
  let revision = 0;
  for (const patch of patches) {
    const result = saveSettings(database, patch, revision);
    assert.equal(result.status, 'ok', JSON.stringify(patch));
    revision = result.workspace.revision;
  }
});

test('the server still refuses a period or theme nobody listed', () => {
  const database = createWorkspaceDatabase();

  assert.equal(saveSettings(database, { period: 'forever' }, 0).status, 'invalid');
  assert.equal(saveSettings(database, { theme: 'neon' }, 0).status, 'invalid');
});
