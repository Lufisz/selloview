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

const sharedCss = await readFile(
  new URL('../../public/shared/styles.css', import.meta.url),
  'utf8',
);
const betaCss = await readFile(new URL('../../public/owner/owner.css', import.meta.url), 'utf8');

function countOf(source, text) {
  return source.split(text).length - 1;
}

test('only the shared stylesheet defines the header, brand and app font', () => {
  assert.equal(countOf(sharedCss + betaCss, '@font-face'), 1);
  assert.doesNotMatch(betaCss, /\.header-inner\s*\{/);
  // The TV top bar has its own brand size; every page header uses the shared one.
  assert.doesNotMatch(betaCss, /^(?!.*tv-).*\.brand( img)?\s*\{/m);
  assert.doesNotMatch(betaCss, /owner-rail-gutter/);
  assert.match(sharedCss, /\.header-inner \{\n  max-width: var\(--app-max-width\);/);
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
