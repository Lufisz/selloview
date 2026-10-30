// The page-code fingerprint a paired TV uses to reload itself after a deployment, and the
// browser-side decision of when to reload. Synthetic files in a temporary directory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppVersion } from '../server/screens/app-version.mjs';
import { isNewAppVersion } from '../public/tv-client.js';

const THIRTY_ONE_SECONDS_MS = 31 * 1000;

async function makePublicDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'metrictv-app-version-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'tv.js'), 'console.log("one");\n');
  await fs.writeFile(path.join(directory, 'beta.css'), 'body { color: black; }\n');
  return directory;
}

test('the version changes when a served file changes, and is stable otherwise', async (t) => {
  const directory = await makePublicDirectory(t);
  const appVersion = createAppVersion(directory, ['/tv.js', '/beta.css']);

  const first = appVersion(0);
  assert.match(first, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(appVersion(THIRTY_ONE_SECONDS_MS), first, 'unchanged files keep the version');

  await fs.writeFile(path.join(directory, 'tv.js'), 'console.log("a new version");\n');
  assert.equal(appVersion(THIRTY_ONE_SECONDS_MS + 1000), first, 'rechecked at most every 30 s');
  const second = appVersion(2 * THIRTY_ONE_SECONDS_MS);
  assert.notEqual(second, first, 'a deployment produces a new version');
});

test('a missing file gives a stable version instead of an error', async (t) => {
  const directory = await makePublicDirectory(t);
  const appVersion = createAppVersion(directory, ['/tv.js', '/not-there.js']);
  assert.equal(appVersion(0), appVersion(THIRTY_ONE_SECONDS_MS));
});

test('the TV reloads only when the server reports a different, valid version', () => {
  assert.equal(isNewAppVersion(null, { appVersion: 'abc' }), false, 'first sight just records');
  assert.equal(isNewAppVersion('abc', { appVersion: 'abc' }), false);
  assert.equal(isNewAppVersion('abc', { appVersion: 'def' }), true);
  for (const reported of [undefined, null, '', 42, {}]) {
    assert.equal(isNewAppVersion('abc', { appVersion: reported }), false, String(reported));
  }
  assert.equal(isNewAppVersion('abc', null), false);
});
