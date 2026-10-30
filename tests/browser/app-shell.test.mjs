// The product pages share one header and content rail. These checks keep page-specific
// stylesheets from quietly reintroducing their own header sizes or gutters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  renderConnections,
  renderDashboard,
  renderSettings,
  renderSetup,
} from '../../public/demo/demo-view.js';
import {
  ATTENTION_ITEMS,
  DEFAULT_SETTINGS,
  SAMPLE_DAYS,
  SAMPLE_ORDERS,
} from '../../public/demo/demo-data.js';

const PAGE_STYLESHEETS = {
  demo: ['/shared/styles.css', '/shared/board.css', '/demo/demo.css'],
  owner: ['/shared/styles.css', '/shared/board.css', '/owner/owner.css'],
  tv: ['/shared/styles.css', '/shared/board.css', '/tv/tv.css'],
};

function readPublicFile(publicPath) {
  return readFile(new URL(`../../public${publicPath}`, import.meta.url), 'utf8');
}

const sharedCss = await readPublicFile('/shared/styles.css');
const pageSpecificCss = (
  await Promise.all(
    ['/shared/board.css', '/demo/demo.css', '/owner/owner.css', '/tv/tv.css'].map(readPublicFile),
  )
).join('\n');

function countOf(source, text) {
  return source.split(text).length - 1;
}

test('only the shared stylesheet defines the header, brand and app font', () => {
  assert.equal(countOf(sharedCss + pageSpecificCss, '@font-face'), 1);
  assert.doesNotMatch(pageSpecificCss, /\.header-inner\s*\{/);
  // The TV top bar has its own brand size; every page header uses the shared one.
  assert.doesNotMatch(pageSpecificCss, /^(?!.*tv-).*\.brand( img)?\s*\{/m);
  assert.doesNotMatch(pageSpecificCss, /owner-rail-gutter/);
  assert.match(sharedCss, /\.header-inner \{\n  max-width: var\(--app-max-width\);/);
});

test('every page loads the shared stylesheets first, then its own', async () => {
  // Later rules win ties, so the order is part of the design: tokens, then the board, then the page.
  for (const [page, expected] of Object.entries(PAGE_STYLESHEETS)) {
    const html = await readPublicFile(`/${page}/${page}.html`);
    const linked = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(linked, expected, `${page} page stylesheets`);
  }
});

test('every sample workspace page uses the same header navigation', () => {
  const state = {
    data: { days: SAMPLE_DAYS, orders: SAMPLE_ORDERS, attention: ATTENTION_ITEMS },
    settings: { ...DEFAULT_SETTINGS },
    period: 'week',
    connectionError: false,
  };
  const pages = [
    renderDashboard(state),
    renderConnections(state),
    renderSettings(state),
    renderSetup({ step: 1, storeText: '', settings: DEFAULT_SETTINGS }),
  ];
  for (const html of pages) {
    assert.match(html, /<a href="#\/dashboard"[^>]*>Overview<\/a>/);
    assert.match(html, /<a href="#\/connections"[^>]*>Connections<\/a>/);
    assert.match(html, /<a href="#\/settings"[^>]*>Settings<\/a>/);
    assert.match(html, /Demo workspace/);
  }
});
