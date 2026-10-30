// Owner workspace layout: connection strip per state, native <details> behaviour, drafts,
// confirmation boundaries and CSS scoping. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderOwner } from '../../public/owner/owner-view.js';
import { renderStorePanel, detailsOpenAttribute } from '../../public/owner/store-view.js';

const STORE = 'synthetic-ui.myshopify.com';
const SNAPSHOT = { fetchedAt: '2026-10-29T10:00:00.000Z', shop: { timeZone: 'Europe/Stockholm' } };

function connection(state, sync = null) {
  return { state, store: STORE, canConnect: true, sync };
}

function panel(storeParts, overrides = {}) {
  return renderStorePanel({
    store: { status: 'ready', snapshot: null, ...storeParts },
    storeMessage: '',
    storeTone: 'info',
    shopifyReturn: '',
    confirmDisconnect: false,
    storeAction: '',
    ...overrides,
  });
}

const OWNER_SESSION = {
  owner: { email: 'owner@example.test' },
  workspace: { name: 'Sample', revision: 0, settings: { period: 'week', theme: 'light' } },
  csrfToken: 'owner-csrf-token',
};

function owner(overrides = {}) {
  return renderOwner({
    session: OWNER_SESSION,
    message: '',
    tone: 'info',
    screens: { status: 'ready', items: [] },
    confirmRevokeId: '',
    screenMessage: '',
    screenTone: 'info',
    store: { status: 'ready', connection: connection('not_connected'), snapshot: null },
    ...overrides,
  });
}

const PAIRED_SCREEN = {
  id: 'screen-1',
  name: 'Hall TV',
  pairedAt: '2026-10-28T10:00:00.000Z',
  lastSeenAt: '2026-10-29T09:00:00.000Z',
  expiresAt: '2026-11-07T10:00:00.000Z',
};

