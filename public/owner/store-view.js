// Pure HTML for the owner's store connection on the owner page. Every dynamic value is escaped here.
import { escapeHtml, formatDateTime } from '../shared/format.js';
import { actionButton, statusDot } from '../shared/ui.js';
import { renderBoard } from '../shared/board.js';
import { buildStoreBoardModel, normalizePeriod } from '../shared/board-model.js';
import { messageForError } from './owner-client.js';

const RETURN_MESSAGES = Object.freeze({
  connected: 'Shopify approved the connection. MetricTV is reading the first figures now.',
  failed: 'Shopify authorization did not finish. Nothing was changed. You can try again.',
});

const STATE_HEADINGS = Object.freeze({
  loading: 'Checking the store connection',
  setup_required: 'Store connection is not set up yet',
  owner_not_allowed: 'Store connection is not available for this account',
  not_connected: 'No store connected',
  connected: 'Store connected',
  reconnect_required: 'Reconnect your store',
});

function messageHtml(message, tone) {
  if (!message) return '';
  const role = tone === 'error' ? 'alert' : 'status';
  return `<p class="form-message ${tone === 'error' ? 'field-error' : 'field-hint'}" role="${role}">${escapeHtml(message)}</p>`;
}

function syncSummary(connection, snapshot) {
  const sync = connection.sync;
  if (!sync || sync.state === 'loading') {
    return 'Authorized. The first read from Shopify is running, so there are no figures yet. This page checks again by itself.';
  }
  if (!snapshot) {
    return 'Shopify could not be read yet. No figures are shown. MetricTV tries again by itself.';
  }
  const updated = formatDateTime(snapshot.fetchedAt, snapshot.shop.timeZone);
  if (sync.state === 'ok') return `Figures updated ${updated} (${snapshot.shop.timeZone}).`;
  return `These are the last successful figures, from ${updated}. The latest read failed or is overdue, so they may be out of date.`;
}

/**
 * Open state for a native <details>. `userChoices` maps a details key to what the owner last
 * chose, so a background re-render does not close a panel being used. `fallback` is the state
 * before any choice; `forced` keeps a panel open while it holds a pending decision.
 * @param {Map<string, boolean>|undefined} userChoices
 */
export function detailsOpenAttribute(userChoices, key, { fallback = false, forced = false } = {}) {
  if (forced) return ' open';
  const hasChoice = userChoices instanceof Map && userChoices.has(key);
  const isOpen = hasChoice ? userChoices.get(key) : fallback;
  return isOpen ? ' open' : '';
}

function connectFormHtml({ connection, store, busy, error }) {
  const isReconnect = connection.state !== 'not_connected';
  const label = isReconnect ? 'Reconnect Shopify' : 'Connect Shopify';
  const isBusy = busy === 'connecting';
  const value = store.draft === undefined ? connection.store : store.draft;
  return `<form class="stacked-form owner-connect-form" data-form="connect-shopify" novalidate>
    <label for="owner-store">Shopify store address</label>
    <input id="owner-store" name="store" type="text" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="your-store.myshopify.com" value="${escapeHtml(value)}" required>
    ${error ? messageHtml(error, 'error') : ''}
    <p class="field-hint">You will sign in and approve read-only access in Shopify, then return here. MetricTV cannot change your orders, products or stock.</p>
    <button class="button ${isReconnect ? 'secondary' : 'primary'} small" type="submit"${isBusy ? ' disabled aria-busy="true"' : ''}>${isBusy ? 'Opening Shopify…' : escapeHtml(label)}</button>
  </form>`;
}

function disconnectHtml({ confirming, busy }) {
  if (!confirming) {
    return actionButton({
      action: 'disconnect-shopify-ask',
      label: 'Disconnect…',
      className: 'button secondary small',
    });
  }
  const isBusy = busy === 'disconnecting';
  return `<div class="owner-confirm" role="group" aria-label="Confirm disconnect">
    <p>Disconnecting deletes the saved Shopify access from this MetricTV server and clears the figures here and on your screens. It does not uninstall the app in Shopify.</p>
    <div class="screen-actions">
      ${actionButton({ action: 'disconnect-shopify-confirm', label: isBusy ? 'Disconnecting…' : 'Disconnect', className: 'button primary small' })}
      ${actionButton({ action: 'disconnect-shopify-cancel', label: 'Keep it connected', className: 'button secondary small' })}
    </div>
  </div>`;
}

/**
 * How the connected store is doing. Healthy is only claimed for a successful, fresh read;
 * a first read in progress is neutral; anything else (stale, failed, overdue) is a warning.
 */
function connectedHealth(connection, snapshot) {
  const syncState = connection.sync?.state;
  if (syncState === 'loading' || !connection.sync) {
    return { tone: 'neutral', heading: 'Store connected, first read running' };
  }
  if (syncState === 'ok' && snapshot) return { tone: 'healthy', heading: 'Store connected' };
  return { tone: 'warning', heading: 'Store connected, figures may be out of date' };
}

function connectionDetailHtml(state) {
  const { store, userChoices, storeAction, confirmDisconnect } = state;
  // A pending decision or a form error must be seen, so it opens the disclosure.
  const needsAttention = confirmDisconnect || Boolean(storeAction) || Boolean(state.connectError);
  const open = detailsOpenAttribute(userChoices, 'connection', { forced: needsAttention });
  const reconnectForm = confirmDisconnect
    ? ''
    : connectFormHtml({
        connection: store.connection,
        store,
        busy: storeAction,
        error: state.connectError,
      });
  return `<details class="owner-manage" data-details-key="connection"${open}>
    <summary>Manage connection details</summary>
    <div class="owner-manage-body">
      ${reconnectForm}
      <div class="owner-disconnect">${disconnectHtml({ confirming: confirmDisconnect, busy: storeAction })}</div>
    </div>
  </details>`;
}

