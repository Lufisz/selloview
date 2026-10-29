// Files only the beta server should serve (owner page and TV page); the demo and live servers
// block them.
export const BETA_ONLY_PATHS = new Set([
  '/landing.html',
  '/landing.css',
  '/beta.html',
  '/beta.js',
  '/beta-client.js',
  '/beta-labels.js',
  '/beta-shopify-client.js',
  '/beta-store-view.js',
  '/beta-view.js',
  '/beta.css',
  '/tv.html',
  '/tv.js',
  '/tv-client.js',
  '/tv-view.js',
]);

// The beta server presents its own files plus the shared presentation modules, and nothing
// else from the public directory.
export const BETA_PUBLIC_FILES = new Set([
  ...BETA_ONLY_PATHS,
  '/fonts/archivo-latin.woff2',
  // Explicitly fictional demo; these modules never call a live store API.
  '/index.html',
  '/app.js',
  '/data.js',
  '/demo-view.js',
  '/styles.css',
  '/mark.svg',
  '/model.js',
  '/ui.js',
  // Board presentation shared with the private live page. The live controller, its fetch
  // module (live-client.js), the demo fixtures and live.html are deliberately absent.
  '/board.js',
  '/live-board-model.js',
  '/snapshot-validation.js',
  '/shopify-authorize-url.js',
]);
