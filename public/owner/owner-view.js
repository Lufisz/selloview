// Pure HTML for the owner page. Every dynamic value is escaped here, whoever supplied it.
import { escapeHtml } from '../shared/model.js';
import { BRAND_NAME, actionButton, brandLink, siteHeader } from '../shared/ui.js';
import { PERIOD_CHOICES, THEME_CHOICES, messageForError } from './owner-client.js';
import { PERIOD_LABELS, THEME_LABELS } from '../shared/labels.js';
import { detailsOpenAttribute, renderOwnerBoard, renderStorePanel } from './store-view.js';

export { PERIOD_LABELS, THEME_LABELS };

function pageShell(headerTrailingHtml, contentHtml, mainClass = 'workspace session-main') {
  const header = siteHeader({
    brandHtml: brandLink({ href: '/', label: `${BRAND_NAME} beta` }),
    navHtml: '',
    trailingHtml: headerTrailingHtml,
  });
  return `${header}<main class="${mainClass}" id="main" tabindex="-1">${contentHtml}</main>`;
}

function messageHtml(message, tone) {
  if (!message) return '';
  const role = tone === 'error' ? 'alert' : 'status';
  return `<p class="form-message ${tone === 'error' ? 'field-error' : 'field-hint'}" role="${role}">${escapeHtml(message)}</p>`;
}

function entryPageHtml(contentHtml) {
  return `<div class="entry-page">${pageShell('', contentHtml, 'entry-main')}</div>`;
}

function emailStepHtml({ email, message, tone, registering = false }) {
  const emailLabel = registering ? 'Your email address' : 'Invited email address';
  const hint = registering
    ? 'Verify your email to create your account. No password or card required.'
    : 'Access is by invitation only. If this address is invited, a code is sent to it.';
  return `<form class="stacked-form" data-form="request-code" novalidate>
    <label for="owner-email">${emailLabel}</label>
    <input id="owner-email" name="email" type="email" autocomplete="email" inputmode="email" value="${escapeHtml(email)}" required>
    ${messageHtml(message, tone)}
    <button class="button primary full-width" type="submit">Email me a sign-in code</button>
    <p class="field-hint">${hint}</p>
  </form>`;
}

function codeStepHtml({ email, message, tone }) {
  return `<form class="stacked-form" data-form="verify-code" novalidate>
    <p class="field-hint">Enter the 6-digit code sent to ${escapeHtml(email)}. It works once and expires in 5 minutes.</p>
    <label for="owner-code">Sign-in code</label>
    <input id="owner-code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9 ]*" maxlength="8" required>
    ${messageHtml(message, tone)}
    <button class="button primary full-width" type="submit">Sign in</button>
    ${actionButton({ action: 'change-email', label: 'Use a different email' })}
  </form>`;
}

/** @param {{step: 'email'|'code', email: string, message: string, tone: 'error'|'info'}} state */
export function renderSignIn(state) {
  if (state.registering && state.step !== 'code' && !state.registration?.available) {
    const full = state.registration?.enabled === true;
    return entryPageHtml(
      `<section class="entry-card" aria-labelledby="owner-title">
        <p class="entry-status">Private beta</p>
        <h1 id="owner-title">${full ? 'The beta is at capacity.' : 'Registration is not open yet.'}</h1>
        <p class="registration-description">${full ? 'New registrations are paused while the beta is at capacity. Existing owners can still sign in.' : 'We are testing MetricTV with a small group of stores before opening registration.'}</p>
        ${messageHtml(state.message, state.tone)}
        <div class="registration-actions">
          <a class="button primary" href="/demo">Explore the sample dashboard</a>
          <a class="registration-signin" href="/app">Sign in to an existing account</a>
        </div>
        <p class="registration-note">No account has been created.</p>
      </section>`,
    );
  }
  const heading = state.registering ? 'Create your workspace.' : 'Sign in to your workspace.';
  const stepHtml = state.step === 'code' ? codeStepHtml(state) : emailStepHtml(state);
  return entryPageHtml(
    `<section class="entry-card entry-form-card" aria-labelledby="owner-title">
      <p class="entry-status">${state.registering ? 'Free beta' : 'Private beta'}</p>
      <h1 id="owner-title">${heading}</h1>
      ${stepHtml}
      <a class="entry-back" href="/">Back to MetricTV</a>
    </section>`,
  );
}

function choiceOptionsHtml(choices, labels, selected) {
  return choices
    .map((choice) => {
      const isSelected = choice === selected ? ' selected' : '';
      return `<option value="${escapeHtml(choice)}"${isSelected}>${escapeHtml(labels[choice])}</option>`;
    })
    .join('');
}

