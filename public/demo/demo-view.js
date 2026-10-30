// Demo-only views. Everything here is sample content: the entry point (app.js)
// passes fixtures in as arguments, so this module imports no data itself.
import { escapeHtml, money, getPeriod, goalProgress } from '../shared/model.js';
import { renderBoard } from '../shared/board.js';
import {
  BRAND_NAME,
  icon,
  brandLink,
  statusDot,
  actionButton,
  siteHeader,
  navLinks,
  tvShell,
} from '../shared/ui.js';

const DEMO_CURRENCY = 'EUR';
const DEMO_TIME_ZONE = 'Europe/Stockholm';
const DAY_LABELS = { today: '21 Oct 2026', week: '15–21 Oct 2026' };
const COMPARISON_LABELS = { today: 'sample day', week: '7 days' };

/**
 * @typedef {Object} DemoSettings
 * @property {string} name
 * @property {string} store
 * @property {number} goal  euros per week
 * @property {boolean} showTraffic
 * @property {boolean} showAttention
 * @property {boolean} showOrders
 * @property {'light'|'dark'} theme
 * @property {'sample'|'simulated'} connection
 *
 * @typedef {Object} DemoData
 * @property {{label: string, revenue: number, orders: number}[]} days
 * @property {{id: string, product: string, amount: number, country: string, time: string, status: string}[]} orders
 * @property {{id: string, title: string, description: string, action: string, tone: string}[]} attention
 */

const demoBrand = () => brandLink({ href: '#/', label: `${BRAND_NAME} home` });

/** Builds the shared board view model from sample fixtures. Net sales, not order value. */
export function buildDemoBoardModel({ data, settings, period, connectionError }) {
  const { current, previous, currentDays, previousDays } = getPeriod(data.days, period);
  const weeklyRevenue = getPeriod(data.days, 'week').current.revenue;
  const comparisonName = COMPARISON_LABELS[period];
  // "Sample day" shows the latest seven daily totals, not an invented intraday curve.
  const chartCurrent = period === 'today' ? data.days.slice(-7) : currentDays;
  const chartPrevious = period === 'today' ? data.days.slice(0, 7) : previousDays;
  const toPoint = (day) => ({ label: day.label, value: day.revenue });
  const change = (currentValue, previousValue) => ({
    current: currentValue,
    previous: previousValue,
    srText: ` vs. previous ${comparisonName}`,
  });

  return {
    title: settings.name,
    subtitle: DAY_LABELS[period],
    previewLabel: 'Demo · Sample data',
    periodOptions: [
      { value: 'week', label: 'Last 7 days' },
      { value: 'today', label: 'Sample day' },
    ],
    selectedPeriod: period,
    banner: connectionError
      ? {
          title: 'Sample connection interrupted.',
          message: 'Showing the last sample snapshot, not current data.',
          action: { label: 'Restore sample', name: 'restore' },
        }
      : null,
    changeStyle: 'arrows',
    metrics: [
      {
        label: 'Net sales',
        value: money(current.revenue, false, DEMO_CURRENCY),
        help: { action: 'sales-definition', label: 'How net sales are defined' },
        change: change(current.revenue, previous.revenue),
      },
      {
        label: 'Orders',
        value: String(current.orders),
        change: change(current.orders, previous.orders),
      },
      {
        label: 'Average order',
        value: money(current.averageOrder, false, DEMO_CURRENCY),
        change: change(current.averageOrder, previous.averageOrder),
      },
      {
        kind: 'goal',
        label: 'Weekly goal',
        percent: goalProgress(weeklyRevenue, settings.goal),
        target: `of ${money(settings.goal * 100, true, DEMO_CURRENCY)}`,
      },
    ],
    comparisonText: `Compared with previous ${comparisonName}`,
    chart: {
      title: 'Sales trend',
      ariaLabel:
        'Sample net sales by day. Solid green: current seven-day period. Dashed grey: previous seven-day period.',
      legend: ['This week', 'Previous week'],
      current: chartCurrent.map(toPoint),
      previous: chartPrevious.map(toPoint),
      currency: DEMO_CURRENCY,
      axisStep: 20000,
      plotStart: 48,
      dotRadius: 4,
      emptyText: 'No sample days available.',
    },
    attention: settings.showAttention
      ? {
          title: 'Needs attention',
          emptyText: 'Nothing needs attention.',
          items: data.attention.map((item) => ({
            title: item.title,
            description: item.description,
            tone: item.tone,
            action: { type: 'button', action: 'attention', id: item.id, label: item.action },
          })),
        }
      : null,
    orders: settings.showOrders ? buildDemoOrders(data.orders) : null,
    status: connectionError ? { tone: 'amber', text: 'Cached sample · Offline' } : null,
    scope: `${DEMO_CURRENCY} · ${DEMO_TIME_ZONE}`,
  };
}

