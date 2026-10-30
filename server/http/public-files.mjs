// Files only the app server should serve (landing, owner and TV pages); the sample server blocks
// them.
export const APP_ONLY_PATHS = new Set([
  '/landing/landing.html',
  '/landing/landing.css',
  '/owner/owner.html',
  '/owner/owner.js',
  '/owner/owner-client.js',
  '/shared/labels.js',
  '/owner/shopify-client.js',
  '/owner/store-view.js',
  '/owner/owner-view.js',
  '/owner/owner.css',
  '/tv/tv.html',
  '/tv/tv.js',
  '/tv/tv-client.js',
  '/tv/tv-view.js',
]);

// The app server presents its own files plus the shared presentation modules, and nothing
// else from the public directory.
export const APP_PUBLIC_FILES = new Set([
  ...APP_ONLY_PATHS,
  '/fonts/archivo-latin.woff2',
  // Explicitly fictional demo; these modules never call a live store API.
  '/demo/demo.html',
  '/demo/demo.js',
  '/demo/demo-data.js',
  '/demo/demo-view.js',
  '/shared/styles.css',
  '/mark.svg',
  '/shared/model.js',
  '/shared/ui.js',
  // Board presentation shared by the owner page and the TV page.
  '/shared/board.js',
  '/shared/board-model.js',
  '/shared/snapshot-validation.js',
  '/owner/shopify-authorize-url.js',
]);
