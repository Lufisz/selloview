// Browser helper for shared dashboard settings, plus live.js wiring through a minimal DOM double.
// All data is synthetic; transports are labelled test doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createSettingsSync,
  fetchSettings,
  parseSettings,
  saveSettings,
  SETTINGS_MESSAGES,
} from '../public/live-settings-client.js';

const TOKEN = 'token_abc-123_synthetic_value';
const defaults = { period: 'week', theme: 'light' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function settingsBody(overrides = {}) {
  return { enabled: true, revision: 3, settings: defaults, csrfToken: TOKEN, ...overrides };
}

// A promise whose resolution the test controls, to order responses deliberately.
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test('parseSettings accepts only complete known values', () => {
  assert.deepEqual(parseSettings({ period: 'today', theme: 'dark', extra: 1 }), {
    period: 'today',
    theme: 'dark',
  });
  for (const bad of [null, [], 'x', {}, { period: 'week' }, { period: 'year', theme: 'dark' }]) {
    assert.equal(parseSettings(bad), null);
  }
});

test('fetchSettings maps 404 to disabled and rejects malformed or unsafe bodies', async () => {
  assert.deepEqual(await fetchSettings({ fetchImpl: async () => jsonResponse({}, 404) }), {
    status: 'disabled',
  });
  for (const status of [401, 403]) {
    const outcome = await fetchSettings({ fetchImpl: async () => jsonResponse({}, status) });
    assert.equal(outcome.status, 'unauthorized');
  }
  assert.equal(
    (await fetchSettings({ fetchImpl: async () => jsonResponse({}, 503) })).status,
    'error',
  );
  assert.equal(
    (
      await fetchSettings({
        fetchImpl: async () => {
          throw new Error('network down');
        },
      })
    ).status,
    'offline',
  );
  const malformed = [
    settingsBody({ enabled: false }),
    settingsBody({ revision: -1 }),
    settingsBody({ revision: '3' }),
    settingsBody({ csrfToken: 'short' }),
    settingsBody({ csrfToken: 'has spaces and <markup> 000' }),
    settingsBody({ settings: { period: 'year', theme: 'dark' } }),
  ];
  for (const body of malformed) {
    const outcome = await fetchSettings({ fetchImpl: async () => jsonResponse(body) });
    assert.equal(outcome.status, 'error', JSON.stringify(body));
  }
  const good = await fetchSettings({ fetchImpl: async () => jsonResponse(settingsBody()) });
  assert.deepEqual(good, { status: 'ok', revision: 3, settings: defaults, csrfToken: TOKEN });
});

test('fetchSettings never sends a body or custom security header', async () => {
  let seen;
  await fetchSettings({
    fetchImpl: async (path, init) => {
      seen = { path, init };
      return jsonResponse(settingsBody());
    },
  });
  assert.equal(seen.path, '/api/settings');
  assert.equal(seen.init.method, undefined);
  assert.equal(seen.init.body, undefined);
  assert.equal(seen.init.cache, 'no-store');
});

test('saveSettings sends only revision and the changed fields, with the CSRF header', async () => {
  let seen;
  const outcome = await saveSettings({
    revision: 3,
    patch: { theme: 'dark' },
    csrfToken: TOKEN,
    fetchImpl: async (path, init) => {
      seen = { path, init };
      return jsonResponse({ revision: 4, settings: { period: 'week', theme: 'dark' } });
    },
  });
  assert.deepEqual(outcome, {
    status: 'ok',
    revision: 4,
    settings: { period: 'week', theme: 'dark' },
  });
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['X-CSRF-Token'], TOKEN);
  assert.deepEqual(JSON.parse(seen.init.body), { revision: 3, settings: { theme: 'dark' } });
});

