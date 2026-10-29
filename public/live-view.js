// Live-only views. They receive a validated server snapshot as an argument and a
// clock value ("now") so they stay pure. No fixtures, no fetching, no globals.
import { escapeHtml } from './model.js';
import { CALLBACK_MESSAGES, connectionAllowsSnapshot } from './live-client.js';
import { renderBoard, renderBanner } from './board.js';
import { buildLiveBoardModel, buildSyncWarning, normalizePeriod } from './live-board-model.js';
import {
  BRAND_NAME,
  icon,
  brandLink,
  statusDot,
  actionButton,
  siteHeader,
  navLinks,
  tvShell,
} from './ui.js';

/**
 * @typedef {Object} LiveState
 * @property {object|null} snapshot       validated server snapshot, or null before the first load
 * @property {string} unavailableMessage  fixed message when the last refresh failed, else ''
 * @property {object|null} [connection]   validated connection status without the CSRF token.
 *   Optional: when absent the page behaves like the earlier CLI-only board.
 * @property {{busy?: ''|'starting'|'disconnecting', error?: string, confirmingDisconnect?: boolean}} [connectionAction]
 * @property {''|'connected'|'failed'} [callbackResult]  consumed ?connection= result
 * @property {'days60'|'month'|'week'|'today'} period
 * @property {'light'|'dark'} theme
 * @property {'dashboard'|'connections'|'tv'} route
 * @property {number} now                 Date.now() supplied by the caller
 */

// Re-exported for the callers and tests that already import them from this module.
export {
  LIVE_PERIOD_OPTIONS,
  buildLiveBoardModel,
  buildSyncWarning,
  formatPeriodLabel,
  humanizeStatus,
  isSnapshotStale,
  normalizePeriod,
} from './live-board-model.js';

const liveBrand = () => brandLink({ href: '#/dashboard', label: `${BRAND_NAME} overview` });

function renderHeader({ snapshot, route }) {
  const links = [
    { href: '#/dashboard', label: 'Overview', current: route !== 'connections' },
    { href: '#/connections', label: 'Connection', current: route === 'connections' },
  ];
  return siteHeader({
    brandHtml: liveBrand(),
    navHtml: navLinks(links),
    trailingHtml: `<span class="sample-badge">${statusDot(snapshot ? '' : 'neutral')} Private · Read only</span>`,
  });
}

const CONNECTION_BADGES = Object.freeze({
  cli_pilot: 'CLI pilot',
  setup_required: 'Setup required',
  not_connected: 'Not connected',
  connected: 'Connected',
  reconnect_required: 'Reconnect required',
});

const CONNECTION_HEADINGS = Object.freeze({
  setup_required: ['SETUP REQUIRED', 'Server setup needed.'],
  not_connected: ['READ ONLY', 'Connect your store.'],
  reconnect_required: ['READ ONLY', 'Reconnect your store.'],
});

function connectionBadge(state) {
  const { snapshot, connection, unavailableMessage } = state;
  const connectionState = connection?.state;
  if (
    snapshot &&
    (!connectionState || connectionState === 'cli_pilot' || connectionState === 'connected')
  ) {
    return snapshot.sync.state === 'ok' && !unavailableMessage ? 'Connected' : 'Last snapshot';
  }
  if (connectionState === 'connected') return 'Syncing';
  return CONNECTION_BADGES[connectionState] ?? 'Connected';
}

function renderConnectionNotice(state) {
  const { callbackResult, connection } = state;
  if (!callbackResult) return '';
  // A "connected" redirect is only believed while the server also reports a grant.
  if (callbackResult === 'connected' && connection?.state !== 'connected') return '';
  const tone = callbackResult === 'failed' ? ' is-problem' : '';
  return `<div class="connection-notice${tone}" role="status">
      <span>${escapeHtml(CALLBACK_MESSAGES[callbackResult])}</span>
      ${actionButton({ action: 'dismiss-notice', label: 'Dismiss' })}
    </div>`;
}

function renderActionError(action) {
  if (!action?.error) return '';
  return `<p class="connection-error" role="alert">${escapeHtml(action.error)}</p>`;
}

