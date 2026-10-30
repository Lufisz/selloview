// Owner page controller: owns state and events; markup lives in owner-view.js and store-view.js,
// requests in owner-client.js and shopify-client.js. No browser storage, no secrets, no store data.
import {
  loadOwnerSession,
  loadRegistrationStatus,
  loadScreens,
  messageForError,
  pairScreen,
  parseCode,
  parseEmail,
  parsePairingCode,
  requestSignInCode,
  revokeScreen,
  saveWorkspaceSettings,
  signOut,
  verifySignInCode,
} from './owner-client.js';
import {
  SHOPIFY_CALLBACK_PATH,
  consumeShopifyReturn,
  disconnectShopify,
  loadShopifyStatus,
  parseStoreDomain,
  startShopifyConnection,
} from './shopify-client.js';
import { hasOwn } from '../shared/format.js';
import { renderLoading, renderOwner, renderSessionError, renderSignIn } from './owner-view.js';

const STORE_POLL_MS = 30000;
const STORE_FIRST_SYNC_POLL_MS = 5000;
// After approving a TV it needs a few seconds to collect its display session; look a few times.
const SCREEN_WATCH_MS = 3000;
const SCREEN_WATCH_ATTEMPTS = 6;

const app = document.querySelector('#app');
const state = {
  view: 'loading',
  registering: window.location.pathname === '/register',
  registration: { enabled: false, available: false },
  step: 'email',
  email: '',
  session: null,
  message: '',
  tone: 'info',
  busy: false,
  screens: { status: 'loading', items: [] },
  confirmRevokeId: '',
  screenMessage: '',
  screenTone: 'info',
  store: { status: 'loading', connection: null, snapshot: null },
  storeMessage: '',
  storeTone: 'info',
  storeAction: '',
  shopifyReturn: '',
  confirmDisconnect: false,
  connectError: '',
  pairMessage: '',
  pairTone: 'info',
  // What the owner last chose for each native <details>, so re-renders keep it.
  userChoices: new Map(),
  // Unsaved text in the forms, so a re-render never wipes what the owner typed.
  screenDraft: {},
  settingsDraft: {},
};
let storeTimer = null;
let screenWatchId = 0;

function setMessage(message, tone = 'error') {
  state.message = message;
  state.tone = tone;
}

function setScreenMessage(message, tone = 'error') {
  state.screenMessage = message;
  state.screenTone = tone;
}

function setPairMessage(message, tone = 'error') {
  state.pairMessage = message;
  state.pairTone = tone;
}

function setStoreMessage(message, tone = 'error') {
  state.storeMessage = message;
  state.storeTone = tone;
}

// A background refresh must not replace the page while the owner is typing in a form.
function isEditing() {
  const active = document.activeElement;
  return Boolean(active && app.contains(active) && active.matches('input, select, textarea'));
}

// Nor while the connection details are open: reconnect and disconnect are decisions in progress.
function isManagingConnection() {
  return app.querySelector('details.owner-manage[open]') !== null;
}

function attributeSelector(name, value) {
  return `[${name}="${String(value).replace(/["\\]/g, '\\$&')}"]`;
}

/** Identifies the focused control so it can be found again after the markup is replaced. */
function describeFocus() {
  const active = document.activeElement;
  if (!active || !app.contains(active)) return null;
  const focus = { selector: '', selectionStart: null, selectionEnd: null };
  const details = active.closest('details[data-details-key]');
  if (active.id) {
    focus.selector = attributeSelector('id', active.id);
  } else if (active.matches('summary') && details) {
    focus.selector = `details${attributeSelector('data-details-key', details.dataset.detailsKey)} > summary`;
  } else if (active.dataset.action) {
    const idPart = active.dataset.id ? attributeSelector('data-id', active.dataset.id) : '';
    focus.selector = `${attributeSelector('data-action', active.dataset.action)}${idPart}`;
  } else {
    return null;
  }
  if (typeof active.selectionStart === 'number') {
    focus.selectionStart = active.selectionStart;
    focus.selectionEnd = active.selectionEnd;
  }
  return focus;
}

function restoreFocus(focus) {
  if (!focus) return;
  const target = app.querySelector(focus.selector);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (focus.selectionStart !== null && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(focus.selectionStart, focus.selectionEnd);
  }
}