test('a healthy connection is one compact green strip with reconnect behind details', () => {
  const html = panel({ connection: connection('connected', { state: 'ok' }), snapshot: SNAPSHOT });
  assert.match(html, /owner-strip is-healthy/);
  assert.match(html, /<details class="owner-manage" data-details-key="connection">/);
  assert.match(html, /Manage connection details/);
  assert.doesNotMatch(html, /<details[^>]*connection"[^>]* open/);
  // The reconnect form and disconnect button exist, but only inside the closed disclosure.
  const outside = html.replace(/<details[\s\S]*<\/details>/, '');
  assert.doesNotMatch(outside, /<form|<input|disconnect-shopify/);
});

test('first read is neutral and stale or failed reads are warnings, never healthy', () => {
  const first = panel({ connection: connection('connected', { state: 'loading' }) });
  assert.match(first, /owner-strip is-neutral/);
  const stale = panel({
    connection: connection('connected', { state: 'stale' }),
    snapshot: SNAPSHOT,
  });
  assert.match(stale, /owner-strip is-warning/);
  assert.match(stale, /may be out of date/);
  const failed = panel({ connection: connection('connected', { state: 'error' }), snapshot: null });
  assert.match(failed, /owner-strip is-warning/);
  assert.doesNotMatch(failed, /is-healthy/);
  const reconnect = panel({ connection: connection('reconnect_required') });
  assert.match(reconnect, /owner-strip is-warning/);
  assert.match(reconnect, /data-form="connect-shopify"/, 'reconnect is visible when required');
  assert.doesNotMatch(reconnect, /owner-manage/);
});

test('states without a store offer no manage disclosure', () => {
  for (const state of ['setup_required', 'pilot_unavailable']) {
    const html = panel({ connection: { ...connection(state), canConnect: false } });
    assert.match(html, /owner-strip is-neutral/);
    assert.doesNotMatch(html, /<details|<form/);
  }
  const none = panel({ connection: connection('not_connected') });
  assert.match(none, /data-form="connect-shopify"/);
  assert.doesNotMatch(none, /<details/);
});

test('details open from the owner choice, and pending decisions or form errors force them open', () => {
  const connected = { connection: connection('connected', { state: 'ok' }), snapshot: SNAPSHOT };
  const chosen = panel(connected, { userChoices: new Map([['connection', true]]) });
  assert.match(chosen, /data-details-key="connection" open>/);
  const closedAgain = panel(connected, { userChoices: new Map([['connection', false]]) });
  assert.doesNotMatch(closedAgain, /data-details-key="connection" open/);

  const confirming = panel(connected, { confirmDisconnect: true });
  assert.match(confirming, /data-details-key="connection" open>/);
  assert.match(confirming, /disconnect-shopify-confirm/);
  assert.match(confirming, /does not uninstall the app/);
  assert.doesNotMatch(confirming, /data-form="connect-shopify"/, 'no reconnect while confirming');
  const idle = panel(connected);
  assert.doesNotMatch(idle, /disconnect-shopify-confirm/, 'never a one-click disconnect');

  const failed = panel(connected, { connectError: 'Enter a Shopify store address.' });
  assert.match(failed, /data-details-key="connection" open>/);
  assert.match(failed, /role="alert"[^>]*>Enter a Shopify store address\./);

  assert.equal(detailsOpenAttribute(new Map(), 'x', { fallback: true }), ' open');
  assert.equal(detailsOpenAttribute(new Map([['x', false]]), 'x', { fallback: true }), '');
  assert.equal(detailsOpenAttribute(undefined, 'x', { forced: true }), ' open');
});

test('the connect draft survives a render and is escaped', () => {
  const html = panel(
    { connection: connection('connected', { state: 'ok' }), snapshot: SNAPSHOT, draft: '"><b>x' },
    { userChoices: new Map([['connection', true]]) },
  );
  assert.match(html, /value="&quot;&gt;&lt;b&gt;x"/);
});

test('the owner page has no setup card; settings and screens are compact and paired screens listed', () => {
  const html = owner({
    screens: { status: 'ready', items: [PAIRED_SCREEN] },
    store: {
      status: 'ready',
      connection: connection('connected', { state: 'ok' }),
      snapshot: null,
    },
  });
  assert.doesNotMatch(html, /Set up your screen|owner-setup/, 'complete setup shows no checklist');
  assert.match(html, /class="owner-fields"/);
  assert.match(html, /for="beta-period"/);
  assert.match(html, /for="beta-theme"/);
  assert.match(html, /name="code"/);
  assert.match(html, /name="name"/);
  assert.match(html, /Hall TV/);
  assert.match(html, /<details class="owner-add-screen"[^>]*data-details-key="add-screen">/);
  assert.match(html, /<details class="owner-tech" data-details-key="screen-screen-1">/);
  assert.doesNotMatch(html, /data-details-key="screen-screen-1" open/);
});

test('the add-screen form opens when no screen is paired, on a pairing error and on request', () => {
  const none = owner();
  assert.match(none, /data-details-key="add-screen" open>/);
  assert.match(none, /owner-setup/, 'an unfinished setup shows the short next-steps line');

  const paired = { status: 'ready', items: [PAIRED_SCREEN] };
  const closed = owner({ screens: paired });
  assert.doesNotMatch(closed, /data-details-key="add-screen" open/);
  const failed = owner({
    screens: paired,
    pairMessage: 'That code is not valid.',
    pairTone: 'error',
    screenDraft: { code: 'ABCD', name: 'Lobby' },
  });
  assert.match(failed, /data-details-key="add-screen" open>/);
  assert.match(failed, /That code is not valid\./);
  assert.match(failed, /name="code"[^>]*value="ABCD"/);
  assert.match(failed, /name="name"[^>]*value="Lobby"/);
  const chosen = owner({ screens: paired, userChoices: new Map([['add-screen', true]]) });
  assert.match(chosen, /data-details-key="add-screen" open>/);
});

test('unsaved settings are kept and screen removal still needs a confirmation', () => {
  const html = owner({
    settingsDraft: { period: 'month', theme: 'dark' },
    screens: { status: 'ready', items: [PAIRED_SCREEN] },
  });
  assert.match(html, /<option value="month" selected>/);
  assert.match(html, /<option value="dark" selected>/);
  assert.match(html, /data-action="revoke-screen"/);
  assert.doesNotMatch(html, /confirm-revoke/);
  const confirming = owner({
    screens: { status: 'ready', items: [PAIRED_SCREEN] },
    confirmRevokeId: 'screen-1',
  });
  assert.match(confirming, /data-action="confirm-revoke" data-id="screen-1"/);
  assert.match(confirming, /data-action="cancel-revoke"/);
});

test('owner styles are scoped so the TV and sign-in screens keep their own', () => {
  const css = fs.readFileSync(new URL('../../public/owner/owner.css', import.meta.url), 'utf8');
  const marker = css.indexOf('/* ---- Owner workspace');
  assert.ok(marker > 0, 'owner section exists');
  const ownerCss = css.slice(marker).replace(/\/\*[\s\S]*?\*\//g, '');
  const selectorLists = [...ownerCss.matchAll(/(?:^|})\s*([^{}@]+)\{/g)].map((match) => match[1]);
  assert.ok(selectorLists.length > 20);
  for (const list of selectorLists) {
    for (const selector of list.split(',').map((part) => part.trim())) {
      assert.match(selector, /^(\.owner-|\.owner-body|\.owner-page)/, selector);
    }
  }
  assert.doesNotMatch(
    css.slice(0, marker),
    /\.owner-/,
    'shared beta rules gain nothing owner-only',
  );
});

/** Runs the real controller against a fake page, then plays owner events and returns the HTML. */
function runControllerScenario(steps) {
  const controllerUrl = new URL('../../public/owner/owner.js', import.meta.url).href;
  const session = { ...OWNER_SESSION, storeConnection: connection('connected', { state: 'ok' }) };
  const script = `
    const listeners = {};
    const app = {
      innerHTML: '',
      addEventListener: (type, handler) => { listeners[type] = handler; },
      querySelector: () => null,
      contains: () => false,
    };
    globalThis.document = {
      querySelector: () => app,
      body: { dataset: {}, classList: { toggle: () => {} } },
      activeElement: null,
    };
    globalThis.window = {
      location: { search: '', hash: '', pathname: '/', origin: 'https://beta.example.test', assign: () => {} },
      history: { replaceState: () => {} },
    };
    globalThis.setTimeout = () => 1;
    globalThis.clearTimeout = () => {};
    const answers = {
      '/api/beta/session': { status: 200, body: ${JSON.stringify(session)} },
      '/api/beta/screens': { status: 200, body: { screens: [] } },
      '/api/beta/shopify': { status: 200, body: ${JSON.stringify({ connection: connection('connected', { state: 'ok' }), snapshot: null })} },
    };
    globalThis.fetch = async (url) => {
      const answer = answers[url];
      return { status: answer.status, ok: answer.status < 300, json: async () => answer.body };
    };
    const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r)); };
    const form = (name) => ({ dataset: { form: name } });
    const typing = (formName, field, value) => ({
      target: { name: field, value, closest: () => form(formName) },
    });
    const summaryClick = (key, isOpen) => ({
      target: { closest: (selector) => selector === 'summary'
        ? { closest: () => ({ dataset: { detailsKey: key }, open: isOpen }) }
        : null },
    });
    const actionClick = (action) => ({
      target: { closest: (selector) => selector === 'summary' ? null : { dataset: { action } } },
    });
    await import(${JSON.stringify(controllerUrl)});
    await settle();
    ${steps}
    console.log(JSON.stringify({ html: app.innerHTML }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 8000,
    }),
  ).html;
}

test('the controller keeps details choices and typed drafts across re-renders', () => {
  const html = runControllerScenario(`
    listeners.click(summaryClick('connection', false));
    listeners.click(summaryClick('add-screen', true));
    listeners.input(typing('pair-screen', 'code', 'ab12'));
    listeners.input(typing('pair-screen', 'name', 'Lobby'));
    listeners.input(typing('settings', 'period', 'month'));
    listeners.input(typing('connect-shopify', 'store', 'draft-store.myshopify.com'));
    listeners.click(actionClick('refresh-screens'));
    await settle();
  `);
  assert.match(html, /data-details-key="connection" open>/);
  assert.doesNotMatch(html, /data-details-key="add-screen" open/, 'a closed choice stays closed');
  assert.match(html, /name="code"[^>]*value="ab12"/);
  assert.match(html, /name="name"[^>]*value="Lobby"/);
  assert.match(html, /<option value="month" selected>/);
  assert.match(html, /value="draft-store.myshopify.com"/);
});

test('an invalid store address opens the connection details with the error, keeping the text', () => {
  const html = runControllerScenario(`
    listeners.input(typing('connect-shopify', 'store', 'not a store'));
    const formData = globalThis.FormData;
    globalThis.FormData = class { get() { return 'not a store'; } };
    listeners.submit({ preventDefault() {}, target: { dataset: { form: 'connect-shopify' } } });
    await settle();
    globalThis.FormData = formData;
  `);
  assert.match(html, /data-details-key="connection" open>/);
  assert.match(html, /role="alert"/);
  assert.match(html, /value="not a store"/);
});