function renderConnectForm(state) {
  const { connection, connectionAction } = state;
  const isBusy = connectionAction?.busy === 'starting';
  const isReconnect = connection.state !== 'not_connected';
  const label = isReconnect ? 'Reconnect Shopify' : 'Connect Shopify';
  const intros = {
    reconnect_required:
      'Shopify access has expired or was revoked. Reconnect to restore your board.',
    connected: 'Your current connection stays active until a new authorization succeeds.',
    not_connected: 'Approve read-only access in Shopify to start showing live figures.',
  };
  const intro = intros[connection.state] ?? intros.not_connected;
  return `<section class="connection-panel" aria-labelledby="connect-title">
      <h2 id="connect-title">${escapeHtml(label)}</h2>
      <p>${escapeHtml(intro)}</p>
      <form id="connect-form" class="connection-form" data-connect-form>
        <label for="connect-store">Shopify store (set by the server)</label>
        <input id="connect-store" type="text" value="${escapeHtml(connection.store)}" readonly />
        <p class="field-hint">You’ll sign in and approve read-only access in Shopify, then return here. MetricTV cannot change your orders, products or stock.</p>
        ${renderActionError(connectionAction)}
        <button type="submit" id="connect-submit" class="button ${connection.state === 'connected' ? 'secondary' : 'primary'}"${isBusy ? ' disabled aria-busy="true"' : ''}>${isBusy ? 'Opening Shopify…' : escapeHtml(label)}</button>
      </form>
    </section>`;
}

function renderSetupRequired(state) {
  const { connection } = state;
  const callbackHtml = connection.callbackUrl
    ? `<p class="field-hint">The Shopify app must allow this redirect URL: <span class="connection-domain">${escapeHtml(connection.callbackUrl)}</span></p>`
    : '';
  const storeHtml = connection.store
    ? `<p class="field-hint">Configured store: <span class="connection-domain">${escapeHtml(connection.store)}</span></p>`
    : '';
  return `<section class="connection-panel" aria-labelledby="setup-title">
      <h2 id="setup-title">Connecting is not available yet</h2>
      <p>This server has no complete Shopify app configuration, so a connection cannot be started from this page. The operator must set it up on the server. Credentials are never entered in the browser.</p>
      ${storeHtml}
      ${callbackHtml}
      <button type="button" class="button secondary" disabled aria-describedby="setup-title">Connect Shopify unavailable</button>
    </section>`;
}

function renderCliPilot() {
  return `<section class="connection-panel" aria-labelledby="pilot-title">
      <h2 id="pilot-title">Pilot sign-in</h2>
      <p>This server reads Shopify through its own CLI login. Connecting and disconnecting from this page are off, and nothing here changes that login. If the CLI session expires, the server operator must sign in again.</p>
    </section>`;
}

function renderDisconnect(state) {
  const { connectionAction } = state;
  const isBusy = connectionAction?.busy === 'disconnecting';
  const explanation =
    'Disconnecting removes the saved Shopify authorization from this MetricTV server and clears the figures on this screen. It does not uninstall the app from Shopify. To revoke access there, remove the app in your Shopify admin.';
  if (!connectionAction?.confirmingDisconnect && !isBusy) {
    return `<section class="connection-panel" aria-labelledby="disconnect-title">
      <h2 id="disconnect-title">Disconnect locally</h2>
      <p>${escapeHtml(explanation)}</p>
      ${actionButton({ action: 'disconnect-ask', label: 'Disconnect locally…', className: 'button secondary' })}
    </section>`;
  }
  return `<section class="connection-panel is-confirming" role="group" aria-labelledby="disconnect-title">
      <h2 id="disconnect-title">Disconnect from this server?</h2>
      <p>${escapeHtml(explanation)}</p>
      ${renderActionError(connectionAction)}
      <div class="connection-actions">
        <button type="button" id="disconnect-confirm" class="button primary" data-action="disconnect-confirm"${isBusy ? ' disabled aria-busy="true"' : ''}>${isBusy ? 'Disconnecting…' : 'Disconnect locally'}</button>
        <button type="button" id="disconnect-cancel" class="button secondary" data-action="disconnect-cancel"${isBusy ? ' disabled' : ''}>Keep connected</button>
      </div>
    </section>`;
}

function renderConnectionControls(state) {
  const { connection, connectionAction } = state;
  if (!connection) return '';
  const isConfirmingDisconnect =
    connectionAction?.confirmingDisconnect || connectionAction?.busy === 'disconnecting';
  switch (connection.state) {
    case 'cli_pilot':
      return renderCliPilot();
    case 'setup_required':
      return renderSetupRequired(state);
    case 'not_connected':
      return renderConnectForm(state);
    case 'reconnect_required':
      return isConfirmingDisconnect ? renderDisconnect(state) : renderReconnectPanel(state);
    default:
      return isConfirmingDisconnect ? renderDisconnect(state) : renderManageConnection(state);
  }
}