function render({ keepFocus = false } = {}) {
  const previousFocus = describeFocus();
  if (state.view === 'owner') {
    app.innerHTML = renderOwner(state);
    document.body.dataset.theme = state.session.workspace.settings.theme;
  } else if (state.view === 'signed-out') {
    app.innerHTML = renderSignIn(state);
    document.body.dataset.theme = 'light';
  } else if (state.view === 'error') {
    app.innerHTML = renderSessionError(state.message);
  } else {
    app.innerHTML = renderLoading();
  }
  document.body.classList.toggle('owner-body', state.view === 'owner');
  if (keepFocus || state.view === 'owner') {
    restoreFocus(previousFocus);
  } else {
    app.querySelector('input, select, button')?.focus({ preventScroll: true });
  }
}

/** Moves focus to a control that replaced the one just used, e.g. a confirmation's safe button. */
function focusAction(action, id = '') {
  const idPart = id ? attributeSelector('data-id', id) : '';
  app
    .querySelector(`${attributeSelector('data-action', action)}${idPart}`)
    ?.focus({ preventScroll: true });
}

function renderInBackground() {
  if (!isEditing() && !isManagingConnection()) render({ keepFocus: true });
}

async function refreshSession() {
  const result = await loadOwnerSession();
  if (result.status === 'signed-in') {
    state.view = 'owner';
    state.session = result.session;
    setMessage('', 'info');
    await refreshScreens();
    await refreshStore();
  } else if (result.status === 'signed-out') {
    state.view = 'signed-out';
    state.session = null;
    if (state.registering) {
      const status = await loadRegistrationStatus();
      state.registration = status.ok ? status.data : { enabled: false, available: false };
      if (!status.ok) setMessage(messageForError(status.error));
    }
  } else {
    state.view = 'error';
    setMessage(messageForError(result.error));
  }
  render();
}

function signedOut() {
  clearTimeout(storeTimer);
  screenWatchId += 1;
  state.view = 'signed-out';
  state.session = null;
  state.userChoices = new Map();
  state.screenDraft = {};
  state.settingsDraft = {};
  state.connectError = '';
}

/** Loads the connection and, when connected, the validated snapshot. */
async function refreshStore() {
  const result = await loadShopifyStatus();
  if (!state.session) return;
  if (result.ok) {
    state.store = {
      status: 'ready',
      connection: result.connection,
      snapshot: result.snapshot,
      draft: state.store.draft,
    };
    if (state.storeMessage === offlineStoreMessage) setStoreMessage('', 'info');
  } else if (result.status === 401) {
    signedOut();
    return;
  } else if (state.store.connection) {
    // Keep what is on screen but say it may be old.
    setStoreMessage(offlineStoreMessage, 'error');
  } else {
    state.store = { status: 'error', error: result.error, connection: null, snapshot: null };
  }
  scheduleStorePoll();
}

const offlineStoreMessage = messageForError('offline');

function scheduleStorePoll() {
  clearTimeout(storeTimer);
  const { connection, snapshot } = state.store;
  if (state.view !== 'owner' || !connection || connection.state !== 'connected') return;
  storeTimer = setTimeout(pollStore, snapshot ? STORE_POLL_MS : STORE_FIRST_SYNC_POLL_MS);
}

async function pollStore() {
  if (state.busy || isEditing() || isManagingConnection()) return scheduleStorePoll();
  await refreshStore();
  if (state.view === 'signed-out') render();
  else renderInBackground();
}

async function refreshScreens() {
  const result = await loadScreens();
  state.confirmRevokeId = '';
  if (result.ok) {
    state.screens = { status: 'ready', items: result.screens };
  } else {
    state.screens = { status: 'error', items: [], error: result.error };
  }
}

async function handleRequestCode(form) {
  const email = parseEmail(new FormData(form).get('email'));
  if (!email) {
    setMessage(messageForError('invalid_email'));
    return render();
  }
  state.email = email;
  const result = await requestSignInCode(email);
  if (result.ok) {
    state.step = 'code';
    setMessage('', 'info');
  } else {
    // A server without email delivery says so. Otherwise the reply is the same for every address.
    setMessage(messageForError(result.error));
  }
  render();
}

async function handleVerifyCode(form) {
  const code = parseCode(new FormData(form).get('code'));
  if (!code) {
    setMessage(messageForError('invalid_format'));
    return render();
  }
  const result = await verifySignInCode(state.email, code);
  if (!result.ok) {
    setMessage(messageForError(result.error));
    return render();
  }
  await refreshSession();
}

function adoptWorkspaceSettings({ settings, revision }) {
  state.session.workspace.settings = settings;
  state.session.workspace.revision = revision;
}