function settingsFormHtml(workspace, message, tone, draft = {}) {
  const period = draft.period ?? workspace.settings.period;
  const theme = draft.theme ?? workspace.settings.theme;
  return `<form class="stacked-form owner-settings-form" data-form="settings">
    <div class="owner-fields">
      <div class="owner-field">
        <label for="owner-period">Reporting period</label>
        <select id="owner-period" name="period">${choiceOptionsHtml(PERIOD_CHOICES, PERIOD_LABELS, period)}</select>
      </div>
      <div class="owner-field">
        <label for="owner-theme">Appearance</label>
        <select id="owner-theme" name="theme">${choiceOptionsHtml(THEME_CHOICES, THEME_LABELS, theme)}</select>
      </div>
    </div>
    ${messageHtml(message, tone)}
    <button class="button secondary small" type="submit">Save for this workspace</button>
  </form>`;
}

function formatTimestamp(isoText) {
  return `${isoText.slice(0, 16).replace('T', ' ')} UTC`;
}

function screenItemHtml(screen, { isConfirming, userChoices }) {
  const lastSeen = screen.lastSeenAt
    ? `Last seen ${formatTimestamp(screen.lastSeenAt)}`
    : 'Not seen since pairing';
  const buttons = isConfirming
    ? `${actionButton({ action: 'confirm-revoke', label: 'Confirm: remove screen', className: 'button primary small', data: { id: screen.id } })}
       ${actionButton({ action: 'cancel-revoke', label: 'Keep it', className: 'button secondary small' })}`
    : actionButton({
        action: 'revoke-screen',
        label: 'Remove',
        className: 'button secondary small',
        data: { id: screen.id },
      });
  const detailsKey = `screen-${screen.id}`;
  return `<li class="screen-item">
    <div class="screen-main">
      <strong>${escapeHtml(screen.name)}</strong>
      <p class="field-hint">${escapeHtml(lastSeen)}</p>
      <details class="owner-tech" data-details-key="${escapeHtml(detailsKey)}"${detailsOpenAttribute(userChoices, detailsKey)}>
        <summary>Pairing and access dates</summary>
        <p>Paired ${escapeHtml(formatTimestamp(screen.pairedAt))} · Access ends ${escapeHtml(formatTimestamp(screen.expiresAt))}</p>
      </details>
    </div>
    <div class="screen-actions">${buttons}</div>
  </li>`;
}

function screenListHtml({ screens, confirmRevokeId, userChoices }) {
  if (screens.status === 'loading') return '<p class="field-hint">Loading screens.</p>';
  if (screens.status === 'error') {
    return `<p class="field-error" role="alert">${escapeHtml(messageForError(screens.error))}</p>
      ${actionButton({ action: 'refresh-screens', label: 'Try again' })}`;
  }
  if (screens.items.length === 0) {
    return `<p class="field-hint">No screens paired yet.</p>
      ${actionButton({ action: 'refresh-screens', label: 'Refresh list' })}`;
  }
  const items = screens.items.map((screen) =>
    screenItemHtml(screen, { isConfirming: screen.id === confirmRevokeId, userChoices }),
  );
  return `<ul class="screen-list">${items.join('')}</ul>
    <p class="field-hint">Removing a screen signs it out at once.</p>
    ${actionButton({ action: 'refresh-screens', label: 'Refresh list' })}`;
}

function pairFormHtml(draft) {
  return `<form class="stacked-form owner-pair-form" data-form="pair-screen" novalidate>
    <div class="owner-fields">
      <div class="owner-field">
        <label for="owner-screen-code">Code shown on the TV</label>
        <input id="owner-screen-code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" value="${escapeHtml(draft.code ?? '')}" required>
      </div>
      <div class="owner-field">
        <label for="owner-screen-name">Screen name</label>
        <input id="owner-screen-name" name="name" type="text" autocomplete="off" maxlength="40" value="${escapeHtml(draft.name ?? '')}" required>
      </div>
    </div>
    <button class="button secondary small" type="submit">Approve this screen</button>
  </form>`;
}

function screensSectionHtml(state) {
  const { screens, userChoices } = state;
  const pairedCount = screens.status === 'ready' ? screens.items.length : 0;
  // With nothing paired the form is the main task; once a screen exists it folds away
  // unless the owner opened it or a message about it needs to be seen.
  // A pairing error must be seen next to the fields it is about, so it opens the form.
  const hasPairError = state.pairTone === 'error' && Boolean(state.pairMessage);
  const open = detailsOpenAttribute(userChoices, 'add-screen', {
    fallback: pairedCount === 0,
    forced: hasPairError,
  });
  const count = pairedCount > 0 ? `<span class="owner-count">${pairedCount}</span>` : '';
  return `<h2 class="owner-panel-title">Screens ${count}</h2>
    ${messageHtml(state.screenMessage, state.screenTone)}
    ${screenListHtml(state)}
    <details class="owner-add-screen" data-details-key="add-screen"${open}>
      <summary>Add a screen</summary>
      <p class="field-hint">Open <strong>/tv</strong> on the television, then enter the code it shows.</p>
      ${messageHtml(state.pairMessage, state.pairTone)}
      ${pairFormHtml(state.screenDraft ?? {})}
    </details>`;
}

