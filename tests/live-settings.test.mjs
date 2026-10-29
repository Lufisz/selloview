// Server-persisted dashboard settings: store, routes (real HTTP) and project wiring.
// All values are synthetic. Temporary files live under the OS temp directory (TMPDIR).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  createSettingsService,
  createSettingsStore,
  loadSettingsConfig,
  SETTINGS_FORMAT,
  SettingsError,
} from '../server/live-settings.mjs';
import {
  createCache,
  createConfiguredSettings,
  createHandler,
  createLiveServer,
  loadConfig,
} from '../server/live-server.mjs';

const STORE = 'test-shop.myshopify.com';
const OTHER_STORE = 'other-shop.myshopify.com';
const ENV = {
  SHOPIFY_STORE: STORE,
  LIVE_ALLOWED_USERS: 'alice@example.com, bob@example.com',
  LIVE_ORIGIN: 'https://box.tail1234.ts.net',
};
const HOST = 'box.tail1234.ts.net';
const ORIGIN = `https://${HOST}`;

async function makePrivateDirectory(t) {
  const base = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'metrictv-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// Tokens of the most recently started service, so tests can mint a valid token for a
// principal even when reading state is impossible (for example a wrong-store file).
let lastService;
let activeTransport = 'in-process';

function buildHandler({ filePath, store = STORE, enabled = true }) {
  const config = loadConfig(ENV);
  const cache = createCache({ fetchSnapshot: async () => ({ source: 'shopify' }) });
  const settings = enabled
    ? createSettingsService({ store: createSettingsStore({ filePath, store }), origin: ORIGIN })
    : undefined;
  lastService = settings;
  return { config, cache, settings };
}

function parseResponse(status, headers, text) {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies are asserted on through `text`.
  }
  return { status, headers, text, json };
}

// Drives the real request handler with a mock socket/request, for sandboxes without loopback TCP.
function requestInProcess(handler, { method, path: requestPath, headers, body }) {
  const rawHeaders = [];
  const lowerCased = {};
  const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
  if (body !== undefined) entries.push(['content-length', String(Buffer.byteLength(body))]);
  for (const [name, value] of entries) {
    const values = Array.isArray(value) ? value : [value];
    for (const single of values) rawHeaders.push(name, String(single));
    lowerCased[name.toLowerCase()] = values.join(', ');
  }
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  Object.assign(request, {
    method,
    url: requestPath,
    headers: lowerCased,
    rawHeaders,
    socket: { remoteAddress: '127.0.0.1' },
  });
  return new Promise((resolve) => {
    const response = {
      headers: {},
      headersSent: false,
      writeHead(status, outgoing) {
        response.status = status;
        response.headersSent = true;
        for (const [name, value] of Object.entries(outgoing)) {
          response.headers[name.toLowerCase()] = String(value);
        }
      },
      end(text) {
        resolve(
          parseResponse(response.status, response.headers, text === undefined ? '' : String(text)),
        );
      },
      destroy() {},
    };
    handler(request, response);
  });
}

function requestOverHttp(port, { method, path: requestPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve(
            parseResponse(
              response.statusCode,
              response.headers,
              Buffer.concat(chunks).toString('utf8'),
            ),
          ),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

let loopbackProbe;
function loopbackWorks() {
  loopbackProbe ??= new Promise((resolve) => {
    const probe = http.createServer((request, response) => response.end('ok'));
    const finish = (works) => {
      probe.closeAllConnections();
      probe.close();
      resolve(works);
    };
    probe.listen(0, '127.0.0.1', () => {
      const request = http.get(
        { host: '127.0.0.1', port: probe.address().port, timeout: 1500 },
        (response) => {
          response.resume();
          finish(true);
        },
      );
      request.on('error', () => finish(false));
      request.on('timeout', () => {
        request.destroy();
        finish(false);
      });
    });
  });
  return loopbackProbe;
}

/** Runs every scenario in-process and, when loopback TCP works, over a real listener. */
function httpTest(name, scenario) {
  for (const transport of ['in-process', 'loopback http']) {
    test(`${name} [${transport}]`, async (t) => {
      if (transport === 'loopback http' && !(await loopbackWorks())) {
        return t.skip('loopback TCP blocked in this environment');
      }
      activeTransport = transport;
      return scenario(t);
    });
  }
}

// Returns a target for send(). Real mode listens on an ephemeral loopback port.
async function startServer(t, options) {
  const parts = buildHandler(options);
  if (activeTransport === 'in-process') {
    return { handler: createHandler({ ...parts }) };
  }
  const server = createLiveServer(parts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port };
}

function send(target, { method = 'GET', path: requestPath = '/api/settings', headers = {}, body }) {
  const merged = { host: HOST, 'tailscale-user-login': 'alice@example.com', ...headers };
  const options = { method, path: requestPath, headers: merged, body };
  return target.handler
    ? requestInProcess(target.handler, options)
    : requestOverHttp(target.port, options);
}

async function readState(port, headers) {
  const response = await send(port, { headers });
  assert.equal(response.status, 200);
  return response.json;
}

function post(port, state, patch, { headers = {}, revision = state.revision, rawBody } = {}) {
  const body = rawBody ?? JSON.stringify({ revision, settings: patch });
  return send(port, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-csrf-token': state.csrfToken,
      ...headers,
    },
    body,
  });
}