async function handleSettings(form) {
  const formData = new FormData(form);
  const settings = { period: formData.get('period'), theme: formData.get('theme') };
  const { csrfToken } = state.session;
  const result = await saveWorkspaceSettings({
    csrfToken,
    settings,
    revision: state.session.workspace.revision,
  });
  if (result.ok) {
    adoptWorkspaceSettings(result.data);
    state.settingsDraft = {};
    setMessage('Saved for this workspace.', 'info');
  } else if (result.status === 409) {
    adoptWorkspaceSettings(result.data);
    state.settingsDraft = {};
    setMessage(messageForError('conflict'));
  } else {
    setMessage(messageForError(result.error));
  }
  render();
}

async function handleConnectShopify(form) {
  const storeText = String(new FormData(form).get('store') ?? '');
  state.store.draft = storeText;
  if (!parseStoreDomain(storeText)) {
    state.connectError = messageForError('invalid_store');
    return render();
  }
  state.storeAction = 'connecting';
  state.connectError = '';
  setStoreMessage('', 'info');
  render();
  const result = await startShopifyConnection({
    csrfToken: state.session.csrfToken,
    storeText,
    callbackUrl: `${window.location.origin}${SHOPIFY_CALLBACK_PATH}`,
  });
  if (result.ok) {
    // The address passed the shared Shopify-only check; Shopify takes over from here.
    window.location.assign(result.authorizationUrl);
    return;
  }
  state.storeAction = '';
  if (result.error === 'unauthenticated') return handleExpiredSession();
  state.connectError = messageForError(result.error);
  await refreshStore();
  render();
}

function handleExpiredSession() {
  signedOut();
  state.step = 'email';
  setMessage(messageForError('unauthenticated'));
  render();
}

async function handleDisconnectShopify() {
  state.storeAction = 'disconnecting';
  render();
  const result = await disconnectShopify({ csrfToken: state.session.csrfToken });
  state.storeAction = '';
  state.confirmDisconnect = false;
  state.userChoices.delete('connection');
  if (result.ok) {
    setStoreMessage('Disconnected from MetricTV. The app is still installed in Shopify.', 'info');
  } else {
    setStoreMessage(messageForError(result.error));
  }
  await refreshStore();
  render();
}

async function handleBoardPeriod(period) {
  const result = await saveWorkspaceSettings({
    csrfToken: state.session.csrfToken,
    settings: { period },
    revision: state.session.workspace.revision,
  });
  if (result.ok || result.status === 409) {
    adoptWorkspaceSettings(result.data);
    delete state.settingsDraft.period;
  } else {
    setMessage(messageForError(result.error));
  }
  render();
}

async function watchForNewScreen(previousCount) {
  screenWatchId += 1;
  const watchId = screenWatchId;
  for (let attempt = 0; attempt < SCREEN_WATCH_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, SCREEN_WATCH_MS));
    if (watchId !== screenWatchId || state.view !== 'owner') return;
    await refreshScreens();
    if (state.screens.items.length > previousCount) {
      setScreenMessage('The screen is connected.', 'info');
      return renderInBackground();
    }
  }
  if (watchId !== screenWatchId || state.view !== 'owner') return;
  setScreenMessage(
    'Approved, but the screen has not connected yet. Use Refresh list once the TV shows its board.',
    'info',
  );
  renderInBackground();
}

async function handlePairScreen(form) {
  const formData = new FormData(form);
  const code = parsePairingCode(formData.get('code'));
  state.screenDraft = {
    code: String(formData.get('code') ?? ''),
    name: String(formData.get('name') ?? ''),
  };
  if (!code) {
    setPairMessage(messageForError('invalid_pairing_format'));
    return render();
  }
  const name = String(formData.get('name') ?? '').trim();
  const result = await pairScreen({ csrfToken: state.session.csrfToken, code, name });
  const previousCount = state.screens.items.length;
  if (result.ok) {
    state.screenDraft = {};
    state.userChoices.delete('add-screen');
    setPairMessage('', 'info');
    setScreenMessage(
      'Approved. The screen appears in the list once the TV finishes connecting, usually within a few seconds.',
      'info',
    );
  } else {
    setPairMessage(messageForError(result.error));
  }
  await refreshScreens();
  render();
  if (result.ok) void watchForNewScreen(previousCount);
}

async function handleRevokeScreen(id) {
  const result = await revokeScreen({ csrfToken: state.session.csrfToken, id });
  const isGone = result.ok || result.status === 404;
  if (isGone) setScreenMessage('Screen removed.', 'info');
  else setScreenMessage(messageForError(result.error));
  await refreshScreens();
  render();
}

