import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDemoSite } from '../../scripts/build-demo-site.mjs';
import { DEMO_PUBLIC_FILES } from '../../server/http/public-files.mjs';

test('the static sample site holds exactly the sample files plus its index page', async (context) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selloview-demo-site-'));
  context.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  await buildDemoSite({ outputDir });

  const built = fs
    .readdirSync(outputDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${path.relative(outputDir, path.join(entry.parentPath, entry.name))}`)
    .sort();
  const expected = [...DEMO_PUBLIC_FILES, '/index.html', '/.nojekyll'].sort();
  assert.deepEqual(built, expected, 'no owner, TV or server file reaches the static site');

  const index = fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8');
  assert.match(index, /http-equiv="Content-Security-Policy"/);
  assert.match(index, /connect-src 'none'/, 'the sample page still cannot make network requests');
  assert.doesNotMatch(index, /frame-ancestors/, 'meta policies cannot use frame-ancestors');
  assert.match(index, /src="\/demo\/demo\.js"/);
});
