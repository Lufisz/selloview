// Pure HTML for the TV page. Every dynamic value is escaped here, whoever supplied it.
import { escapeHtml, hasOwn } from '../shared/format.js';
import { BRAND_NAME, brandLink, statusDot, tvShell } from '../shared/ui.js';
import { PERIODS, normalizePeriod } from '../shared/periods.js';
import { renderBoard } from '../shared/board.js';
import { buildStoreBoardModel } from '../shared/board-model.js';
import { isUsableSnapshot } from '../shared/snapshot-validation.js';

const TV_MESSAGES = Object.freeze({
  offline: 'Cannot reach the server. Trying again shortly.',
  rate_limited: 'Too many requests from this network. Trying again shortly.',
  busy: 'Pairing is busy right now. Trying again shortly.',
  unexpected: 'Something went wrong. Trying again shortly.',
});

// Served by MetricTV itself; the version in the address lets the TV cache the image safely.
const LOGO_PATH = '/api/display/logo';
const LOGO_VERSION_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export function messageForTvError(code) {
  return hasOwn(TV_MESSAGES, code) ? TV_MESSAGES[code] : TV_MESSAGES.unexpected;
}

function tvPage(boardHtml, dark, { showTopbar = true } = {}) {
  return tvShell({
    brandHtml: brandLink({ href: '/tv', label: `${BRAND_NAME} TV` }),
    controlsHtml: '',
    boardHtml,
    dark,
    showTopbar,
  });
}

/** @param {{code: string, message: string}} state  `message` is empty or a retry notice. */
export function renderWaiting({ code, message }) {
  const notice = message ? `<p class="field-error" role="alert">${escapeHtml(message)}</p>` : '';
  return tvPage(
    `<section class="board tv-card" aria-labelledby="tv-title">
      <p class="eyebrow"><span class="tiny-line"></span>NOT PAIRED</p>
      <h1 id="tv-title">Pair this screen.</h1>
      <p class="tv-steps">Sign in to MetricTV on your phone or computer, open <strong>Screens</strong> and enter this code.</p>
      <p class="tv-code" aria-label="Pairing code">${escapeHtml(code)}</p>
      <p class="field-hint">The code works once and expires in 5 minutes. A new one appears by itself. Approving it does not show it to anyone else.</p>
      ${notice}
    </section>`,
    false,
  );
}

export function renderConnecting() {
  return tvPage(
    `<section class="board tv-card"><h1>Connecting.</h1><p class="tv-steps">This screen was approved. Finishing the pairing.</p></section>`,
    false,
  );
}

// What a paired screen says when it has no figures to show. None of these is sample data.
const STORE_STATE_MESSAGES = Object.freeze({
  setup_required: 'Store connection is not set up on this server yet.',
  owner_not_allowed: 'Store connection is not available for this workspace.',
  not_connected: 'No store is connected. Connect one from your MetricTV workspace page.',
  reconnect_required:
    'Store access ended. Reconnect the store from your MetricTV workspace page to see figures again.',
  connected: 'Connected. Waiting for the first figures from the store.',
  connected_failed: 'Connected, but the store could not be read yet. Trying again shortly.',
});

function storeStateKey({ state, sync }) {
  if (state === 'connected' && sync && sync.state === 'error') return 'connected_failed';
  return hasOwn(STORE_STATE_MESSAGES, state) ? state : 'not_connected';
}

function noticeHtml(notice) {
  return notice ? `<p class="field-error" role="status">${escapeHtml(notice)}</p>` : '';
}

function renderUnavailableMessage(display, notice) {
  const periodLabel = PERIODS[normalizePeriod(display.settings.period)].settingsLabel;
  const stateKey = storeStateKey(display.storeConnection);
  return tvPage(
    `<section class="board tv-card" aria-labelledby="tv-title">
      <p class="eyebrow"><span class="tiny-line"></span>PAIRED</p>
      <h1 id="tv-title">${statusDot()} ${escapeHtml(display.screen.name)}</h1>
      <div class="tv-notice" data-store-state="${escapeHtml(display.storeConnection.state)}">
        <h2>No figures to show</h2>
        <p>${escapeHtml(STORE_STATE_MESSAGES[stateKey])} Nothing on this screen is sample or placeholder data.</p>
      </div>
      <p class="field-hint">Reporting period: ${escapeHtml(periodLabel)}. Appearance updates here automatically.</p>
      ${noticeHtml(notice)}
    </section>`,
    display.settings.theme === 'dark',
  );
}

/** Board metrics without the "How is this defined" button: the TV has no dialog to open. */
function withoutHelp(model) {
  const metrics = model.metrics.map((metric) => ({ ...metric, help: undefined }));
  return { ...model, metrics };
}

/** Address of the store logo, or '' when the store has none and the name is shown instead. */
function logoUrlFor(shop) {
  const version = shop.logoVersion;
  if (typeof version !== 'string' || !LOGO_VERSION_PATTERN.test(version)) return '';
  return `${LOGO_PATH}?v=${version}`;
}

// The server sends at most 8 orders and 3 grouped alerts, so both lists fit beside the chart.
function renderBoardScreen(display, notice, now) {
  const boardModel = withoutHelp(
    buildStoreBoardModel({
      snapshot: display.board,
      period: normalizePeriod(display.settings.period),
      unavailableMessage: '',
      now,
      compact: true,
    }),
  );
  const model = { ...boardModel, logoUrl: logoUrlFor(display.board.shop) };
  const boardHtml = renderBoard(model, { tv: true, tvOrders: true, controls: false });
  return tvPage(`${boardHtml}${noticeHtml(notice)}`, display.settings.theme === 'dark', {
    showTopbar: false,
  });
}

/**
 * @param {{display: {screen: {name: string}, settings: {period: string, theme: string},
 *   storeConnection: {state: string}, board?: object}, notice: string, now?: number}} state
 *   `now` is the server's clock as of this render, so a TV with a wrong clock still judges
 *   stale data correctly.
 */
export function renderPaired({ display, notice, now = Date.now() }) {
  const canShowBoard =
    display.storeConnection.state === 'connected' &&
    isUsableSnapshot(display.board, { requireStoreDomain: false });
  if (canShowBoard) return renderBoardScreen(display, notice, now);
  if (display.board !== undefined) {
    return renderTvError('This screen received data it cannot show, so no figures are displayed.');
  }
  return renderUnavailableMessage(display, notice);
}

export function renderTvError(message) {
  return tvPage(
    `<section class="board tv-card"><h1>Cannot load this screen.</h1><p class="field-error" role="alert">${escapeHtml(message)}</p></section>`,
    false,
  );
}

export function renderTvLoading() {
  return tvPage(`<section class="board tv-card"><h1>Loading.</h1></section>`, false);
}