const LOADING_STORE = Object.freeze({ status: 'loading', connection: null, snapshot: null });

/** A short setup path, derived from real connection state rather than a saved wizard step. */
function setupChecklistHtml(state) {
  const connected = state.store.connection?.state === 'connected';
  const paired = state.screens.status === 'ready' && state.screens.items.length > 0;
  if (connected && paired) return '';
  const storeLabel = connected ? 'Store connected' : 'Connect your Shopify store';
  const screenLabel = paired ? 'TV paired' : 'Pair your TV';
  return `<nav class="owner-setup" aria-label="Workspace setup">
    <h2>Next steps</h2>
    <ol>
      <li${connected ? ' class="is-done"' : ''}><a href="#connection">${storeLabel}</a></li>
      <li><a href="#board-settings">Reporting period and appearance</a></li>
      <li${paired ? ' class="is-done"' : ''}><a href="#screens">${screenLabel}</a></li>
    </ol>
  </nav>`;
}

function ownerNavHtml({ hasBoard, screenCount }) {
  const links = [];
  if (hasBoard) links.push({ href: '#overview', label: 'Overview' });
  links.push({ href: '#connection', label: 'Connection' });
  links.push({ href: '#board-settings', label: 'Board settings' });
  links.push({ href: '#screens', label: screenCount > 0 ? `Screens (${screenCount})` : 'Screens' });
  const items = links.map(
    (link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
  );
  return `<nav class="owner-nav" aria-label="Workspace sections">${items.join('')}</nav>`;
}

function ownerHeaderHtml(session) {
  const logout = actionButton({
    action: 'sign-out',
    label: 'Sign out',
    className: 'button secondary small',
  });
  return `<header class="site-header owner-header">
    <div class="header-inner">
      ${brandLink({ href: '/', label: `${BRAND_NAME} beta` })}
      <div class="owner-account">
        <span class="owner-identity"><span class="sr-only">Signed in as </span>${escapeHtml(session.owner.email)}</span>
        ${logout}
      </div>
    </div>
  </header>`;
}

/**
 * @param {{session: object, message: string, tone: 'error'|'info', screens: object,
 *   confirmRevokeId: string, screenMessage: string, screenTone: 'error'|'info',
 *   store?: object, storeMessage?: string, storeTone?: string, shopifyReturn?: string,
 *   confirmDisconnect?: boolean, storeAction?: string, now?: number,
 *   connectError?: string, pairMessage?: string, pairTone?: 'error'|'info',
 *   userChoices?: Map<string, boolean>, screenDraft?: {code?: string, name?: string},
 *   settingsDraft?: {period?: string, theme?: string}}} state
 */
export function renderOwner(state) {
  const { session } = state;
  const storeState = {
    storeMessage: '',
    storeTone: 'info',
    shopifyReturn: '',
    confirmDisconnect: false,
    storeAction: '',
    now: Date.now(),
    userChoices: new Map(),
    pairMessage: '',
    pairTone: 'info',
    ...state,
    store: state.store ?? LOADING_STORE,
  };
  const boardHtml = renderOwnerBoard({
    store: storeState.store,
    session,
    now: storeState.now,
    userChoices: storeState.userChoices,
  });
  const screenCount = state.screens.status === 'ready' ? state.screens.items.length : 0;
  // The store's own board heading is the page's h1 whenever there is a board.
  const titleTag = boardHtml ? 'p' : 'h1';
  const overview = boardHtml
    ? `<section class="owner-overview" id="overview" aria-label="Overview">${boardHtml}</section>`
    : '';
  return `${ownerHeaderHtml(session)}
    <main class="owner-page" id="main" tabindex="-1">
      <div class="owner-heading">
        <${titleTag} class="owner-title" id="owner-title">${escapeHtml(session.workspace.name)}</${titleTag}>
        ${ownerNavHtml({ hasBoard: Boolean(boardHtml), screenCount })}
      </div>
      <section class="owner-connection" id="connection" aria-label="Store connection">${renderStorePanel(storeState)}</section>
      ${setupChecklistHtml(storeState)}
      ${overview}
      <div class="owner-columns">
        <section class="owner-panel" id="board-settings" aria-label="Board settings">
          <h2 class="owner-panel-title">Board settings</h2>
          <p class="field-hint">Reporting period and appearance for this workspace's board and screens.</p>
          ${settingsFormHtml(session.workspace, state.message, state.tone, state.settingsDraft)}
        </section>
        <section class="owner-panel" id="screens" aria-label="Screens">${screensSectionHtml(storeState)}</section>
      </div>
    </main>`;
}

export function renderLoading() {
  return pageShell(
    '',
    `<section class="board session-card"><h1>Checking your session.</h1></section>`,
  );
}

export function renderSessionError(message) {
  return pageShell(
    '',
    `<section class="board session-card"><h1>Could not load your session.</h1>${messageHtml(message, 'error')}${actionButton({ action: 'retry', label: 'Try again' })}</section>`,
  );
}
