// Which files each server may serve from public/. Anything not listed is a 404, so a file added to
// public/ stays private until it is listed here. tests/server/public-files.test.mjs checks the
// lists against what the pages really load.

// URL path -> the page file it shows.
export const DEMO_PAGES = Object.freeze({ '/': '/demo/demo.html' });
export const APP_PAGES = Object.freeze({
  '/': '/landing/landing.html',
  '/app': '/owner/owner.html',
  '/register': '/owner/owner.html',
  '/demo': '/demo/demo.html',
  '/tv': '/tv/tv.html',
});

/** The public path a URL path shows: a page's own file, or the path itself. */
export function publicPathFor(pages, pathname) {
  return Object.hasOwn(pages, pathname) ? pages[pathname] : pathname;
}

// The sample dashboard: its page and the presentation files it shares with the app.
export const DEMO_PUBLIC_FILES = new Set([
  '/demo/demo.html',
  '/demo/demo.js',
  '/demo/demo-board.js',
  '/demo/demo-data.js',
  '/demo/demo-view.js',
  '/shared/styles.css',
  '/shared/format.js',
  '/shared/ui.js',
  '/shared/board.js',
  '/fonts/archivo-latin.woff2',
  '/mark.svg',
]);

// The app: the sample dashboard plus the landing, owner and TV pages and what they load.
export const APP_PUBLIC_FILES = new Set([
  ...DEMO_PUBLIC_FILES,
  '/landing/landing.html',
  '/landing/landing.css',
  '/owner/owner.html',
  '/owner/owner.js',
  '/owner/owner-client.js',
  '/owner/owner-view.js',
  '/owner/store-view.js',
  '/owner/shopify-client.js',
  '/owner/shopify-authorize-url.js',
  '/owner/owner.css',
  '/tv/tv.html',
  '/tv/tv.js',
  '/tv/tv-client.js',
  '/tv/tv-view.js',
  '/shared/api-client.js',
  '/shared/periods.js',
  '/shared/board-model.js',
  '/shared/snapshot-validation.js',
]);