/** Per connection state: tone, heading, body text and whether a visible connect form follows. */
function stripContent(state) {
  const { store } = state;
  const connection = store.connection;
  const formHtml = connectFormHtml({
    connection,
    store,
    busy: state.storeAction,
    error: state.connectError,
  });
  switch (connection.state) {
    case 'setup_required':
      return {
        tone: 'neutral',
        detail:
          'This server has no Shopify app configuration, so a store cannot be connected. Nothing on this page is sample or live store data.',
      };
    case 'owner_not_allowed':
      return {
        tone: 'neutral',
        detail:
          'Only the owner this server is set up for can connect a store. Your workspace has no store connected and shows no figures. Nothing on this page is sample or live store data.',
      };
    case 'not_connected':
      return {
        tone: 'neutral',
        detail:
          'Connect your Shopify store to see a read-only overview of orders and stock. Nothing on this page is sample data.',
        bodyHtml: formHtml,
      };
    case 'reconnect_required':
      return {
        tone: 'warning',
        detail: 'Shopify access ended or was revoked. Figures are hidden until you reconnect.',
        bodyHtml: `${formHtml}
          <div class="owner-disconnect">${disconnectHtml({ confirming: state.confirmDisconnect, busy: state.storeAction })}</div>`,
      };
    default: {
      const health = connectedHealth(connection, store.snapshot);
      return {
        tone: health.tone,
        heading: health.heading,
        detail: `${connection.store} · ${syncSummary(connection, store.snapshot)}`,
        manageHtml: connectionDetailHtml(state),
      };
    }
  }
}

/**
 * The connection strip: one compact status line. A connected store keeps reconnect and
 * disconnect behind a native "Manage connection" disclosure; other states show what they need.
 * @param {{store: {status: string, connection: object|null, snapshot: object|null, draft?: string},
 *   storeMessage: string, storeTone: string, shopifyReturn: string, confirmDisconnect: boolean,
 *   storeAction: ''|'connecting'|'disconnecting', connectError?: string,
 *   userChoices?: Map<string, boolean>}} state
 */
export function renderStorePanel(state) {
  const { store } = state;
  // "Approved" is only believed while the server also reports a connection.
  const returnIsBelieved =
    state.shopifyReturn === 'failed' ||
    (state.shopifyReturn === 'connected' && store.connection?.state === 'connected');
  const returned = returnIsBelieved ? RETURN_MESSAGES[state.shopifyReturn] : '';
  const returnTone = state.shopifyReturn === 'failed' ? 'error' : 'info';
  if (store.status === 'loading' || !store.connection) {
    const isError = store.status === 'error';
    const text = isError ? messageForError(store.error) : 'Loading.';
    const tone = isError ? 'error' : 'info';
    return `<div class="owner-strip is-${isError ? 'warning' : 'neutral'}" data-store-state="loading">
      <div class="owner-strip-main">
        <h2>${escapeHtml(STATE_HEADINGS.loading)}</h2>
        ${messageHtml(text, tone)}
      </div>
      ${isError ? actionButton({ action: 'refresh-store', label: 'Try again', className: 'button secondary small' }) : ''}
    </div>`;
  }
  const { connection } = store;
  const content = stripContent(state);
  const heading = content.heading ?? STATE_HEADINGS[connection.state];
  const dotTone = { healthy: '', neutral: 'neutral', warning: 'amber' }[content.tone];
  const syncState = connection.sync?.state ?? '';
  return `<div class="owner-strip is-${content.tone}" data-store-state="${escapeHtml(connection.state)}" data-sync-state="${escapeHtml(syncState)}">
    <div class="owner-strip-main">
      <h2>${statusDot(dotTone)} ${escapeHtml(heading)}</h2>
      <p>${escapeHtml(content.detail)}</p>
    </div>
    ${content.manageHtml ?? ''}
    ${content.bodyHtml ? `<div class="owner-strip-body">${content.bodyHtml}</div>` : ''}
    ${messageHtml(returned, returnTone)}
    ${messageHtml(state.storeMessage, state.storeTone)}
  </div>`;
}

/** The read-only board for a connected store; '' unless validated figures are present. */
export function renderOwnerBoard({ store, session, now, userChoices }) {
  if (!store.snapshot || !store.connection || store.connection.state !== 'connected') return '';
  const model = buildStoreBoardModel({
    snapshot: store.snapshot,
    period: normalizePeriod(session.workspace.settings.period),
    unavailableMessage: '',
    now,
  });
  // The demo opens the metric definition in a dialog; here it is printed below the board instead.
  const metrics = model.metrics.map((metric) => ({ ...metric, help: undefined }));
  const boardHtml = renderBoard({ ...model, metrics }, { tvLink: false });
  return `<div class="owner-board">
    ${boardHtml}
    <details class="owner-tech owner-definition" data-details-key="definition"${detailsOpenAttribute(userChoices, 'definition')}>
      <summary>How these figures are calculated</summary>
      <p>${escapeHtml(store.snapshot.metricDefinition)}</p>
    </details>
  </div>`;
}
