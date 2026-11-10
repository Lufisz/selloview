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

test('the sample page carries a heading and an HTTPS link before any script runs', () => {
  const page = fs.readFileSync(new URL('../../public/demo/demo.html', import.meta.url), 'utf8');
  const appContent = page.slice(page.indexOf('<div id="app">'), page.indexOf('<dialog'));
  assert.match(appContent, /<h1>/);
  assert.match(appContent, /href="https:\/\//);
});

test('with a site origin the static sample site gains share tags, a sitemap and robots.txt', async (context) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selloview-demo-site-'));
  context.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  await buildDemoSite({ outputDir, siteOrigin: 'https://sample.example' });

  const index = fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8');
  assert.match(index, /<link rel="canonical" href="https:\/\/sample\.example\/" \/>/);
  assert.match(index, /property="og:url" content="https:\/\/sample\.example\/"/);
  assert.match(index, /property="og:image" content="https:\/\/sample\.example\/social-card\.png"/);
  assert.match(index, /name="twitter:card" content="summary_large_image"/);
  assert.ok(fs.existsSync(path.join(outputDir, 'social-card.png')));

  const sitemap = fs.readFileSync(path.join(outputDir, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/sample\.example\/<\/loc>/);
  const robots = fs.readFileSync(path.join(outputDir, 'robots.txt'), 'utf8');
  assert.match(robots, /Sitemap: https:\/\/sample\.example\/sitemap\.xml/);
});

test('a site origin that is not a plain HTTPS origin stops the build', async (context) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selloview-demo-site-'));
  context.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  for (const siteOrigin of ['http://sample.example', 'not a url', 'https://sample.example/path']) {
    await assert.rejects(buildDemoSite({ outputDir, siteOrigin }), /site origin/i);
  }
});
