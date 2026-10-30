import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDemoHandler, DEMO_HEADERS } from '../../server/demo.mjs';
import { ATTACK_PATHS, makePublicDirectory } from '../helpers/public-directory.mjs';

// Calls the handler with just the parts of a request it reads, and collects the response.
function callHandler(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve) => {
    const response = {
      headers: {},
      writeHead(status, headers) {
        response.status = status;
        for (const [name, value] of Object.entries(headers ?? {})) {
          response.headers[name.toLowerCase()] = value;
        }
      },
      end(body) {
        resolve({
          status: response.status,
          headers: response.headers,
          body: body === undefined ? '' : String(body),
        });
      },
    };
    handler({ method, url }, response);
  });
}

test('the demo server confines static files and does not serve the owner or TV pages', async (context) => {
  const handler = createDemoHandler({ publicDir: makePublicDirectory(context) });
  for (const url of ATTACK_PATHS) {
    const result = await callHandler(handler, { url });
    assert.ok([400, 404].includes(result.status), `${url} -> ${result.status}`);
    assert.doesNotMatch(result.body, /OUTSIDE|private/);
  }
  for (const url of ['/owner/owner.html', '/owner/owner.js', '/tv/tv.html']) {
    assert.equal((await callHandler(handler, { url })).status, 404, url);
  }
  for (const url of [
    '/',
    '/demo/demo.html',
    '/demo/demo.js',
    '/shared/styles.css',
    '/shared/format.js',
    '/mark.svg?x=1',
  ]) {
    assert.equal((await callHandler(handler, { url })).status, 200, url);
  }
  // An alias is a new public name, so it has to be listed too, and so does the file it points at.
  assert.equal((await callHandler(handler, { url: '/alias.js' })).status, 404);
});

test('the demo server serves only listed files, even ones that sit in the public directory', async (context) => {
  const publicDir = makePublicDirectory(context);
  fs.writeFileSync(path.join(publicDir, 'demo', 'unlisted.js'), '// not on the list');
  fs.writeFileSync(path.join(publicDir, 'shared', 'unlisted.js'), '// not on the list');
  const handler = createDemoHandler({ publicDir });
  for (const url of ['/demo/unlisted.js', '/shared/unlisted.js']) {
    assert.equal((await callHandler(handler, { url })).status, 404, url);
  }
  assert.equal((await callHandler(handler, { url: '/demo/demo.js' })).status, 200);
});

test('the demo server answers HEAD without a body and refuses other methods, with a strict CSP', async (context) => {
  const handler = createDemoHandler({ publicDir: makePublicDirectory(context) });
  const head = await callHandler(handler, { method: 'HEAD', url: '/' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.match(head.headers['content-security-policy'], /connect-src 'none'/);
  assert.equal(DEMO_HEADERS['Cache-Control'], 'no-store');

  const post = await callHandler(handler, { method: 'POST', url: '/' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');

  assert.equal((await callHandler(handler, { url: '//x' })).status, 400);
});
