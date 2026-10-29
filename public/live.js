// Live entry point: owns state, events and the polling loop.
// Networking is in live-client.js and rendering in live-view.js / board.js.
// This file never imports fixtures. Only display preferences go to localStorage;
// the snapshot is kept in memory and authorization stays on the server.
import { BRAND_NAME, createDialog, createToast, toggleFullscreen } from './ui.js';
import {
  fetchSnapshot,
  fetchConnection,
  startAuthorization,
  disconnectLocally,
  consumeCallbackResult,
  connectionAllowsSnapshot,
} from './live-client.js';
import { renderLivePage, buildDefinitionDialog, normalizePeriod } from './live-view.js';
import { createSettingsSync, SETTINGS_MESSAGES } from './live-settings-client.js';

// Preserve preferences saved before the MetricTV rename.
const PREFERENCE_KEY = 'stillboard-live-v1';
const POLL_INTERVAL_MS = 30000;
const TV_IDLE_MS = 7000;

const appElement = document.querySelector('#app');
const showToast = createToast(document.querySelector('#toast'), 4000);
const dialog = createDialog({
  dialog: document.querySelector('#info-dialog'),
  content: document.querySelector('#dialog-content'),
  closeButton: document.querySelector('#close-dialog'),
});

const CONNECTION_DENIALS = ['reconnect_required', 'not_connected', 'setup_required'];

let snapshot = null;
let unavailableMessage = '';
let isFetching = false;
let refreshQueued = false;
// Connection status from the server. The CSRF token lives only in this variable:
// never in the DOM, localStorage, URLs or logs.
let connection = null;
let csrfToken = '';
let connectionAction = { busy: '', error: '', confirmingDisconnect: false };
let callbackResult = '';
// Bumped whenever credentials change locally, so a snapshot requested before a
// disconnect can never repopulate the screen afterwards.
let credentialGeneration = 0;
let period = 'week';
let theme = 'light';
let controlsTimer;

// Shared period/theme, active only when the server offers /api/settings (opt-in). Otherwise
// the preferences above stay local to this browser, exactly as before.
const settingsSync = createSettingsSync({
  getLocalSettings: () => ({ period, theme }),
  applySettings: (settings) => {
    period = normalizePeriod(settings.period);
    theme = settings.theme === 'dark' ? 'dark' : 'light';
    savePreferences();
    render();
  },
  notify: (kind) => showToast(SETTINGS_MESSAGES[kind]),
});

loadPreferences();
consumeCallbackFromUrl();

// The server redirects back with ?connection=connected|failed. Read it once, show a
// fixed message and remove it from the address bar so reloads do not repeat it.
function consumeCallbackFromUrl() {
  const { result, cleanedUrl } = consumeCallbackResult({
    search: location.search,
    hash: location.hash,
    pathname: location.pathname,
  });
  if (cleanedUrl === null) return;
  callbackResult = result;
  history.replaceState(null, '', cleanedUrl);
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || '{}');
    period = normalizePeriod(saved.period);
    if (saved.theme === 'dark') theme = 'dark';
  } catch {
    // Preferences are optional.
  }
}

function savePreferences() {
  try {
    localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ period, theme }));
  } catch {
    // Storage restrictions do not block the board.
  }
}

function currentRoute() {
  if (location.hash === '#/tv') return 'tv';
  if (location.hash === '#/connections') return 'connections';
  return 'dashboard';
}