function buildDemoOrders(orders) {
  return {
    title: 'Latest orders',
    emptyText: 'No sample orders.',
    columns: [
      { label: 'Order' },
      { label: 'Product' },
      { label: 'Destination' },
      { label: 'Status' },
      { label: 'Amount', alignRight: true },
      { label: 'Time', alignRight: true },
    ],
    rows: orders.map((order) => [
      { text: order.id, kind: 'id' },
      { text: order.product },
      { text: order.country, kind: 'muted' },
      { text: order.status, kind: 'status', fulfilled: order.status === 'Fulfilled' },
      { text: money(order.amount, false, DEMO_CURRENCY), kind: 'amount', alignRight: true },
      { text: order.time, kind: 'muted', alignRight: true },
    ]),
  };
}

function prototypeNotice() {
  return `<div class="prototype-notice">${statusDot('amber')} Interactive prototype <span class="notice-divider">/</span> Sample data only. No store is connected.</div>`;
}

function demoHeader(activePage = '') {
  if (!activePage) {
    return siteHeader({
      brandHtml: demoBrand(),
      navHtml: `<a href="#/dashboard">Explore the demo</a>
        ${actionButton({ action: 'source', label: 'About the source', className: 'text-button desktop-only' })}`,
      trailingHtml: `<a class="button small secondary" href="#/setup">Create your board ${icon('arrow')}</a>`,
    });
  }
  const links = [
    { href: '#/dashboard', label: 'Overview', current: activePage === 'dashboard' },
    { href: '#/connections', label: 'Connections', current: activePage === 'connections' },
    { href: '#/settings', label: 'Settings', current: activePage === 'settings' },
  ];
  return siteHeader({
    brandHtml: demoBrand(),
    navHtml: navLinks(links),
    trailingHtml: `<span class="sample-badge">${statusDot('amber')} Demo workspace</span>`,
  });
}

function demoFooter() {
  return `<footer class="site-footer">
    <span>A little less checking. A little more clarity.</span>
    <div>
      ${actionButton({ action: 'source', label: 'Project notes' })}
      <button class="text-button" data-action="support">${icon('heart')} Support the project</button>
      <span class="footer-prototype">Prototype 0.1</span>
    </div>
  </footer>`;
}

function pageFrame(activePage, mainHtml) {
  return `${demoHeader(activePage)}${prototypeNotice()}${mainHtml}${demoFooter()}`;
}

