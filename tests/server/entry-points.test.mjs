// The commands that operators, documentation and the example systemd unit rely on must keep
// pointing at files that exist, and must not carry the old "beta" names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

async function readProjectFile(...segments) {
  return fs.readFile(path.join(PROJECT_ROOT, ...segments), 'utf8');
}

async function exists(relativePath) {
  try {
    await fs.stat(path.join(PROJECT_ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

test('npm start runs the sample, start:server the app and admin the operator commands', async () => {
  const { scripts } = JSON.parse(await readProjectFile('package.json'));
  const expectedEntryPoints = {
    start: 'server/demo.mjs',
    'start:server': 'server/main.mjs',
    admin: 'scripts/admin.mjs',
  };
  for (const [scriptName, entryPoint] of Object.entries(expectedEntryPoints)) {
    assert.equal(scripts[scriptName], `node ${entryPoint}`, scriptName);
    assert.equal(await exists(entryPoint), true, `${entryPoint} exists`);
  }
  const betaScripts = Object.keys(scripts).filter((name) => /beta/i.test(name));
  assert.deepEqual(betaScripts, [], 'no script keeps the old beta name');
});

test('the example systemd unit starts the app entry point', async () => {
  const unit = await readProjectFile('deploy', 'metrictv.service');
  const execStart = unit.match(/^ExecStart=\S*node (\S+)\s*$/m);
  assert.ok(execStart, 'the unit has an ExecStart that runs node');
  assert.equal(execStart[1], 'server/main.mjs');
  assert.equal(await exists(execStart[1]), true);
});
