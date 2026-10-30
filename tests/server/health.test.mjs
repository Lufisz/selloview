// The health route is for uptime monitors and container probes. It says only "ok" or
// "unavailable", needs no session, and sits behind the same Host rule as every other route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAppEnvironment,
  curlAvailable,
  httpRequest,
  startAppServer,
} from '../helpers/app-server.mjs';

const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

test(
  '/healthz answers ok while the database works, with no cookie and no details',
  http,
  async (t) => {
    const environment = await createAppEnvironment(t);
    const handle = await startAppServer(t, environment);

    const result = await httpRequest({ origin: handle.origin, pathname: '/healthz' });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { status: 'ok' });
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.headers.getSetCookie(), []);
  },
);

test('/healthz answers unavailable when the database cannot be read', http, async (t) => {
  const environment = await createAppEnvironment(t);
  const handle = await startAppServer(t, environment);
  t.mock.method(handle.database, 'prepare', () => {
    throw new Error('synthetic disk failure');
  });

  const result = await httpRequest({ origin: handle.origin, pathname: '/healthz' });

  assert.equal(result.status, 503);
  assert.deepEqual(result.json, { status: 'unavailable' });
});

test('/healthz keeps the Host rule and does not accept writes', http, async (t) => {
  const environment = await createAppEnvironment(t);
  const handle = await startAppServer(t, environment);

  const wrongHost = await httpRequest({
    origin: handle.origin,
    pathname: '/healthz',
    headerLines: ['Host: evil.example'],
  });
  assert.equal(wrongHost.status, 400);

  const post = await httpRequest({ origin: handle.origin, pathname: '/healthz', method: 'POST' });
  assert.equal(post.status, 405);
});
