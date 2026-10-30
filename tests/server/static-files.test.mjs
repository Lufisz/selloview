import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSecurityHeaders,
  findPublicFile,
  parseRequestPath,
  rawHeaderValues,
  singleHeaderValue,
} from '../../server/http/static-files.mjs';
import { ATTACK_PATHS, makePublicDirectory } from '../helpers/public-directory.mjs';

test('request path parsing rejects hostile encodings', () => {
  assert.deepEqual(parseRequestPath('/a/b.js?x=1#y'), { pathname: '/a/b.js' });
  assert.equal(parseRequestPath('//x').rejection, 'bad_request');
  assert.equal(parseRequestPath('x').rejection, 'bad_request');
  assert.equal(parseRequestPath(undefined).rejection, 'bad_request');
  assert.equal(parseRequestPath('/%E0%A4%A').rejection, 'bad_request');
  assert.equal(parseRequestPath('/%00').rejection, 'not_found');
  assert.equal(parseRequestPath('/a%5cb').rejection, 'not_found');
  assert.equal(parseRequestPath('/a\\b').rejection, 'not_found');
});

test('a header counts only when it was sent exactly once and is not comma-joined', () => {
  assert.deepEqual(rawHeaderValues(['A', '1', 'a', '2', 'B', '3'], 'a'), ['1', '2']);
  assert.equal(singleHeaderValue(['A', '1', 'a', '2'], 'a'), null);
  assert.equal(singleHeaderValue(['A', '1,2'], 'a'), null);
  assert.equal(singleHeaderValue(['B', '1'], 'a'), null);
  assert.equal(singleHeaderValue(['A', ' 1 '], 'a'), '1');
});

// The file a request target resolves to inside `publicDir`, or null.
async function lookup(publicDir, requestUrl, options = { indexFile: 'index.html' }) {
  const parsed = parseRequestPath(requestUrl);
  if (!parsed.pathname) return null;
  return findPublicFile(publicDir, parsed.pathname, options);
}

test('files outside the public directory, hidden, unlisted or oversized are never found', async (context) => {
  const publicDir = makePublicDirectory(context);
  for (const requestUrl of ATTACK_PATHS) {
    assert.equal(await lookup(publicDir, requestUrl), null, requestUrl);
  }
  assert.equal(await lookup(publicDir, '/missing.js'), null);
  assert.equal(await lookup(publicDir, '/ok/../model.js'), null);
});

test('ordinary files are found with their content type, including a symlink that stays inside', async (context) => {
  const publicDir = makePublicDirectory(context);
  for (const [requestUrl, contentType] of [
    ['/', 'text/html; charset=utf-8'],
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/mark.svg?x=1', 'image/svg+xml'],
    ['/alias.js', 'text/javascript; charset=utf-8'],
  ]) {
    const file = await lookup(publicDir, requestUrl);
    assert.ok(file, requestUrl);
    assert.equal(file.contentType, contentType, requestUrl);
  }
});

test('the index file and the blocked paths are chosen by the caller', async (context) => {
  const publicDir = makePublicDirectory(context);
  const ownerIndex = await lookup(publicDir, '/', { indexFile: 'owner.html' });
  assert.ok(ownerIndex.filePath.endsWith('owner.html'));

  const blockedPaths = new Set(['/app.js', '/index.html']);
  assert.equal(await lookup(publicDir, '/app.js', { indexFile: 'index.html', blockedPaths }), null);
  // The index file is blocked by name too, so "/" cannot be used to reach it.
  assert.equal(await lookup(publicDir, '/', { indexFile: 'index.html', blockedPaths }), null);
  // A symlink cannot be used to reach a blocked file under another name.
  const blockModel = new Set(['/model.js']);
  assert.equal(
    await lookup(publicDir, '/alias.js', { indexFile: 'index.html', blockedPaths: blockModel }),
    null,
  );
});

test('symlinks cannot disguise hidden files, forbidden types or blocked entry points', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'stillboard-alias-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDirectory = join(directory, 'public');
  await mkdir(publicDirectory);
  for (const name of ['.hidden-source.js', 'private.txt', 'blocked.html', 'styles.css']) {
    await writeFile(join(publicDirectory, name), 'Synthetic test fixture only.');
  }
  const options = { indexFile: 'index.html', blockedPaths: new Set(['/blocked.html']) };
  const hiddenTargets = [
    ['hidden-alias.js', '.hidden-source.js'],
    ['type-alias.js', 'private.txt'],
    ['entry-alias.js', 'blocked.html'],
  ];
  for (const [alias, target] of hiddenTargets) {
    await symlink(target, join(publicDirectory, alias));
    assert.equal(await findPublicFile(publicDirectory, '/' + alias, options), null);
  }
  await symlink('styles.css', join(publicDirectory, 'styles-alias.css'));
  const safeFile = await findPublicFile(publicDirectory, '/styles-alias.css', options);
  assert.equal(safeFile.contentType, 'text/css; charset=utf-8');
});

test('the demo and the app reuse security headers while retaining distinct network permissions', () => {
  const demo = createSecurityHeaders();
  const app = createSecurityHeaders({ allowApiRequests: true });
  assert.match(demo['Content-Security-Policy'], /connect-src 'none'/);
  assert.match(app['Content-Security-Policy'], /connect-src 'self'/);
  for (const headers of [demo, app]) {
    assert.match(headers['Content-Security-Policy'], /form-action 'none'/);
    assert.equal(headers['Referrer-Policy'], 'no-referrer');
    assert.equal(headers['Cache-Control'], 'no-store');
  }
});
