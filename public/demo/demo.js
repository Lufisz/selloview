// Demo entry point: owns state, routing and events. Rendering lives in demo-view.js
// and board.js, fixtures in data.js. Nothing here talks to the network.
import { SAMPLE_DAYS, SAMPLE_ORDERS, ATTENTION_ITEMS, DEFAULT_SETTINGS } from './demo-data.js';
import { normaliseStore } from '../shared/model.js';
import { BRAND_NAME, createDialog, createToast, toggleFullscreen } from '../shared/ui.js';
import {
  renderHome,
  renderSetup,
  renderDashboard,
  renderConnections,
  renderSettings,
} from './demo-view.js';

// Preserve preferences saved before the MetricTV rename.
const STORAGE_KEY = 'stillboard-prototype-v1';
const MAX_GOAL_EUROS = 100000000;
const demoData = { days: SAMPLE_DAYS, orders: SAMPLE_ORDERS, attention: ATTENTION_ITEMS };

const appElement = document.querySelector('#app');
const showToast = createToast(document.querySelector('#toast'));
const dialog = createDialog({
  dialog: document.querySelector('#info-dialog'),
  content: document.querySelector('#dialog-content'),
  closeButton: document.querySelector('#close-dialog'),
});

let settings = loadSettings();
let period = 'week';
let setupStep = 1;
let setupStoreText = '';
let connectionError = false;

const DIALOGS = {
  'sales-definition': {
    title: 'A number should mean something.',
    body: 'These fictional net sales exclude tax and shipping. They are calculated from the included sample daily totals. A real connection needs reconciliation for discounts, refunds and order changes before these figures can be trusted.',
  },
  analytics: {
    title: 'Traffic, with context.',
    body: 'The planned integration would let you authorise read-only access to a Google Analytics property. We would show traffic with its reporting window and refresh time. It would not claim to match Shopify visitor counts. Nothing is connected in this prototype.',
  },
  source: {
    title: 'Open by intention.',
    body: `${BRAND_NAME} is a working prototype for a free, self-hostable business overview. The source is currently local and has not been published to GitHub. Public releases, a licence and installation instructions will follow only if we decide to continue. No account or analytics service is required for this preview.`,
  },
  support: {
    title: 'A small tool, supported by people.',
    body: 'Optional donations could help with development and hosting. No donation account is connected yet, and this preview cannot accept payments. The intended self-hosted version will not require a donation or subscription.',
  },
};

// ---- Settings (preferences only; localStorage never holds sample or store data) ----

function booleanOrDefault(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const goalIsValid = Number.isFinite(saved.goal) && saved.goal > 0;
    return {
      ...DEFAULT_SETTINGS,
      name: typeof saved.name === 'string' ? saved.name.slice(0, 60) : DEFAULT_SETTINGS.name,
      store: normaliseStore(saved.store) ?? DEFAULT_SETTINGS.store,
      goal: goalIsValid ? Math.min(saved.goal, MAX_GOAL_EUROS) : DEFAULT_SETTINGS.goal,
      showTraffic: booleanOrDefault(saved.showTraffic, true),
      showAttention: booleanOrDefault(saved.showAttention, true),
      showOrders: booleanOrDefault(saved.showOrders, true),
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      connection: saved.connection === 'simulated' ? 'simulated' : 'sample',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    showToast('Browser storage is unavailable. Changes last for this visit only.');
  }
}

function readBoardForm(form) {
  const data = new FormData(form);
  return {
    name: String(data.get('name')).trim() || 'My store',
    goal: Number(data.get('goal')),
    showAttention: data.has('attention'),
    showOrders: data.has('orders'),
    showTraffic: data.has('traffic'),
  };
}

// ---- Routing and rendering ----

const PAGE_TITLES = {
  '#/dashboard': 'Overview',
  '#/setup': 'Create your board',
  '#/connections': 'Connections',
  '#/settings': 'Settings',
  '#/tv': 'TV preview',
};

