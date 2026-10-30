// TV page controller. A TV is either waiting with a pairing code or showing its paired state.
// Whenever access ends (revoked, expired, cleared cookie) the page drops everything it held and
// asks for a new code. No browser storage; the credentials are HttpOnly cookies.
import {
  createChallenge,
  exchangePairing,
  isNewAppVersion,
  loadDisplay,
  loadPairing,
} from './tv-client.js';
import {
  messageForTvError,
  renderConnecting,
  renderPaired,
  renderTvError,
  renderTvLoading,
  renderWaiting,
} from './tv-view.js';

const PAIRING_POLL_MS = 3000;
const DISPLAY_POLL_MS = 10000;
const RETRY_MS = 15000;

const app = document.querySelector('#app');
let timer = null;
let lastDisplay = null;
// The TV's own clock may be wrong. Data age is judged on the server's clock, advanced by the
// time elapsed here since the answer arrived.
let serverClock = null;
// Page code version this page was loaded with; a newer one from the server triggers a reload.
let loadedAppVersion = null;

function showHtml(html, theme = 'light') {
  app.innerHTML = html;
  document.body.dataset.theme = theme;
}

function schedule(task, delayMs) {
  clearTimeout(timer);
  timer = setTimeout(() => runSafely(task), delayMs);
}

// An unattended screen must never stop on a surprise: say so on screen, and start over later.
async function runSafely(task) {
  try {
    await task();
  } catch {
    showHtml(renderTvError(messageForTvError('unexpected')));
    schedule(start, RETRY_MS);
  }
}

function serverNow() {
  if (serverClock === null) return Date.now();
  return serverClock.serverMs + (Date.now() - serverClock.receivedMs);
}

/** Reloads the page when new page code was deployed. Returns true when a reload started. */
function reloadIfUpdated(display) {
  if (isNewAppVersion(loadedAppVersion, display)) {
    window.location.reload();
    return true;
  }
  if (loadedAppVersion === null && typeof display.appVersion === 'string') {
    loadedAppVersion = display.appVersion;
  }
  return false;
}

function showPaired(display) {
  lastDisplay = display;
  const serverMs = Date.parse(display.serverTime);
  serverClock = Number.isFinite(serverMs) ? { serverMs, receivedMs: Date.now() } : null;
  showHtml(renderPaired({ display, notice: '', now: serverNow() }), display.settings.theme);
}

async function beginPairing(notice = '') {
  const result = await createChallenge();
  if (!result.ok) {
    showHtml(renderTvError(messageForTvError(result.error)));
    return schedule(() => beginPairing(), RETRY_MS);
  }
  lastDisplay = null;
  serverClock = null;
  showHtml(renderWaiting({ code: result.data.code, message: notice }));
  schedule(pollPairing, PAIRING_POLL_MS);
}

async function pollPairing() {
  const pairing = await loadPairing();
  if (pairing.status === 404) return beginPairing();
  if (!pairing.ok) return schedule(pollPairing, PAIRING_POLL_MS);
  if (pairing.data.state !== 'approved') return schedule(pollPairing, PAIRING_POLL_MS);

  showHtml(renderConnecting());
  const exchange = await exchangePairing();
  if (!exchange.ok) return beginPairing();
  await refreshDisplay();
}

async function refreshDisplay() {
  const result = await loadDisplay();
  if (result.status === 'unpaired') return beginPairing();
  if (result.status === 'error') {
    // Keep showing the last board, but say that it may be out of date.
    if (lastDisplay) {
      const notice = 'Connection lost. These figures may not be the latest.';
      const html = renderPaired({ display: lastDisplay, notice, now: serverNow() });
      showHtml(html, lastDisplay.settings.theme);
    }
    return schedule(refreshDisplay, DISPLAY_POLL_MS);
  }
  if (reloadIfUpdated(result.display)) return;
  showPaired(result.display);
  schedule(refreshDisplay, DISPLAY_POLL_MS);
}

async function start() {
  showHtml(renderTvLoading());
  const result = await loadDisplay();
  if (result.status === 'paired') {
    if (reloadIfUpdated(result.display)) return;
    showPaired(result.display);
    return schedule(refreshDisplay, DISPLAY_POLL_MS);
  }
  if (result.status === 'unpaired') return beginPairing();
  showHtml(renderTvError(messageForTvError(result.error)));
  schedule(start, RETRY_MS);
}

void runSafely(start);