/** Reconnect required panel keeps the clean layout without redundant store inputs. */
function renderReconnectPanel(state) {
  const { connectionAction } = state;
  const isStarting = connectionAction?.busy === 'starting';
  return `<section class="connection-panel" aria-labelledby="reconnect-title">
      <h2 id="reconnect-title">Reconnect Shopify</h2>
      <p>Shopify access has expired or was revoked. Reconnect to restore your board.</p>
      ${renderActionError(connectionAction)}
      <form id="connect-form" class="connection-actions" data-connect-form>
        <button type="submit" id="connect-submit" class="button primary"${isStarting ? ' disabled aria-busy="true"' : ''}>${isStarting ? 'Opening Shopify…' : 'Reconnect Shopify'}</button>
        ${actionButton({ action: 'disconnect-ask', label: 'Disconnect…', className: 'button secondary' })}
      </form>
    </section>`;
}

/** Connected stores get one compact panel; the store address is already on the card above. */
function renderManageConnection(state) {
  const { connectionAction } = state;
  const isStarting = connectionAction?.busy === 'starting';
  return `<section class="connection-panel" aria-labelledby="manage-title">
      <h2 id="manage-title">Manage connection</h2>
      <p>Reconnect to renew access. Disconnecting removes access from MetricTV only.</p>
      ${renderActionError(connectionAction)}
      <form id="connect-form" class="connection-actions" data-connect-form>
        <button type="submit" id="connect-submit" class="button secondary"${isStarting ? ' disabled aria-busy="true"' : ''}>${isStarting ? 'Opening Shopify…' : 'Reconnect Shopify'}</button>
        ${actionButton({ action: 'disconnect-ask', label: 'Disconnect…', className: 'button secondary' })}
      </form>
    </section>`;
}

function renderSyncPending(state) {
  const { connection, snapshot, unavailableMessage } = state;
  if (connection?.state !== 'connected' || snapshot) return '';
  const message = unavailableMessage || MESSAGES_FIRST_SYNC;
  return `<div class="connection-notice" role="status"><span>${escapeHtml(message)}</span></div>`;
}

const MESSAGES_FIRST_SYNC =
  'Authorized. The first Shopify sync has not finished, so no figures are shown yet. This page checks again automatically.';

function renderLiveNotes(state) {
  const { snapshot, connection } = state;
  const isOauth = connection?.mode === 'oauth';
  const privacyHtml = isOauth
    ? `<h2>This is a private pilot</h2>
      <p>Access is restricted to the owner's Tailscale identity. Shopify authorization is stored encrypted on the server, never in this browser. The browser receives only display data, without customer names, email addresses or addresses.</p>`
    : `<h2>This is a private pilot</h2>
      <p>Access is restricted to the owner's Tailscale identity. Shopify credentials stay in the server's CLI session. The browser receives only display data, without customer names, email addresses or addresses.</p>
      <p>The CLI session can expire and require another login. A dedicated Shopify app is still needed for a reliable, shareable service. Traffic, visitor counts and messages are not connected.</p>`;
  if (!snapshot) return `<section class="live-notes">${privacyHtml}</section>`;
  return `<section class="live-notes">
      <h2>What these figures mean</h2>
      <p>${escapeHtml(snapshot.metricDefinition)}</p>
      <h2>Coverage</h2>
      <p>Orders created in the last ${escapeHtml(snapshot.coverage.historyDays)} days. Older orders awaiting fulfillment may be missing. ${escapeHtml(snapshot.coverage.notes.join(' '))}</p>
      <p>Stock alerts cover tracked variants at 5 or fewer units, including inactive products if returned by Shopify.</p>
      ${privacyHtml}
    </section>`;
}

function renderConnection(state) {
  const { snapshot, connection, unavailableMessage, now } = state;
  const warning = snapshot ? buildSyncWarning(snapshot, unavailableMessage, now) : '';
  const [eyebrow, heading] = CONNECTION_HEADINGS[connection?.state] ?? [
    'READ ONLY',
    'Your store, connected.',
  ];
  const subline =
    connection?.mode === 'oauth' && !snapshot
      ? 'A read-only overview of your orders and stock.'
      : 'Real Shopify data. No AI calls to keep it updated.';
  const storeName = snapshot ? snapshot.shop.name : '';
  const planHtml = snapshot?.shop.plan ? ` · ${escapeHtml(snapshot.shop.plan)}` : '';
  const domain = snapshot ? snapshot.shop.domain : (connection?.store ?? '');
  const hasFigures = Boolean(snapshot);
  const scopeText = hasFigures
    ? 'Orders, products and inventory · Refreshes every 2 minutes'
    : 'Read-only access to orders, products and inventory';
  return `<main id="main" class="settings-layout" tabindex="-1">
    <div class="page-heading">
      <span class="eyebrow">${escapeHtml(eyebrow)}</span>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(subline)}</p>
    </div>
    ${renderConnectionNotice(state)}
    <section class="connection-card"><div class="connection-content">
      <div class="connection-title"><h2>Shopify</h2><span class="sample-badge">${escapeHtml(connectionBadge(state))}</span></div>
      ${storeName ? `<p>${escapeHtml(storeName)}${planHtml}</p>` : ''}
      <span class="connection-domain">${escapeHtml(domain)}</span>
      <div class="connection-scope">${escapeHtml(scopeText)}</div>
    </div></section>
    ${renderSyncPending(state)}
    ${warning ? renderBanner({ message: warning }) : ''}
    ${renderConnectionControls(state)}
    ${renderLiveNotes(state)}
    <a class="quiet-link" href="#/dashboard">Back to overview ${icon('arrow')}</a>
  </main>`;
}