test('saveSettings classifies conflict, security, disabled, offline and server errors', async () => {
  const call = (fetchImpl) =>
    saveSettings({ revision: 1, patch: { theme: 'dark' }, csrfToken: TOKEN, fetchImpl });
  const current = { revision: 5, settings: { period: 'today', theme: 'light' } };
  assert.deepEqual(
    await call(async () => jsonResponse({ error: 'revision_conflict', ...current }, 409)),
    { status: 'conflict', ...current },
  );
  assert.equal(
    (await call(async () => jsonResponse({ error: 'invalid_csrf' }, 403))).status,
    'security',
  );
  assert.equal((await call(async () => jsonResponse({}, 404))).status, 'disabled');
  assert.equal((await call(async () => jsonResponse({ error: 'x' }, 503))).status, 'error');
  assert.equal((await call(async () => jsonResponse({ error: 'x' }, 409))).status, 'error');
  assert.equal((await call(async () => jsonResponse({ ok: 1 }, 200))).status, 'error');
  assert.equal(
    (
      await call(async () => {
        throw new Error('offline');
      })
    ).status,
    'offline',
  );
});

// ---- createSettingsSync ----

function createSyncHarness({ routes }) {
  const local = { ...defaults };
  const applied = [];
  const notices = [];
  const requests = [];
  const sync = createSettingsSync({
    getLocalSettings: () => ({ ...local }),
    applySettings: (settings) => {
      Object.assign(local, settings);
      applied.push(settings);
    },
    notify: (kind) => notices.push(kind),
    fetchImpl: async (path, init = {}) => {
      const request = { method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) };
      requests.push(request);
      return routes(request);
    },
  });
  return { sync, local, applied, notices, requests };
}

test('sync does nothing and keeps local choices when the feature is disabled', async () => {
  const harness = createSyncHarness({ routes: () => jsonResponse({}, 404) });
  await harness.sync.load();
  harness.local.theme = 'dark';
  await harness.sync.change({ theme: 'dark' });
  await harness.sync.load();
  assert.equal(harness.sync.isEnabled(), false);
  assert.deepEqual(
    harness.requests.map((request) => request.method),
    ['GET'],
  );
  assert.deepEqual(harness.applied, []);
  assert.deepEqual(harness.notices, []);
});

test('sync applies saved server choices and sends only the changed field afterwards', async () => {
  const harness = createSyncHarness({
    routes: (request) =>
      request.method === 'GET'
        ? jsonResponse(settingsBody({ revision: 3, settings: { period: 'month', theme: 'dark' } }))
        : jsonResponse({ revision: 4, settings: { period: 'today', theme: 'dark' } }),
  });
  await harness.sync.load();
  assert.deepEqual(harness.applied, [{ period: 'month', theme: 'dark' }]);
  harness.local.period = 'today';
  await harness.sync.change({ period: 'today' });
  assert.deepEqual(harness.requests[1], {
    method: 'POST',
    body: { revision: 3, settings: { period: 'today' } },
  });
});

test('a never-saved server does not overwrite local choices; the first save sends all of them', async () => {
  const harness = createSyncHarness({
    routes: (request) =>
      request.method === 'GET'
        ? jsonResponse(settingsBody({ revision: 0 }))
        : jsonResponse({ revision: 1, settings: { period: 'week', theme: 'dark' } }),
  });
  harness.local.theme = 'dark';
  await harness.sync.load();
  assert.deepEqual(harness.applied, []);
  harness.local.period = 'week';
  await harness.sync.change({ period: 'week' });
  assert.deepEqual(harness.requests[1].body, {
    revision: 0,
    settings: { period: 'week', theme: 'dark' },
  });
});

test('choices made during the first read are saved using its revision, not lost', async () => {
  const firstRead = deferred();
  const harness = createSyncHarness({
    routes: (request) =>
      request.method === 'GET'
        ? firstRead.promise
        : jsonResponse({ revision: 8, settings: { period: 'week', theme: 'dark' } }),
  });
  const loading = harness.sync.load();
  harness.local.theme = 'dark';
  await harness.sync.change({ theme: 'dark' });
  firstRead.resolve(jsonResponse(settingsBody({ revision: 7 })));
  await loading;
  assert.deepEqual(harness.requests[1].body, { revision: 7, settings: { theme: 'dark' } });
  assert.equal(harness.local.theme, 'dark');
  assert.deepEqual(harness.applied, []);
  assert.deepEqual(harness.notices, []);
});