// ---- store ----

test('store starts at revision 0 with defaults and persists across instances', async (t) => {
  const directory = await makePrivateDirectory(t);
  const filePath = path.join(directory, 'settings.json');
  const first = createSettingsStore({ filePath, store: STORE });
  assert.deepEqual(await first.load(), {
    revision: 0,
    settings: { period: 'week', theme: 'light' },
  });

  const saved = await first.update(0, { theme: 'dark' });
  assert.deepEqual(saved, { revision: 1, settings: { period: 'week', theme: 'dark' } });

  const second = createSettingsStore({ filePath, store: STORE });
  assert.deepEqual(await second.load(), saved);
  await second.update(1, { period: 'days60' });
  assert.deepEqual(await first.load(), {
    revision: 2,
    settings: { period: 'days60', theme: 'dark' },
  });

  const stats = await fs.stat(filePath);
  assert.equal(stats.mode & 0o777, 0o600);
  const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), [
    'format',
    'revision',
    'settings',
    'store',
    'version',
  ]);
  assert.equal(stored.format, SETTINGS_FORMAT);
  assert.equal(stored.store, STORE);
  const leftovers = (await fs.readdir(directory)).filter((name) => name !== 'settings.json');
  assert.deepEqual(leftovers, []);
});

test('store: first save persists even when equal to defaults; no-op later saves keep revision', async (t) => {
  const directory = await makePrivateDirectory(t);
  const store = createSettingsStore({ filePath: path.join(directory, 's.json'), store: STORE });
  assert.equal((await store.update(0, { theme: 'light' })).revision, 1);
  assert.equal((await store.update(1, { theme: 'light' })).revision, 1);
});

