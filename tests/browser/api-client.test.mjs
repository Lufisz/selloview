// The request helper both the owner page and the TV page use. A fake fetch stands in for the
// network: nothing leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendRequest } from '../../public/shared/api-client.js';

const REQUEST_TIMEOUT_MS = 12000;

function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return respond(options);
  };
  return { fetchImpl, calls };
}

test('a POST sends its JSON body and the CSRF token; a GET sends neither', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));

  await sendRequest({ fetchImpl, url: '/api/a', body: { x: 1 }, csrfToken: 'token-1' });
  await sendRequest({ fetchImpl, url: '/api/b', method: 'GET' });

  const [post, get] = calls.map((call) => call.options);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(post.headers['X-CSRF-Token'], 'token-1');
  assert.deepEqual(JSON.parse(post.body), { x: 1 });
  assert.equal(post.credentials, 'same-origin');
  assert.equal(get.body, undefined);
  assert.deepEqual(get.headers, {}, 'no content type, and no token header at all');
});

test('the server error code is passed on; an answer that is not JSON still reports its status', async () => {
  const refused = fakeFetch(() => ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'invalid_csrf' }),
  }));
  const notJson = fakeFetch(() => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new SyntaxError('not JSON');
    },
  }));

  assert.deepEqual(await sendRequest({ fetchImpl: refused.fetchImpl, url: '/api/a' }), {
    ok: false,
    status: 403,
    data: { error: 'invalid_csrf' },
    error: 'invalid_csrf',
  });
  assert.deepEqual(await sendRequest({ fetchImpl: notJson.fetchImpl, url: '/api/a' }), {
    ok: false,
    status: 502,
    data: null,
    error: 'request_failed',
  });
});

test('a request that cannot be made is reported as offline, not thrown', async () => {
  const fetchImpl = async () => {
    throw new TypeError('network down');
  };

  assert.deepEqual(await sendRequest({ fetchImpl, url: '/api/a', method: 'GET' }), {
    ok: false,
    status: 0,
    data: null,
    error: 'offline',
  });
});

test(
  'a request that never gets an answer is aborted after the time limit',
  { timeout: 2000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let aborted = false;
    const fetchImpl = (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });

    const pending = sendRequest({ fetchImpl, url: '/api/a', method: 'GET' });
    context.mock.timers.tick(REQUEST_TIMEOUT_MS);

    assert.equal((await pending).error, 'offline');
    assert.equal(aborted, true);
  },
);