test('an older in-flight read cannot overwrite a newer local choice', async () => {
  const slowRead = deferred();
  let reads = 0;
  const harness = createSyncHarness({
    routes: (request) => {
      if (request.method === 'POST') {
        return jsonResponse({ revision: 8, settings: { period: 'week', theme: 'dark' } });
      }
      reads += 1;
      return reads === 1 ? jsonResponse(settingsBody({ revision: 7 })) : slowRead.promise;
    },
  });
  await harness.sync.load();
  const staleLoad = harness.sync.load(); // starts before the local change
  await new Promise((resolve) => setImmediate(resolve));
  harness.local.theme = 'dark';
  await harness.sync.change({ theme: 'dark' });
  slowRead.resolve(jsonResponse(settingsBody({ revision: 7, settings: defaults })));
  await staleLoad;
  assert.equal(harness.local.theme, 'dark');
  assert.equal(harness.applied.length, 1, 'only the first, pre-change read was applied');
  // The stale read must not have rolled back the revision either: the next save uses 8.
  harness.local.period = 'today';
  await harness.sync.change({ period: 'today' });
  assert.equal(harness.requests.at(-1).body.revision, 8);
});

test('a read arriving while a save is in flight is discarded', async () => {
  const slowSave = deferred();
  const harness = createSyncHarness({
    routes: (request) =>
      request.method === 'GET' ? jsonResponse(settingsBody({ revision: 7 })) : slowSave.promise,
  });
  await harness.sync.load();
  harness.local.theme = 'dark';
  const saving = harness.sync.change({ theme: 'dark' });
  await harness.sync.load(); // completes while the POST is still pending
  assert.equal(harness.applied.length, 1);
  assert.equal(harness.local.theme, 'dark');
  slowSave.resolve(jsonResponse({ revision: 8, settings: { period: 'week', theme: 'dark' } }));
  await saving;
});