async function handleSignOut() {
  const result = await signOut(state.session.csrfToken);
  if (!result.ok && result.status !== 401) {
    setMessage(messageForError(result.error));
    return render();
  }
  signedOut();
  state.step = 'email';
  setMessage('You are signed out.', 'info');
  render();
}

const FORM_HANDLERS = Object.freeze({
  'request-code': handleRequestCode,
  'verify-code': handleVerifyCode,
  settings: handleSettings,
  'connect-shopify': handleConnectShopify,
  'pair-screen': handlePairScreen,
});

async function runExclusively(task) {
  if (state.busy) return;
  state.busy = true;
  try {
    await task();
  } finally {
    state.busy = false;
  }
}

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const handler = hasOwn(FORM_HANDLERS, form.dataset.form)
    ? FORM_HANDLERS[form.dataset.form]
    : null;
  if (handler) void runExclusively(() => handler(form));
});

// Remember typed text per form; the markup is replaced on every render.
const DRAFT_STORES = Object.freeze({
  'pair-screen': () => state.screenDraft,
  settings: () => state.settingsDraft,
});

app.addEventListener('input', (event) => {
  const field = event.target;
  const form = field.closest?.('form[data-form]');
  if (!form || !field.name) return;
  if (form.dataset.form === 'connect-shopify') {
    state.store.draft = field.value;
    return;
  }
  if (hasOwn(DRAFT_STORES, form.dataset.form)) {
    DRAFT_STORES[form.dataset.form]()[field.name] = field.value;
  }
});

app.addEventListener('change', (event) => {
  // The board's own period picker saves the same workspace setting as the Appearance form.
  if (event.target.id === 'period') {
    void runExclusively(() => handleBoardPeriod(event.target.value));
  }
});

// Clicking a <summary> toggles its <details>; remember the new state as the owner's choice.
function rememberDetailsChoice(target) {
  const details = target.closest('summary')?.closest('details[data-details-key]');
  if (details) state.userChoices.set(details.dataset.detailsKey, !details.open);
}

async function refreshScreensAndRender() {
  await refreshScreens();
  render();
}

function askToRevokeScreen(id) {
  state.confirmRevokeId = id;
  render();
  focusAction('cancel-revoke');
}

function cancelRevokeScreen() {
  const revokedId = state.confirmRevokeId;
  state.confirmRevokeId = '';
  render();
  focusAction('revoke-screen', revokedId);
}

function askToDisconnectShopify() {
  state.confirmDisconnect = true;
  render();
  focusAction('disconnect-shopify-cancel');
}

function cancelDisconnectShopify() {
  state.confirmDisconnect = false;
  render();
  focusAction('disconnect-shopify-ask');
}

function showEmailStep() {
  state.step = 'email';
  setMessage('', 'info');
  render();
}

// What each button with a data-action does. Whatever talks to the server runs exclusively, so a
// double click cannot send a request twice; asking for a confirmation only redraws the page.
const CLICK_ACTIONS = Object.freeze({
  'sign-out': () => runExclusively(handleSignOut),
  retry: () => runExclusively(refreshSession),
  'refresh-store': () => runExclusively(refreshSession),
  'refresh-screens': () => runExclusively(refreshScreensAndRender),
  'revoke-screen': (button) => askToRevokeScreen(button.dataset.id),
  'cancel-revoke': cancelRevokeScreen,
  'confirm-revoke': (button) => runExclusively(() => handleRevokeScreen(button.dataset.id)),
  'disconnect-shopify-ask': askToDisconnectShopify,
  'disconnect-shopify-cancel': cancelDisconnectShopify,
  'disconnect-shopify-confirm': () => runExclusively(handleDisconnectShopify),
  'change-email': showEmailStep,
});

app.addEventListener('click', (event) => {
  rememberDetailsChoice(event.target);
  const button = event.target.closest('[data-action]');
  if (button && hasOwn(CLICK_ACTIONS, button.dataset.action)) {
    void CLICK_ACTIONS[button.dataset.action](button);
  }
});

function readShopifyReturn() {
  const { result, cleanedUrl } = consumeShopifyReturn({
    search: window.location.search,
    hash: window.location.hash,
    pathname: window.location.pathname,
  });
  if (cleanedUrl === null) return;
  state.shopifyReturn = result;
  window.history.replaceState(null, '', cleanedUrl);
}

readShopifyReturn();
render();
void runExclusively(refreshSession);