test('store rejects stale revisions and serializes concurrent writers', async (t) => {
  const directory = await makePrivateDirectory(t);
  const store = createSettingsStore({ filePath: path.join(directory, 's.json'), store: STORE });
  await store.update(0, { theme: 'dark' });
  await assert.rejects(store.update(0, { period: 'today' }), (error) => {
    assert.equal(error.code, 'revision_conflict');
    assert.deepEqual(error.current, { revision: 1, settings: { period: 'week', theme: 'dark' } });
    return true;
  });

  const results = await Promise.allSettled([
    store.update(1, { period: 'today' }),
    store.update(1, { period: 'month' }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal((await store.load()).settings.period, 'today');
});

test('store fails closed when the file belongs to a different store', async (t) => {
  const directory = await makePrivateDirectory(t);
  const filePath = path.join(directory, 's.json');
  await createSettingsStore({ filePath, store: STORE }).update(0, { theme: 'dark' });
  const foreign = createSettingsStore({ filePath, store: OTHER_STORE });
  await assert.rejects(foreign.load(), { code: 'scope_mismatch' });
  // Writes must not replace another store's file either.
  await assert.rejects(foreign.update(1, { theme: 'light' }), { code: 'scope_mismatch' });
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).store, STORE);
});

test('store rejects malformed, extended, oversized and unsafe files', async (t) => {
  const directory = await makePrivateDirectory(t);
  const filePath = path.join(directory, 's.json');
  const valid = {
    format: SETTINGS_FORMAT,
    version: 1,
    store: STORE,
    revision: 3,
    settings: { period: 'week', theme: 'dark' },
  };
  const variants = {
    notJson: '{nope',
    array: '[]',
    extraTopLevel: JSON.stringify({ ...valid, owner: 'x' }),
    extraSetting: JSON.stringify({ ...valid, settings: { ...valid.settings, name: 'x' } }),
    missingSetting: JSON.stringify({ ...valid, settings: { period: 'week' } }),
    badPeriod: JSON.stringify({ ...valid, settings: { period: 'year', theme: 'dark' } }),
    badTheme: JSON.stringify({ ...valid, settings: { period: 'week', theme: 'blue' } }),
    badVersion: JSON.stringify({ ...valid, version: 2 }),
    badFormat: JSON.stringify({ ...valid, format: 'other' }),
    zeroRevision: JSON.stringify({ ...valid, revision: 0 }),
    fractionRevision: JSON.stringify({ ...valid, revision: 1.5 }),
    hugeRevision: JSON.stringify({ ...valid, revision: 2 ** 40 }),
    oversized: JSON.stringify({ ...valid, padding: 'x'.repeat(4096) }),
  };
  for (const [name, text] of Object.entries(variants)) {
    await fs.writeFile(filePath, text, { mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    const store = createSettingsStore({ filePath, store: STORE });
    await assert.rejects(store.load(), SettingsError, name);
    await assert.rejects(store.update(3, { theme: 'light' }), SettingsError, name);
    assert.equal(await fs.readFile(filePath, 'utf8'), text, `${name} must not be overwritten`);
  }

  await fs.writeFile(filePath, JSON.stringify(valid), { mode: 0o600 });
  await fs.chmod(filePath, 0o644);
  await assert.rejects(createSettingsStore({ filePath, store: STORE }).load(), SettingsError);
  await fs.chmod(filePath, 0o600);
  assert.equal((await createSettingsStore({ filePath, store: STORE }).load()).revision, 3);
});

test('store refuses symlinked files, symlinked directories, hard links and open directories', async (t) => {
  const directory = await makePrivateDirectory(t);
  const target = path.join(directory, 'target.json');
  await fs.writeFile(
    target,
    JSON.stringify({
      format: SETTINGS_FORMAT,
      version: 1,
      store: STORE,
      revision: 1,
      settings: { period: 'week', theme: 'dark' },
    }),
    { mode: 0o600 },
  );

  const linkedFile = path.join(directory, 'link.json');
  await fs.symlink(target, linkedFile);
  await assert.rejects(
    createSettingsStore({ filePath: linkedFile, store: STORE }).load(),
    SettingsError,
  );

  const hardLink = path.join(directory, 'hard.json');
  await fs.link(target, hardLink);
  await assert.rejects(
    createSettingsStore({ filePath: hardLink, store: STORE }).load(),
    SettingsError,
  );

  const linkedDirectory = path.join(directory, 'dirlink');
  await fs.symlink(directory, linkedDirectory);
  const viaLink = createSettingsStore({
    filePath: path.join(linkedDirectory, 'target.json'),
    store: STORE,
  });
  await assert.rejects(viaLink.load(), SettingsError);
  await assert.rejects(viaLink.update(1, { theme: 'light' }), SettingsError);

  const openDirectory = path.join(directory, 'open');
  await fs.mkdir(openDirectory, { mode: 0o755 });
  await fs.chmod(openDirectory, 0o755);
  const inOpen = createSettingsStore({
    filePath: path.join(openDirectory, 's.json'),
    store: STORE,
  });
  await assert.rejects(inOpen.load(), SettingsError);
  await assert.rejects(inOpen.update(0, { theme: 'dark' }), SettingsError);
  assert.deepEqual(await fs.readdir(openDirectory), []);
});

test('store creates a missing private directory and rejects bad constructor input', async (t) => {
  const directory = await makePrivateDirectory(t);
  const nested = path.join(directory, 'new-dir', 's.json');
  await createSettingsStore({ filePath: nested, store: STORE }).update(0, { period: 'month' });
  assert.equal((await fs.stat(path.dirname(nested))).mode & 0o777, 0o700);
  for (const filePath of ['relative.json', '/a/../b/s.json', '/a/b\0/s.json', '']) {
    assert.throws(() => createSettingsStore({ filePath, store: STORE }), SettingsError);
  }
  assert.throws(() => createSettingsStore({ filePath: nested, store: '' }), SettingsError);
});

// ---- configuration ----

test('settings stay disabled unless LIVE_SETTINGS_PATH is explicitly configured', () => {
  assert.equal(loadSettingsConfig({}), null);
  assert.equal(loadSettingsConfig({ LIVE_SETTINGS_PATH: '' }), null);
  assert.equal(createConfiguredSettings(loadConfig(ENV), ENV), null);
  assert.deepEqual(loadSettingsConfig({ LIVE_SETTINGS_PATH: '/var/lib/metrictv/settings.json' }), {
    filePath: '/var/lib/metrictv/settings.json',
  });
  const invalid = [
    'settings.json',
    './settings.json',
    '/var/lib/../lib/settings.json',
    '/var/lib//settings.json',
    '/var/lib/settings.txt',
    '/var/lib/settings.json\0',
    '/var/lib/settings.json/',
  ];
  for (const value of invalid) {
    assert.throws(
      () => loadSettingsConfig({ LIVE_SETTINGS_PATH: value }),
      /LIVE_SETTINGS_PATH/,
      value,
    );
  }
});

test('configured settings must live outside the project directory', () => {
  const projectFile = path.join(path.resolve(import.meta.dirname, '..'), 'public', 'settings.json');
  assert.throws(
    () => createConfiguredSettings(loadConfig(ENV), { ...ENV, LIVE_SETTINGS_PATH: projectFile }),
    /outside the project/,
  );
  const outside = '/var/lib/metrictv/settings.json';
  const service = createConfiguredSettings(loadConfig(ENV), {
    ...ENV,
    LIVE_SETTINGS_PATH: outside,
  });
  assert.equal(typeof service.handle, 'function');
});

// ---- real HTTP ----

httpTest('disabled feature: routes do not exist and the dashboard still serves', async (t) => {
  const port = await startServer(t, { filePath: '/unused/settings.json', enabled: false });
  const read = await send(port, {});
  assert.equal(read.status, 404);
  const write = await send(port, { method: 'POST', headers: { origin: ORIGIN }, body: '{}' });
  assert.equal(write.status, 405);
  assert.equal((await send(port, { path: '/api/snapshot' })).status, 503);
});

httpTest('owner gate applies to both settings methods before any settings logic', async (t) => {
  const directory = await makePrivateDirectory(t);
  const filePath = path.join(directory, 's.json');
  const port = await startServer(t, { filePath });
  const state = await readState(port);
  const denials = [
    ['unlisted owner', { 'tailscale-user-login': 'mallory@example.com' }],
    ['empty identity', { 'tailscale-user-login': '' }],
    ['comma-joined identity', { 'tailscale-user-login': 'alice@example.com,mallory@example.com' }],
    ['duplicate identity', { 'tailscale-user-login': ['alice@example.com', 'alice@example.com'] }],
    ['wrong host', { host: 'evil.example' }],
  ];
  for (const [name, overrides] of denials) {
    const read = await send(port, { headers: overrides });
    assert.equal(read.status, 403, name);
    assert.equal(read.text.includes(state.csrfToken), false, name);
    // Even a perfectly valid Origin and CSRF token must not get past the owner gate.
    const write = await post(port, state, { theme: 'dark' }, { headers: overrides });
    assert.equal(write.status, 403, name);
  }
  assert.equal((await readState(port)).revision, 0);
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

httpTest(
  'GET and HEAD return revision, settings and a CSRF token with no-store headers',
  async (t) => {
    const directory = await makePrivateDirectory(t);
    const port = await startServer(t, { filePath: path.join(directory, 's.json') });
    const read = await send(port, {});
    assert.equal(read.status, 200);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.match(read.headers['content-type'], /^application\/json/);
    assert.deepEqual(Object.keys(read.json).sort(), [
      'csrfToken',
      'enabled',
      'revision',
      'settings',
    ]);
    assert.equal(read.json.enabled, true);
    assert.equal(read.json.revision, 0);
    assert.deepEqual(read.json.settings, { period: 'week', theme: 'light' });
    assert.match(read.json.csrfToken, /^[A-Za-z0-9_-]{16,256}$/);

    const head = await send(port, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['cache-control'], 'no-store');

    const other = await readState(port, { 'tailscale-user-login': 'bob@example.com' });
    assert.notEqual(other.csrfToken, read.json.csrfToken, 'token is bound to the principal');
  },
);

httpTest('two owner browsers share saved choices and they survive a server restart', async (t) => {
  const directory = await makePrivateDirectory(t);
  const filePath = path.join(directory, 's.json');
  const firstPort = await startServer(t, { filePath });

  const phone = await readState(firstPort);
  const saved = await post(firstPort, phone, { theme: 'dark', period: 'month' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { revision: 1, settings: { period: 'month', theme: 'dark' } });
  assert.equal(saved.headers['cache-control'], 'no-store');

  const laptop = await readState(firstPort, { 'tailscale-user-login': 'bob@example.com' });
  assert.equal(laptop.revision, 1);
  assert.deepEqual(laptop.settings, { period: 'month', theme: 'dark' });

  // A brand-new server, service and store instance reading the same file.
  const secondPort = await startServer(t, { filePath });
  const afterRestart = await readState(secondPort);
  assert.equal(afterRestart.revision, 1);
  assert.deepEqual(afterRestart.settings, { period: 'month', theme: 'dark' });
  // CSRF secrets are per process: an old token must not work after restart.
  const stale = await post(
    secondPort,
    afterRestart,
    { theme: 'light' },
    {
      headers: { 'x-csrf-token': phone.csrfToken },
    },
  );
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error, 'invalid_csrf');
});

httpTest(
  'writes need the exact Origin, a same-site fetch and the principal-bound CSRF token',
  async (t) => {
    const directory = await makePrivateDirectory(t);
    const filePath = path.join(directory, 's.json');
    const port = await startServer(t, { filePath });
    const state = await readState(port);
    const bob = await readState(port, { 'tailscale-user-login': 'bob@example.com' });

    const attempts = [
      ['missing origin', { origin: undefined }, 403, 'forbidden'],
      ['other origin', { origin: 'https://evil.example' }, 403, 'forbidden'],
      ['http origin', { origin: `http://${HOST}` }, 403, 'forbidden'],
      ['origin with path', { origin: `${ORIGIN}/` }, 403, 'forbidden'],
      ['duplicate origin', { origin: [ORIGIN, ORIGIN] }, 400, 'bad_request'],
      ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }, 403, 'forbidden'],
      ['same-site fetch', { 'sec-fetch-site': 'same-site' }, 403, 'forbidden'],
      ['missing csrf', { 'x-csrf-token': undefined }, 403, 'invalid_csrf'],
      ['wrong csrf', { 'x-csrf-token': 'x'.repeat(state.csrfToken.length) }, 403, 'invalid_csrf'],
      ['short csrf', { 'x-csrf-token': 'x' }, 403, 'invalid_csrf'],
      ["another owner's csrf", { 'x-csrf-token': bob.csrfToken }, 403, 'invalid_csrf'],
      [
        'duplicate csrf',
        { 'x-csrf-token': [state.csrfToken, state.csrfToken] },
        400,
        'bad_request',
      ],
    ];
    for (const [name, overrides, status, code] of attempts) {
      const headers = {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': state.csrfToken,
        ...overrides,
      };
      for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
      const response = await send(port, {
        method: 'POST',
        headers,
        body: JSON.stringify({ revision: 0, settings: { theme: 'dark' } }),
      });
      assert.equal(response.status, status, name);
      assert.equal(response.json.error, code, name);
    }
    assert.equal((await readState(port)).revision, 0, 'no rejected request may change state');
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });

    const accepted = await post(port, state, { theme: 'dark' });
    assert.equal(accepted.status, 200);
  },
);

httpTest(
  'malformed, oversized and unexpected bodies are rejected without changing state',
  async (t) => {
    const directory = await makePrivateDirectory(t);
    const port = await startServer(t, { filePath: path.join(directory, 's.json') });
    const state = await readState(port);
    const bad = [
      ['invalid json', '{nope'],
      ['empty', ''],
      ['array', '[]'],
      ['null', 'null'],
      ['no settings', '{"revision":0}'],
      ['no revision', '{"settings":{"theme":"dark"}}'],
      [
        'extra top-level field',
        '{"revision":0,"settings":{"theme":"dark"},"store":"x.myshopify.com"}',
      ],
      ['unknown setting', '{"revision":0,"settings":{"theme":"dark","path":"/etc/passwd"}}'],
      ['empty settings', '{"revision":0,"settings":{}}'],
      ['settings array', '{"revision":0,"settings":[]}'],
      ['bad theme', '{"revision":0,"settings":{"theme":"blue"}}'],
      ['bad period', '{"revision":0,"settings":{"period":"year"}}'],
      ['non-string period', '{"revision":0,"settings":{"period":7}}'],
      ['string revision', '{"revision":"0","settings":{"theme":"dark"}}'],
      ['negative revision', '{"revision":-1,"settings":{"theme":"dark"}}'],
      ['fractional revision', '{"revision":0.5,"settings":{"theme":"dark"}}'],
      ['huge revision', '{"revision":1e21,"settings":{"theme":"dark"}}'],
      ['proto key', '{"revision":0,"settings":{"__proto__":{"theme":"dark"}}}'],
    ];
    for (const [name, rawBody] of bad) {
      const response = await post(port, state, {}, { rawBody });
      assert.equal(response.status, 400, name);
      assert.equal(response.json.error, 'bad_request', name);
    }

    const oversized = await post(
      port,
      state,
      {},
      { rawBody: JSON.stringify({ revision: 0, pad: 'x'.repeat(5000) }) },
    );
    assert.equal(oversized.status, 413);
    assert.equal(oversized.json.error, 'payload_too_large');

    const wrongType = await post(
      port,
      state,
      {},
      {
        headers: { 'content-type': 'text/plain' },
        rawBody: '{"revision":0,"settings":{"theme":"dark"}}',
      },
    );
    assert.equal(wrongType.status, 415);

    assert.deepEqual(await readState(port), state);
  },
);

httpTest(
  'stale and concurrent writers get 409 with the current state, not a silent overwrite',
  async (t) => {
    const directory = await makePrivateDirectory(t);
    const port = await startServer(t, { filePath: path.join(directory, 's.json') });
    const phone = await readState(port);
    const laptop = await readState(port, { 'tailscale-user-login': 'bob@example.com' });

    const race = await Promise.all([
      post(port, phone, { period: 'today' }),
      post(
        port,
        laptop,
        { period: 'days60' },
        { headers: { 'tailscale-user-login': 'bob@example.com' } },
      ),
    ]);
    const statuses = race.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = race.find((response) => response.status === 200);
    const loser = race.find((response) => response.status === 409);
    assert.equal(loser.json.error, 'revision_conflict');
    assert.equal(loser.json.revision, 1);
    assert.deepEqual(loser.json.settings, winner.json.settings);
    assert.deepEqual((await readState(port)).settings, winner.json.settings);

    // Retrying after reading the newer revision succeeds.
    const refreshed = await readState(port);
    assert.equal((await post(port, refreshed, { theme: 'dark' })).status, 200);
  },
);

httpTest('unsupported methods and query strings are refused', async (t) => {
  const directory = await makePrivateDirectory(t);
  const port = await startServer(t, { filePath: path.join(directory, 's.json') });
  const put = await send(port, { method: 'PUT', headers: { origin: ORIGIN }, body: '{}' });
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET, HEAD, POST');
  assert.equal((await send(port, { path: '/api/settings?path=/etc/passwd' })).status, 400);
  assert.equal((await send(port, { path: '/api/settings/' })).status, 404);
  assert.equal((await send(port, { path: '/api/settings.json' })).status, 404);
});

httpTest('a file from another store yields a safe 503 and is never overwritten', async (t) => {
  const directory = await makePrivateDirectory(t);
  const filePath = path.join(directory, 's.json');
  await createSettingsStore({ filePath, store: OTHER_STORE }).update(0, { theme: 'dark' });
  const before = await fs.readFile(filePath, 'utf8');

  const port = await startServer(t, { filePath, store: STORE });
  const read = await send(port, {});
  assert.equal(read.status, 503);
  assert.deepEqual(read.json, { error: 'settings_unavailable' });

  // A valid token and Origin still cannot write over the other store's file.
  const state = { revision: 1, csrfToken: lastService.csrfTokenFor('alice@example.com') };
  const write = await post(port, state, { theme: 'light' });
  assert.equal(write.status, 503);
  assert.deepEqual(write.json, { error: 'settings_unavailable' });
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
  for (const text of [read.text, write.text]) {
    assert.equal(text.includes(directory), false);
    assert.equal(text.includes(OTHER_STORE), false);
  }
});

httpTest('write failures are reported as safe errors without paths', async (t) => {
  const directory = await makePrivateDirectory(t);
  const filePath = path.join(directory, 's.json');
  const port = await startServer(t, { filePath });
  const state = await readState(port);
  await fs.writeFile(filePath, '{broken', { mode: 0o600 });
  const response = await post(port, state, { theme: 'dark' });
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, { error: 'settings_unavailable' });
  assert.equal(response.text.includes(directory), false);
  assert.equal(await fs.readFile(filePath, 'utf8'), '{broken');
});