function renderPage(path) {
  const state = { data: demoData, settings, period, connectionError };
  switch (path) {
    case '#/dashboard':
      return renderDashboard(state);
    case '#/tv':
      return renderDashboard({ ...state, tv: true });
    case '#/setup':
      return renderSetup({ step: setupStep, storeText: setupStoreText, settings });
    case '#/connections':
      return renderConnections(state);
    case '#/settings':
      return renderSettings(state);
    default:
      return renderHome(state);
  }
}

function route() {
  const path = location.hash || (location.pathname === '/demo' ? '#/dashboard' : '#/');
  if (path === '#main') {
    document.querySelector('main')?.focus();
    return;
  }
  document.body.classList.toggle('tv-active', path === '#/tv');
  document.body.classList.toggle(
    'sample-app',
    ['#/dashboard', '#/connections', '#/settings', '#/setup'].includes(path),
  );
  // Views escape every text value they interpolate; this app never renders API data.
  appElement.innerHTML = renderPage(path);
  document.title = `${BRAND_NAME} · ${PAGE_TITLES[path] ?? 'Your business, in plain sight'}`;
  window.scrollTo(0, 0);
}

// ---- Events ----

function handleStoreSubmit(form) {
  setupStoreText = form.elements.store.value;
  const domain = normaliseStore(setupStoreText);
  if (!domain) {
    const input = document.querySelector('#store-domain');
    document.querySelector('#store-error').textContent =
      'Enter a store address such as sunday-supply.myshopify.com.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  setupStoreText = domain;
  setupStep = 2;
  route();
  const heading = document.querySelector('.setup-content h1');
  heading.setAttribute('tabindex', '-1');
  heading.focus();
}

appElement.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'store-form') {
    handleStoreSubmit(form);
  } else if (form.id === 'board-form') {
    settings = {
      ...settings,
      ...readBoardForm(form),
      store: setupStoreText,
      connection: 'simulated',
    };
    saveSettings();
    location.hash = '#/dashboard';
    showToast('Your sample board is ready. No real store was connected.');
    setupStep = 1;
  } else if (form.id === 'settings-form') {
    settings = { ...settings, ...readBoardForm(form), theme: form.elements.theme.value };
    saveSettings();
    showToast('Changes saved in this browser.');
  }
});

appElement.addEventListener('change', (event) => {
  if (event.target.id !== 'period') return;
  period = event.target.value === 'today' ? 'today' : 'week';
  route();
  document.querySelector('#period')?.focus();
});

function showAttentionDetail(button) {
  const item = ATTENTION_ITEMS.find((candidate) => candidate.id === button.dataset.id);
  if (item)
    dialog.open({
      eyebrow: `${BRAND_NAME.toUpperCase()} PROTOTYPE`,
      title: item.title,
      paragraphs: [item.detail],
      opener: button,
    });
}

appElement.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (Object.hasOwn(DIALOGS, action)) {
    const content = DIALOGS[action];
    dialog.open({
      eyebrow: `${BRAND_NAME.toUpperCase()} PROTOTYPE`,
      title: content.title,
      paragraphs: [content.body],
      opener: button,
    });
    return;
  }
  switch (action) {
    case 'sample-store':
      setupStoreText = DEFAULT_SETTINGS.store;
      setupStep = 2;
      route();
      break;
    case 'approve':
      setupStep = 3;
      route();
      break;
    case 'back-setup':
      setupStep = Math.max(1, setupStep - 1);
      route();
      break;
    case 'attention':
      showAttentionDetail(button);
      break;
    case 'offline':
      connectionError = true;
      route();
      break;
    case 'restore':
      connectionError = false;
      route();
      break;
    case 'fullscreen':
      if (!(await toggleFullscreen()))
        showToast('Full screen is unavailable here. TV mode still works in the browser.');
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && location.hash === '#/tv' && !document.fullscreenElement)
    location.hash = '#/dashboard';
});
window.addEventListener('hashchange', route);
route();