function renderWaitingForConnection(connection, unavailableMessage) {
  const copy = {
    setup_required: [
      'Shopify is not set up on this server.',
      'The server needs Shopify app configuration before it can connect. No figures are shown.',
    ],
    not_connected: [
      'Shopify is not connected.',
      'Connect your store to see live figures. No sample figures are shown.',
    ],
    reconnect_required: [
      'Shopify needs to be reconnected.',
      'Access expired or was revoked. Figures are hidden until you reconnect.',
    ],
    connected: [
      'Connected. Waiting for the first sync.',
      unavailableMessage || MESSAGES_FIRST_SYNC,
    ],
  }[connection.state];
  const connectLink =
    connection.state === 'connected'
      ? ''
      : '<a class="button primary" href="#/connections">Open connection</a>';
  return `<main id="main" class="workspace" tabindex="-1">
    <div class="board live-waiting" role="status">
      <h1>${escapeHtml(copy[0])}</h1>
      <p>${escapeHtml(copy[1])}</p>
      ${connectLink}
      ${connection.state === 'connected' ? actionButton({ action: 'retry', label: 'Check again', className: 'button secondary' }) : ''}
    </div>
  </main>`;
}

function renderWaiting({ unavailableMessage, connection }) {
  if (connection && connection.state !== 'cli_pilot') {
    return renderWaitingForConnection(connection, unavailableMessage);
  }
  const title = unavailableMessage ? 'Store data is unavailable.' : 'Connecting to your store.';
  const message =
    unavailableMessage ||
    'Waiting for the first read-only Shopify snapshot. No sample figures are substituted.';
  return `<main id="main" class="workspace" tabindex="-1">
    <div class="board live-waiting" role="status">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${actionButton({ action: 'retry', label: 'Check again', className: 'button secondary' })}
    </div>
  </main>`;
}

/** Text for the "How order value is defined" dialog. */
export function buildDefinitionDialog(snapshot) {
  return {
    title: 'Order value, not net sales.',
    paragraphs: [
      snapshot.metricDefinition,
      `To fulfill covers only the last ${snapshot.coverage.historyDays} days and does not change with the reporting-period selector.`,
    ],
  };
}

/** Full-page HTML for the live app. */
export function renderLivePage(rawState) {
  // Figures are shown only while the connection may serve them. A missing connection
  // (older callers, status not loaded yet) keeps the original snapshot-only behaviour.
  const connection = rawState.connection ?? null;
  const snapshot = connectionAllowsSnapshot(connection) ? rawState.snapshot : null;
  const state = { ...rawState, connection, snapshot };
  const { route } = state;
  if (route === 'tv' && snapshot) {
    const nextTheme = state.theme === 'light' ? 'Dark' : 'Light';
    const controlsHtml = `${actionButton({ action: 'theme', label: `${nextTheme} view` })}
        <button type="button" class="text-button" data-action="fullscreen">${icon('screen')} Full screen</button>
        <a class="text-button" href="#/dashboard">${icon('close')} Exit TV mode</a>`;
    return tvShell({
      brandHtml: liveBrand(),
      controlsHtml,
      dark: state.theme === 'dark',
      boardHtml: renderBoard(buildLiveBoardModel(state), { tv: true }),
    });
  }
  let bodyHtml = renderWaiting(state);
  if (route === 'connections' && (snapshot || connection)) bodyHtml = renderConnection(state);
  else if (snapshot)
    bodyHtml = `<main id="main" class="workspace" tabindex="-1">${renderBoard(buildLiveBoardModel(state))}</main>`;
  return `${renderHeader(state)}${bodyHtml}`;
}