function render() {
  if (location.hash === '#main') {
    document.querySelector('main')?.focus();
    return;
  }
  const route = currentRoute();
  const focusedId = document.activeElement?.id;
  document.body.classList.toggle('tv-active', route === 'tv');
  // View code escapes every snapshot value it interpolates.
  appElement.innerHTML = renderLivePage({
    snapshot,
    unavailableMessage,
    connection,
    connectionAction,
    callbackResult,
    period,
    theme,
    route,
    now: Date.now(),
  });
  const shopName = snapshot ? snapshot.shop.name : 'Connecting';
  document.title = `${BRAND_NAME} · ${shopName}${route === 'tv' ? ' · TV' : ''}`;
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

function clearSnapshot() {
  snapshot = null;
}

/** Applies fresh connection status. Returns false when the status could not be read. */
async function refreshConnection() {
  const outcome = await fetchConnection();
  if (outcome.status === 'ok') {
    connection = outcome.connection;
    csrfToken = outcome.csrfToken;
    // Losing the grant clears every figure immediately.
    if (!connectionAllowsSnapshot(connection)) clearSnapshot();
    return true;
  }
  if (outcome.status === 'unauthorized') {
    connection = null;
    csrfToken = '';
    clearSnapshot();
    unavailableMessage = outcome.message;
    return false;
  }
  if (outcome.status === 'offline') {
    unavailableMessage = outcome.message;
    return false;
  }
  // 'error': an older server without the connection API keeps the snapshot-only board.
  return true;
}

async function refresh() {
  if (isFetching) {
    refreshQueued = true;
    return;
  }
  isFetching = true;
  const generation = credentialGeneration;
  // Independent of Shopify status; it never blocks or delays the snapshot.
  void settingsSync.load();
  try {
    const hasStatus = await refreshConnection();
    if (generation !== credentialGeneration) return;
    if (!hasStatus || !connectionAllowsSnapshot(connection)) {
      if (hasStatus) unavailableMessage = '';
      return;
    }
    const outcome = await fetchSnapshot();
    // Discard a response that started before a disconnect or reconnect.
    if (generation !== credentialGeneration) return;
    if (outcome.status === 'ok') {
      snapshot = outcome.snapshot;
      unavailableMessage = '';
      return;
    }
    // Revoked access clears every metric. Other failures keep the last snapshot, labelled stale.
    if (outcome.status === 'unauthorized') clearSnapshot();
    // Connection-related denial: clear figures now. The owner-gated status endpoint read
    // at the start of this refresh stays authoritative for the page; this text is only a
    // fallback explanation (no immediate re-poll, so a disagreement cannot loop).
    if (CONNECTION_DENIALS.includes(outcome.status)) clearSnapshot();
    unavailableMessage = outcome.message;
  } finally {
    isFetching = false;
    render();
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  }
}

function resetConnectionAction(overrides = {}) {
  connectionAction = { busy: '', error: '', confirmingDisconnect: false, ...overrides };
}

async function startConnect() {
  if (connectionAction.busy || !connection) return;
  callbackResult = '';
  resetConnectionAction({ busy: 'starting' });
  render();
  const outcome = await startAuthorization({ connection, csrfToken });
  if (outcome.status === 'ok') {
    // Validated by live-client: HTTPS, exact configured store, fixed authorize path.
    window.location.assign(outcome.authorizationUrl);
    return;
  }
  resetConnectionAction({ error: outcome.message });
  render();
  // A rejected security token or changed server mode needs fresh status.
  if (outcome.status !== 'offline') refresh();
}

async function confirmDisconnect() {
  if (connectionAction.busy) return;
  resetConnectionAction({ busy: 'disconnecting', confirmingDisconnect: true });
  render();
  const outcome = await disconnectLocally({ csrfToken });
  if (outcome.status !== 'ok') {
    resetConnectionAction({ error: outcome.message, confirmingDisconnect: true });
    render();
    if (outcome.status !== 'offline') refresh();
    return;
  }
  credentialGeneration += 1;
  clearSnapshot();
  unavailableMessage = '';
  callbackResult = '';
  resetConnectionAction();
  render();
  showToast('Disconnected locally. The app is still installed in Shopify.');
  refresh();
}

function revealControls() {
  document.documentElement.classList.remove('tv-idle');
  clearTimeout(controlsTimer);
  if (currentRoute() === 'tv') {
    controlsTimer = setTimeout(() => document.documentElement.classList.add('tv-idle'), TV_IDLE_MS);
  }
}

appElement.addEventListener('change', (event) => {
  if (event.target.id !== 'period') return;
  period = normalizePeriod(event.target.value);
  savePreferences();
  render();
  void settingsSync.change({ period });
});

appElement.addEventListener('submit', (event) => {
  if (!event.target.matches('[data-connect-form]')) return;
  event.preventDefault();
  startConnect();
});

appElement.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  switch (button.dataset.action) {
    case 'retry':
      await refresh();
      break;
    case 'disconnect-ask':
      resetConnectionAction({ confirmingDisconnect: true });
      render();
      document.getElementById('disconnect-cancel')?.focus();
      break;
    case 'disconnect-cancel':
      resetConnectionAction();
      render();
      document.querySelector('[data-action="disconnect-ask"]')?.focus();
      break;
    case 'disconnect-confirm':
      await confirmDisconnect();
      break;
    case 'dismiss-notice':
      callbackResult = '';
      render();
      break;
    case 'theme':
      theme = theme === 'light' ? 'dark' : 'light';
      savePreferences();
      render();
      void settingsSync.change({ theme });
      break;
    case 'definition':
      if (snapshot) dialog.open({ ...buildDefinitionDialog(snapshot), opener: button });
      break;
    case 'fullscreen':
      if (!(await toggleFullscreen()))
        showToast('Full screen is unavailable. TV mode still works in the browser.');
      break;
  }
});

window.addEventListener('hashchange', () => {
  // A callback message or unfinished confirmation should not follow the user around.
  if (currentRoute() !== 'connections') {
    callbackResult = '';
    if (!connectionAction.busy) resetConnectionAction();
  }
  render();
});
window.addEventListener('pageshow', (event) => {
  // Returning from Shopify with the back button restores a stuck "Opening Shopify" state.
  if (event.persisted && connectionAction.busy === 'starting') {
    resetConnectionAction();
    render();
  }
});
window.addEventListener('hashchange', revealControls);
window.addEventListener('pointermove', revealControls, { passive: true });
window.addEventListener('keydown', revealControls);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && currentRoute() === 'tv' && !dialog.isOpen)
    location.hash = '#/dashboard';
  if (event.key === 'Escape' && connectionAction.confirmingDisconnect && !connectionAction.busy) {
    resetConnectionAction();
    render();
  }
});
window.addEventListener('online', refresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

render();
revealControls();
refresh();
// This polls the small local cache, not Shopify. Shopify collection is server-side.
setInterval(refresh, POLL_INTERVAL_MS);
