// Shared UI primitives for the demo, the owner page and the TV page.
// Pure string helpers first, then small DOM controllers. Nothing here imports
// data, fetches anything or touches the DOM at import time.
import { escapeHtml, hasOwn, normaliseStore } from './format.js';

export const BRAND_NAME = 'MetricTV';
const BRAND_WORDMARK = 'Metric TV';

const ICON_PATHS = {
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  external:
    '<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  bag: '<path d="M5 7h14l2 14H3L5 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2 4h5l1-3 3-1 3-3-2-3 1-3-3-2-2-3Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="m9 15 6-6m-7 3-2 2a4 4 0 0 0 6 6l2-2m-2-12 2-2a4 4 0 0 1 6 6l-2 2"/>',
  heart: '<path d="M20 5c-2-2-5-1-8 2-3-3-6-4-8-2-4 4 1 9 8 15 7-6 12-11 8-15Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};

export const ICON_NAMES = Object.freeze(Object.keys(ICON_PATHS));

/** Characters allowed in a class name passed to a template helper. */
function safeClassName(value) {
  return String(value).replace(/[^\w -]/g, '');
}

/**
 * Inline SVG icon. Only names from the allowlist draw their own path.
 * Anything else (including prototype keys such as "constructor") falls back to the arrow.
 */
export function icon(name, className = '') {
  const paths = hasOwn(ICON_PATHS, name) ? ICON_PATHS[name] : ICON_PATHS.arrow;
  const classes = `icon ${safeClassName(className)}`.trim();
  return `<svg class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** Logo link. `href` and `label` are fixed in-app strings; both are escaped anyway. */
export function brandLink({ href, label }) {
  return `<a class="brand" href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}"><img src="/mark.svg" width="32" height="32" alt=""><span>${BRAND_WORDMARK}<span class="brand-dot">.</span></span></a>`;
}

/** Small coloured dot. Tone is one of '', 'amber', 'neutral'. */
export function statusDot(tone = '') {
  const safeTone = ['amber', 'neutral'].includes(tone) ? tone : '';
  return `<span class="status-dot ${safeTone}"></span>`;
}

/** A form or panel message: announced as an alert when it is an error, quietly otherwise. */
export function messageHtml(message, tone) {
  if (!message) return '';
  const isError = tone === 'error';
  const role = isError ? 'alert' : 'status';
  const toneClass = isError ? 'field-error' : 'field-hint';
  return `<p class="form-message ${toneClass}" role="${role}">${escapeHtml(message)}</p>`;
}

/** The <option> elements of a <select>; `options` is a list of {value, label}. */
export function optionsHtml(options, selectedValue) {
  return options
    .map((option) => {
      const selected = option.value === selectedValue ? ' selected' : '';
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join('');
}

/** Button that the page's click handler recognises through data-action. */
export function actionButton({
  action,
  label,
  iconName = '',
  className = 'text-button',
  data = {},
}) {
  const dataAttributes = Object.entries(data)
    .map(([key, value]) => ` data-${key.replace(/[^a-z-]/g, '')}="${escapeHtml(value)}"`)
    .join('');
  const iconHtml = iconName ? ` ${icon(iconName)}` : '';
  // type="button" keeps these from submitting a surrounding form.
  return `<button type="button" class="${safeClassName(className)}" data-action="${escapeHtml(action)}"${dataAttributes}>${escapeHtml(label)}${iconHtml}</button>`;
}

/**
 * Header with a navigation and one trailing element. `navHtml` and `trailingHtml`
 * are built by view code from escaped pieces.
 */
export function siteHeader({ brandHtml, navHtml, trailingHtml }) {
  return `<header class="site-header">
    <div class="header-inner">
      ${brandHtml}
      <nav aria-label="Main navigation">${navHtml}</nav>
      ${trailingHtml}
    </div>
  </header>`;
}

/** @param {{href: string, label: string, current?: boolean}[]} links */
export function navLinks(links) {
  return links
    .map(
      (link) =>
        `<a href="${escapeHtml(link.href)}"${link.current ? ' aria-current="page"' : ''}>${escapeHtml(link.label)}</a>`,
    )
    .join('');
}

/**
 * Full-screen TV page. `controlsHtml` holds the buttons shown top right. A fitted TV board
 * passes `showTopbar: false` to give the brand bar's height to the figures.
 */
export function tvShell({ brandHtml, controlsHtml, boardHtml, dark, showTopbar = true }) {
  const topbarHtml = showTopbar
    ? `<div class="tv-topbar">${brandHtml}<div>${controlsHtml}</div></div>`
    : '';
  return `<main id="main" class="tv-shell ${dark ? 'dark-board' : ''}" tabindex="-1">
    ${topbarHtml}
    ${boardHtml}
  </main>`;
}

/**
 * Only Shopify admin links may become clickable.
 * @param {string} value URL from a snapshot
 * @param {string} shopDomain the store's myshopify.com domain (already validated by the caller)
 * @returns {string} the normalised URL, or '' when it is not an https Shopify admin URL
 */
export function safeShopifyAdminUrl(value, shopDomain) {
  const domain = normaliseStore(shopDomain);
  if (!domain) return '';
  try {
    const url = new URL(value);
    const isHttpsWithoutCredentials =
      url.protocol === 'https:' && !url.username && !url.password && !url.port;
    const storeHandle = domain.replace(/\.myshopify\.com$/, '');
    const storePrefix = `/store/${storeHandle}`;
    const isGlobalAdmin =
      url.hostname === 'admin.shopify.com' &&
      (url.pathname === storePrefix || url.pathname.startsWith(`${storePrefix}/`));
    const isStoreAdmin = url.hostname === domain && /^\/admin(?:\/|$)/.test(url.pathname);
    return isHttpsWithoutCredentials && (isGlobalAdmin || isStoreAdmin) ? url.href : '';
  } catch {
    return '';
  }
}

// ---- Small DOM controllers (browser only; called from entry points) ----

/** Toast message box. */
export function createToast(element, durationMs = 3500) {
  let timer;
  return function showToast(message) {
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.remove('visible'), durationMs);
  };
}

/**
 * Modal dialog with a heading and paragraphs. Content is escaped text.
 * Focus returns to the trigger, or to the same data-action if a re-render replaced it.
 */
export function createDialog({ dialog, content, closeButton }) {
  let trigger = null;
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const action = trigger?.dataset?.action;
    const replacement = action
      ? document.querySelector(`[data-action="${CSS.escape(action)}"]`)
      : null;
    const target = trigger?.isConnected ? trigger : replacement;
    target?.focus();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const outside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;
    if (outside) dialog.close();
  });
  return {
    open({ eyebrow = '', title, paragraphs, opener = document.activeElement }) {
      trigger = opener;
      const eyebrowHtml = eyebrow ? `<span class="eyebrow">${escapeHtml(eyebrow)}</span>` : '';
      const paragraphHtml = paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
      content.innerHTML = `${eyebrowHtml}<h2 id="dialog-title">${escapeHtml(title)}</h2>${paragraphHtml}`;
      dialog.showModal();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}

/** Toggles browser full screen. Resolves false when the browser refuses. */
export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}