function checkbox(name, label, checked) {
  return `<label class="checkbox-row"><input type="checkbox" name="${escapeHtml(name)}" ${checked ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
}

/** @param {{data: DemoData, settings: DemoSettings, period: string, connectionError: boolean}} state */
export function renderHome(state) {
  const previewModel = buildDemoBoardModel({ ...state, period: 'week', connectionError: false });
  return `${demoHeader()}${prototypeNotice()}
  <main id="main" class="landing" tabindex="-1">
    <section class="hero">
      <div>
        <span class="eyebrow"><span class="tiny-line"></span> A CLEARER VIEW OF THE EVERYDAY</span>
        <h1>Your business,<br>in plain sight<span class="heading-dot">.</span></h1>
      </div>
      <div class="hero-copy">
        <p>Sales, progress, and the things that need you.<br class="desktop-only"> One calm overview, on the screen you already have.</p>
        <div class="hero-actions">
          <a class="button primary" href="#/setup">Create your board ${icon('arrow')}</a>
          <a class="quiet-link" href="#/dashboard">Take a look first</a>
        </div>
        <div class="hero-note">No signup in this prototype. Just explore.</div>
      </div>
    </section>
    <section class="preview-frame" aria-label="Sample business dashboard">
      <div class="preview-topline">
        <div><span></span><span></span><span></span></div>
        <span>Sunday Supply / Overview</span>
        <a href="#/dashboard">Explore this board ${icon('arrow')}</a>
      </div>
      ${renderBoard(previewModel, { preview: true })}
    </section>
    <section class="principles" aria-label="Why ${BRAND_NAME}">
      <article>
        <span class="principle-number">01 / CONTEXT</span>
        <h2>A quiet day is still a useful day.</h2>
        <p>See the week, not just this minute. Keep progress in view when there isn't a new order to watch.</p>
      </article>
      <article>
        <span class="principle-number">02 / FOCUS</span>
        <h2>The important things, not everything.</h2>
        <p>A few clear numbers. The orders that need attention. No digging through another wall of charts.</p>
      </article>
      <article>
        <span class="principle-number">03 / OWNERSHIP</span>
        <h2>Your screen. Your choice.</h2>
        <p>Designed for the browser, built toward self-hosting. No AI subscription needed to show your numbers.</p>
      </article>
    </section>
    <section class="project-strip">
      <div>
        <h2>A small tool. An open direction.</h2>
        <p>We're shaping a free, open-source business dashboard. This is the first working prototype.</p>
      </div>
      ${actionButton({ action: 'source', label: 'About the project', iconName: 'arrow', className: 'button secondary' })}
    </section>
  </main>${demoFooter()}`;
}

const SETUP_STEPS = ['Your store', 'Permissions', 'Your board'];

function renderStepIndicator(currentStep) {
  const stepsHtml = SETUP_STEPS.map((label, index) => {
    const stepNumber = index + 1;
    let stateClass = '';
    if (currentStep === stepNumber) stateClass = 'current';
    else if (currentStep > stepNumber) stateClass = 'complete';
    const ariaCurrent = currentStep === stepNumber ? ' aria-current="step"' : '';
    const marker = currentStep > stepNumber ? icon('check') : `0${stepNumber}`;
    return `<li class="${stateClass}"${ariaCurrent}><span>${marker}</span>${label}</li>`;
  }).join('');
  return `<ol class="steps" aria-label="Setup progress">${stepsHtml}</ol>`;
}

function renderStoreStep(storeText) {
  return `<span class="eyebrow">START WITH THE BASICS</span>
    <h1>Make room for<br>a clearer view.</h1>
    <p class="setup-description">First, tell us which store your board is for.</p>
    <form id="store-form">
      <label for="store-domain">Shopify store address</label>
      <input id="store-domain" name="store" type="text" autocomplete="off" placeholder="your-store.myshopify.com" value="${escapeHtml(storeText)}" aria-describedby="store-hint store-error" required maxlength="80">
      <p id="store-hint" class="field-hint">Use your .myshopify.com address, not your custom domain.</p>
      <p id="store-error" class="field-error" aria-live="polite"></p>
      <button class="button primary full-width" type="submit">Continue ${icon('arrow')}</button>
      ${actionButton({ action: 'sample-store', label: 'Use the sample store instead', className: 'text-button centered' })}
    </form>
    <div class="setup-disclosure">${icon('bag')}<p><strong>This is a practice run.</strong> The address stays in your browser. No request is sent to Shopify.</p></div>`;
}

function renderPermissionsStep(storeText) {
  return `<span class="eyebrow">A READ-ONLY CONNECTION</span>
    <h1>A little access.<br>Nothing more.</h1>
    <p class="setup-description">In the real product, Shopify would ask you to approve access to <strong>${escapeHtml(storeText)}</strong>.</p>
    <div class="permission-box">
      <div class="permission-heading">${icon('bag')}<strong>${BRAND_NAME} would like to read</strong></div>
      <ul>
        <li>${icon('check')} Orders and sales information</li>
        <li>${icon('check')} Products and available inventory</li>
        <li>${icon('check')} Fulfillment status</li>
      </ul>
      <p>No editing products. No sending messages.<br>No changing your store.</p>
    </div>
    <div class="inline-notice">${statusDot('amber')} Simulated authorisation, not a Shopify login.</div>
    ${actionButton({ action: 'approve', label: 'Approve sample connection', iconName: 'arrow', className: 'button primary full-width' })}
    <button class="text-button centered" data-action="back-setup">${icon('arrow', 'reverse')} Back to store details</button>`;
}

function renderBoardDetailsStep(settings) {
  return `<span class="eyebrow">KEEP WHAT MATTERS</span>
    <h1>Your board.<br>Your priorities.</h1>
    <p class="setup-description">A few details, then you're ready to explore.</p>
    <form id="board-form">
      <label for="board-name">Business name</label>
      <input id="board-name" name="name" maxlength="60" value="${escapeHtml(settings.name)}" required>
      <label for="board-goal">Weekly sales goal <span class="muted">(EUR)</span></label>
      <input id="board-goal" name="goal" type="number" min="1" max="100000000" step="1" value="${escapeHtml(settings.goal)}" required>
      <fieldset class="widget-options">
        <legend>Also show on my board</legend>
        ${checkbox('attention', 'Things that need attention', true)}
        ${checkbox('orders', 'Recent orders', true)}
        ${checkbox('traffic', 'Optional traffic connection', false)}
      </fieldset>
      <button class="button primary full-width" type="submit">Open my sample board ${icon('arrow')}</button>
      <p class="field-hint centered-text">You can change these choices in Settings.</p>
    </form>
    <button class="text-button centered" data-action="back-setup">${icon('arrow', 'reverse')} Back to permissions</button>`;
}

/** @param {{step: 1|2|3, storeText: string, settings: DemoSettings}} state */
export function renderSetup({ step, storeText, settings }) {
  const stepRenderers = {
    1: () => renderStoreStep(storeText),
    2: () => renderPermissionsStep(storeText),
    3: () => renderBoardDetailsStep(settings),
  };
  const contentHtml = stepRenderers[step]();
  // Setup sits inside the sample workspace, so it keeps the same header as its other pages.
  return `${demoHeader('setup')}${prototypeNotice()}
  <main id="main" class="setup-layout" tabindex="-1">
    <aside class="setup-sidebar">
      ${renderStepIndicator(step)}
      <div class="setup-side-note">
        <div class="drawn-board"><span></span><span></span><span></span><span></span></div>
        <h2>Less noise.<br>More perspective.</h2>
        <p>Your first board starts with Shopify. Everything else can wait.</p>
        <a href="#/dashboard" class="quiet-link">Skip setup and explore ${icon('arrow')}</a>
      </div>
    </aside>
    <section class="setup-content">${contentHtml}</section>
  </main>${demoFooter()}`;
}

/** @param {{data: DemoData, settings: DemoSettings, period: string, connectionError: boolean, tv?: boolean}} state */
export function renderDashboard(state) {
  const model = buildDemoBoardModel(state);
  if (state.tv) {
    const controlsHtml = `<span class="sample-badge">Demo · Sample data</span>
        <button class="text-button" data-action="fullscreen">${icon('screen')} Full screen</button>
        <a href="#/dashboard" class="text-button">${icon('close')} Exit TV mode</a>`;
    return tvShell({
      brandHtml: demoBrand(),
      controlsHtml,
      dark: state.settings.theme === 'dark',
      boardHtml: renderBoard(model, { tv: true }),
    });
  }
  const trafficNote = state.settings.showTraffic
    ? `<div class="traffic-note">${icon('link')}<div><strong>Traffic not connected</strong></div><a href="#/connections" class="text-button">View connections ${icon('arrow')}</a></div>`
    : '';
  const toolsAction = state.connectionError
    ? actionButton({ action: 'restore', label: 'Restore sample connection', iconName: 'arrow' })
    : actionButton({ action: 'offline', label: 'Preview a connection issue', iconName: 'arrow' });
  return pageFrame(
    'dashboard',
    `<main id="main" class="workspace" tabindex="-1">
    ${renderBoard(model, { detailsHtml: trafficNote })}
    <div class="demo-tools"><span>Explore the less perfect moments, too.</span>${toolsAction}</div>
  </main>`,
  );
}

/** @param {{settings: DemoSettings}} state */
export function renderConnections({ settings }) {
  const badge = settings.connection === 'simulated' ? 'Simulated connection' : 'Sample workspace';
  return pageFrame(
    'connections',
    `<main id="main" class="settings-layout" tabindex="-1">
    <div class="page-heading">
      <span class="eyebrow">THE INPUTS</span>
      <h1>Only what you need.</h1>
      <p>Start with your store. Add context when it's useful.</p>
    </div>
    <section class="connection-card">
      <div class="connection-icon shopify-icon">${icon('bag')}</div>
      <div class="connection-content">
        <div class="connection-title"><h2>Shopify</h2><span class="sample-badge">${badge}</span></div>
        <p>Sales, orders, inventory, and fulfillment.</p>
        <span class="connection-domain">${escapeHtml(settings.store)}</span>
        <div class="connection-scope">Read-only · No real token stored · Sample figures only</div>
      </div>
      <a class="button secondary small" href="#/setup">Try connection setup ${icon('arrow')}</a>
    </section>
    <section class="connection-card">
      <div class="connection-icon analytics-icon"><span></span><span></span><span></span></div>
      <div class="connection-content">
        <div class="connection-title"><h2>Google Analytics</h2><span class="outline-badge">Optional · not connected</span></div>
        <p>Traffic trends and active users, alongside your store.</p>
        <div class="connection-scope">Planned integration. Not available in this prototype.</div>
      </div>
      ${actionButton({ action: 'analytics', label: 'How it would work', iconName: 'arrow', className: 'button small secondary' })}
    </section>
    <div class="connection-principle">
      ${icon('link')}
      <div>
        <h3>A connection is a responsibility.</h3>
        <p>The connected product will request the minimum access it needs. Your TV gets the overview, never your store credentials.</p>
      </div>
    </div>
    <a href="#/dashboard" class="quiet-link">${icon('arrow', 'reverse')} Back to the overview</a>
  </main>`,
  );
}

/** @param {{settings: DemoSettings}} state */
export function renderSettings({ settings }) {
  const themeOption = (value, label) =>
    `<option value="${value}" ${settings.theme === value ? 'selected' : ''}>${label}</option>`;
  return pageFrame(
    'settings',
    `<main id="main" class="settings-layout" tabindex="-1">
    <div class="page-heading">
      <span class="eyebrow">MAKE IT YOURS</span>
      <h1>A few good defaults.</h1>
      <p>Keep your overview useful. Leave the rest out.</p>
    </div>
    <form id="settings-form" class="settings-form">
      <section class="settings-section">
        <div><h2>The basics</h2><p>Saved in this browser only.</p></div>
        <div class="settings-fields">
          <label for="settings-name">Business name</label>
          <input id="settings-name" name="name" value="${escapeHtml(settings.name)}" required maxlength="60">
          <label for="settings-goal">Weekly sales goal <span class="muted">(EUR)</span></label>
          <input id="settings-goal" name="goal" type="number" min="1" max="100000000" step="1" value="${escapeHtml(settings.goal)}" required>
          <p class="field-hint">Sample amounts use EUR. No currency conversion is performed.</p>
        </div>
      </section>
      <section class="settings-section">
        <div><h2>On your board</h2><p>Useful, not crowded.</p></div>
        <div class="settings-fields">
          ${checkbox('attention', 'Things that need attention', settings.showAttention)}
          ${checkbox('orders', 'Recent orders', settings.showOrders)}
          ${checkbox('traffic', 'Optional traffic connection', settings.showTraffic)}
        </div>
      </section>
      <section class="settings-section">
        <div><h2>The screen</h2><p>A comfortable view from across the room.</p></div>
        <div class="settings-fields">
          <label for="theme">TV appearance</label>
          <select id="theme" name="theme">
            ${themeOption('light', 'Light · paper and ink')}
            ${themeOption('dark', 'Dark · after hours')}
          </select>
          <p class="field-hint">Applies in TV mode. The website stays light.</p>
        </div>
      </section>
      <div class="settings-actions">
        <button class="button primary" type="submit">Save changes ${icon('check')}</button>
        <a class="quiet-link" href="#/dashboard">Back to overview</a>
      </div>
    </form>
  </main>`,
  );
}
