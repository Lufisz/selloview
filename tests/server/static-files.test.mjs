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
  sendPublicFile,
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

// Stands for a list that names every file, so the tests below show the file system rules hold on
// their own (containment, hidden files, types, size, symlinks), not because a list masked them.
const EVERY_PATH = { has: () => true };

// The file a request target resolves to inside `publicDir`, or null.
async function lookup(publicDir, requestUrl, allowedPaths = EVERY_PATH) {
  const parsed = parseRequestPath(requestUrl);
  if (!parsed.pathname) return null;
  return findPublicFile(publicDir, parsed.pathname, allowedPaths);
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
    ['/index.html', 'text/html; charset=utf-8'],
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

test('only listed files are found, and a symlink cannot reach a file that is not listed', async (context) => {
  const publicDir = makePublicDirectory(context);
  const listed = new Set(['/app.js', '/alias.js']);
  assert.ok(await lookup(publicDir, '/app.js', listed));
  assert.equal(await lookup(publicDir, '/data.js', listed), null, 'exists, but is not listed');
  // The alias is listed, but the file it points at (/model.js) is not.
  assert.equal(await lookup(publicDir, '/alias.js', listed), null);
  assert.ok(await lookup(publicDir, '/alias.js', new Set(['/alias.js', '/model.js'])));
});

test('symlinks cannot disguise hidden files, forbidden types or unlisted entry points', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'selloview-alias-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDirectory = join(directory, 'public');
  await mkdir(publicDirectory);
  for (const name of ['.hidden-source.js', 'private.txt', 'blocked.html', 'styles.css']) {
    await writeFile(join(publicDirectory, name), 'Synthetic test fixture only.');
  }
  // Everything is listed except /blocked.html, so the hidden file and the forbidden type are
  // refused by the file system rules and the entry point by the list.
  const listed = new Set([
    '/hidden-alias.js',
    '/.hidden-source.js',
    '/type-alias.js',
    '/private.txt',
    '/entry-alias.js',
    '/styles.css',
    '/styles-alias.css',
  ]);
  const hiddenTargets = [
    ['hidden-alias.js', '.hidden-source.js'],
    ['type-alias.js', 'private.txt'],
    ['entry-alias.js', 'blocked.html'],
  ];
  for (const [alias, target] of hiddenTargets) {
    await symlink(target, join(publicDirectory, alias));
    assert.equal(await findPublicFile(publicDirectory, '/' + alias, listed), null);
  }
  await symlink('styles.css', join(publicDirectory, 'styles-alias.css'));
  const safeFile = await findPublicFile(publicDirectory, '/styles-alias.css', listed);
  assert.equal(safeFile.contentType, 'text/css; charset=utf-8');
});

// The parts of a response that sendPublicFile touches.
function fakeResponse() {
  const response = {
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
    },
    end(body) {
      response.body = body;
    },
  };
  return response;
}

test('a found file is sent with its headers, without a body for HEAD, and a vanished file is reported', async (context) => {
  const publicDir = makePublicDirectory(context);
  const file = await lookup(publicDir, '/app.js');

  const get = fakeResponse();
  assert.equal(await sendPublicFile({ method: 'GET' }, get, { 'X-Test': 'yes' }, file), true);
  assert.equal(get.status, 200);
  assert.equal(get.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(get.headers['X-Test'], 'yes');
  assert.equal(get.headers['Content-Length'], get.body.length);
  assert.equal(get.body.toString(), '// app.js');

  const head = fakeResponse();
  assert.equal(await sendPublicFile({ method: 'HEAD' }, head, {}, file), true);
  assert.equal(head.headers['Content-Length'], get.body.length);
  assert.equal(head.body, undefined);

  await rm(file.filePath);
  const gone = fakeResponse();
  assert.equal(await sendPublicFile({ method: 'GET' }, gone, {}, file), false);
  assert.equal(gone.status, undefined, 'nothing is sent, so the caller can answer 404');
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