test('saves are serialized, merged and each uses the newest revision', async () => {
  const firstSave = deferred();
  let posts = 0;
  const harness = createSyncHarness({
    routes: (request) => {
      if (request.method === 'GET') return jsonResponse(settingsBody({ revision: 7 }));
      posts += 1;
      if (posts === 1) return firstSave.promise;
      return jsonResponse({ revision: 9, settings: { period: 'today', theme: 'dark' } });
    },
  });
  await harness.sync.load();
  harness.local.theme = 'dark';
  const first = harness.sync.change({ theme: 'dark' });
  harness.local.period = 'month';
  harness.sync.change({ period: 'month' });
  harness.local.period = 'today';
  const last = harness.sync.change({ period: 'today' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.requests.filter((request) => request.method === 'POST').length, 1);
  firstSave.resolve(jsonResponse({ revision: 8, settings: { period: 'week', theme: 'dark' } }));
  await Promise.all([first, last]);
  const posted = harness.requests.filter((request) => request.method === 'POST');
  assert.equal(posted.length, 2, 'the two quick period changes collapse into one request');
  assert.deepEqual(posted[0].body, { revision: 7, settings: { theme: 'dark' } });
  assert.deepEqual(posted[1].body, { revision: 8, settings: { period: 'today' } });
});

test('a revision conflict adopts the newer server choices and says so', async () => {
  const harness = createSyncHarness({
    routes: (request) =>
      request.method === 'GET'
        ? jsonResponse(settingsBody({ revision: 7 }))
        : jsonResponse(
            {
              error: 'revision_conflict',
              revision: 9,
              settings: { period: 'days60', theme: 'light' },
            },
            409,
          ),
  });
  await harness.sync.load();
  harness.local.theme = 'dark';
  await harness.sync.change({ theme: 'dark' });
  assert.deepEqual(harness.applied.at(-1), { period: 'days60', theme: 'light' });
  assert.deepEqual(harness.notices, ['conflict']);
  harness.local.period = 'today';
  await harness.sync.change({ period: 'today' });
  assert.equal(harness.requests.at(-1).body.revision, 9);
});

test('save failures are surfaced honestly and an expired token is refreshed on the next poll', async () => {
  let token = TOKEN;
  let rejectSaves = true;
  const harness = createSyncHarness({
    routes: (request) => {
      if (request.method === 'GET') {
        return jsonResponse(settingsBody({ revision: 7, csrfToken: token }));
      }
      return rejectSaves
        ? jsonResponse({ error: 'invalid_csrf' }, 403)
        : jsonResponse({ revision: 8, settings: { period: 'week', theme: 'dark' } });
    },
  });
  await harness.sync.load();
  harness.local.theme = 'dark';
  await harness.sync.change({ theme: 'dark' });
  assert.deepEqual(harness.notices, ['saveFailed']);
  assert.match(SETTINGS_MESSAGES.saveFailed, /Could not save/);

  // With the token cleared a further change fails visibly instead of silently pretending.
  await harness.sync.change({ theme: 'light' });
  assert.deepEqual(harness.notices, ['saveFailed', 'saveFailed']);
  assert.equal(harness.requests.filter((request) => request.method === 'POST').length, 1);

  token = 'token_after_restart_0123456789';
  rejectSaves = false;
  await harness.sync.load();
  harness.local.theme = 'dark';
  await harness.sync.change({ theme: 'dark' });
  assert.equal(harness.notices.length, 2);
  assert.equal(harness.requests.at(-1).method, 'POST');
});

test('network failure and server errors during save notify without throwing', async () => {
  for (const failing of [
    () => {
      throw new Error('network');
    },
    () => jsonResponse({ error: 'settings_unavailable' }, 503),
  ]) {
    const harness = createSyncHarness({
      routes: (request) => (request.method === 'GET' ? jsonResponse(settingsBody()) : failing()),
    });
    await harness.sync.load();
    harness.local.theme = 'dark';
    await harness.sync.change({ theme: 'dark' });
    assert.deepEqual(harness.notices, ['saveFailed']);
  }
});

// ---- live.js wiring ----

function createLiveHarness({ routes }) {
  const listeners = { app: {}, window: {}, document: {} };
  const requests = [];
  const stored = [];
  const toasts = [];
  const noop = () => {};
  const element = (name) => ({
    innerHTML: '',
    addEventListener(type, handler) {
      listeners[name] ??= {};
      (listeners[name][type] ??= []).push(handler);
    },
  });
  const app = element('app');
  const toast = { ...element('toast'), classList: { add: noop, remove: noop } };
  Object.defineProperty(toast, 'textContent', {
    set: (value) => toasts.push(value),
    get: () => '',
  });
  const registry = {
    '#app': app,
    '#toast': toast,
    '#info-dialog': { ...element('dialog'), showModal: noop, close: noop },
    '#dialog-content': { innerHTML: '' },
    '#close-dialog': element('close'),
  };
  Object.assign(globalThis, {
    setInterval: () => 0,
    document: {
      title: '',
      hidden: false,
      activeElement: null,
      body: { classList: { toggle: noop } },
      documentElement: { classList: { add: noop, remove: noop } },
      querySelector: (selector) => registry[selector] ?? null,
      getElementById: () => null,
      addEventListener: noop,
    },
    localStorage: { getItem: () => null, setItem: (key, value) => stored.push([key, value]) },
    location: { search: '', hash: '#/dashboard', pathname: '/live.html' },
    history: { replaceState: noop },
    fetch: async (path, init = {}) => {
      requests.push({ path, method: init.method ?? 'GET', headers: init.headers, body: init.body });
      return routes(path, init);
    },
  });
  globalThis.window = { location: { assign: noop }, addEventListener: noop };
  return { app, listeners, requests, stored, toasts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const tick = async () => {
  for (let index = 0; index < 5; index += 1) await settle();
};

function chooseTheme(harness) {
  const button = { dataset: { action: 'theme' } };
  for (const handler of harness.listeners.app.click) handler({ target: { closest: () => button } });
}

function choosePeriod(harness, value) {
  for (const handler of harness.listeners.app.change) {
    handler({ target: { id: 'period', value } });
  }
}

let importCounter = 0;
async function loadLive(options) {
  const harness = createLiveHarness(options);
  await import(`../public/live.js?settings-harness=${(importCounter += 1)}`);
  await tick();
  return harness;
}

const otherRoutes = (path) =>
  path === '/api/connection' ? jsonResponse({}, 500) : jsonResponse({ error: 'no_snapshot' }, 503);

test('live.js keeps local-only preferences when /api/settings is disabled', async () => {
  const harness = await loadLive({
    routes: (path) => (path === '/api/settings' ? jsonResponse({}, 404) : otherRoutes(path)),
  });
  chooseTheme(harness);
  choosePeriod(harness, 'today');
  await tick();
  assert.deepEqual(
    harness.requests.filter((request) => request.method === 'POST'),
    [],
  );
  assert.deepEqual(JSON.parse(harness.stored.at(-1)[1]), { period: 'today', theme: 'dark' });
});

test('live.js shares period and theme through the server when enabled, keeping CSRF in memory', async () => {
  let revision = 2;
  let saved = { period: 'month', theme: 'dark' };
  const harness = await loadLive({
    routes: (path, init) => {
      if (path !== '/api/settings') return otherRoutes(path);
      if (init.method !== 'POST') {
        return jsonResponse(settingsBody({ revision, settings: saved }));
      }
      const request = JSON.parse(init.body);
      assert.equal(request.revision, revision);
      saved = { ...saved, ...request.settings };
      revision += 1;
      return jsonResponse({ revision, settings: saved });
    },
  });
  // The server's saved choices replaced the (empty) local ones.
  assert.deepEqual(JSON.parse(harness.stored.at(-1)[1]), { period: 'month', theme: 'dark' });

  choosePeriod(harness, 'today');
  await tick();
  chooseTheme(harness);
  await tick();
  const posts = harness.requests.filter((request) => request.method === 'POST');
  assert.deepEqual(
    posts.map((request) => JSON.parse(request.body)),
    [
      { revision: 2, settings: { period: 'today' } },
      { revision: 3, settings: { theme: 'light' } },
    ],
  );
  assert.equal(posts[0].headers['X-CSRF-Token'], TOKEN);
  assert.deepEqual(saved, { period: 'today', theme: 'light' });
  assert.equal(
    harness.stored.some(([, value]) => value.includes(TOKEN)),
    false,
  );
  assert.deepEqual(harness.toasts, []);
});

test('live.js tells the owner when a shared save fails', async () => {
  const harness = await loadLive({
    routes: (path, init) => {
      if (path !== '/api/settings') return otherRoutes(path);
      return init.method === 'POST'
        ? jsonResponse({ error: 'settings_unavailable' }, 503)
        : jsonResponse(settingsBody());
    },
  });
  chooseTheme(harness);
  await tick();
  assert.deepEqual(harness.toasts, [SETTINGS_MESSAGES.saveFailed]);
});

test('settings helper keeps secrets out of storage and URLs', async () => {
  const source = await readFile(
    new URL('../public/live-settings-client.js', import.meta.url),
    'utf8',
  );
  assert.equal(
    /localStorage|sessionStorage|document\.cookie|location\.|history\./.test(source),
    false,
  );
  assert.match(source, /redirect: 'error'/);
});
