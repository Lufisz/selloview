import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../public/landing/landing.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../../public/landing/landing.css', import.meta.url), 'utf8');

const ALLOWED_ROUTES = new Set(['/', '/register', '/app', '/demo']);

function collectHrefs(source) {
  const hrefs = [];
  for (const match of source.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)) {
    hrefs.push(match[1]);
  }
  return hrefs;
}

function countOf(source, text) {
  return source.split(text).length - 1;
}

test('primary, login and demo calls to action point at the planned routes', () => {
  const hrefs = collectHrefs(html);
  assert.ok(countOf(html, 'href="/register"') >= 2);
  assert.ok(hrefs.includes('/app'));
  assert.ok(hrefs.includes('/demo'));
  assert.match(html, /<a class="button button-primary" href="\/demo">View the working demo<\/a>/);
  assert.match(
    html,
    /<a class="button button-secondary" href="\/register">Check beta availability/,
  );
});

test('every link is a planned route or an existing in-page section', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const href of collectHrefs(html)) {
    if (href.startsWith('#')) {
      assert.ok(ids.has(href.slice(1)), `missing section ${href}`);
    } else {
      assert.ok(ALLOWED_ROUTES.has(href), `unexpected link ${href}`);
    }
  }
});

test('page loads no scripts, remote assets, forms or inline handlers', () => {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<form|<input|<iframe/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//i);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?(?:https?:)?\/\//i);
});

test('has semantic landmarks and a single h1', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
  for (const tag of ['header', 'nav', 'main', 'footer']) {
    assert.match(html, new RegExp(`<${tag}\\b`));
  }
  assert.equal(countOf(html, '<h1'), 1);
});

test('states pricing and beta limits honestly', () => {
  assert.match(html, /Free beta/);
  assert.match(html, /No card required/);
  assert.match(html, /one store, one screen/);
  assert.match(html, /Paid plans are not available yet/);
  assert.match(html, /Open-source release planned/);
  assert.match(html, /Beta access is limited/);
  assert.match(html.replace(/\s+/g, ' '), /beyond the current pilot is not available yet/);
  assert.doesNotMatch(html, /limited time|hurry|\d+\s+days left/i);
  assert.match(html, /No countdown trial/);
  assert.doesNotMatch(html, /[$€£]\s?\d+\s*(?:\/|per)\s*(?:mo|month|year)/i);
});

test('preview is labelled synthetic and avoids real data and customer details', () => {
  assert.match(html, /Synthetic preview · not real store data/);
  assert.doesNotMatch(html, /rubbery/i);
  assert.doesNotMatch(html, /@[a-z0-9-]+\.[a-z]{2,}/i);
});

test('contains no fake proof, badges, guarantees or invented contact links', () => {
  assert.doesNotMatch(
    html,
    /testimonial|trusted by|customers love|★|⭐|\d+\+? (?:stores|merchants)/i,
  );
  assert.doesNotMatch(html, /certified|guarantee|SOC ?2|GDPR compliant|bank-level|100% secure/i);
  assert.doesNotMatch(html, /github\.com|mailto:|tel:|\/privacy|\/terms|\/contact/i);
});

test('has the direct headline and a pilot restriction beside the calls to action', () => {
  assert.match(html, /Your Shopify store,<br\s*\/>on the big screen\./);
  const heroCopy = html.slice(html.indexOf('class="hero-copy"'), html.indexOf('<figure'));
  assert.match(heroCopy, /View the working demo/);
  assert.match(heroCopy, /Check beta availability/);
  assert.match(heroCopy, /Beta access is limited/);
});

test('shows all four metrics, the chart, latest orders and stock in the preview', () => {
  for (const label of ['Order value', 'Orders', 'Average order value', 'Awaiting fulfillment']) {
    assert.ok(html.includes(`<span>${label}</span>`), label);
  }
  assert.match(html, /class="trend-chart"/);
  assert.match(html, /Latest orders/);
  assert.match(html, /3 products running low/);
});

test('fonts are local, licensed and declared without remote sources', () => {
  assert.match(css, /font-family: 'Archivo'/);
  assert.match(css, /url\('\/fonts\/archivo-latin\.woff2'\)/);
  assert.match(html, /href="\/fonts\/archivo-latin\.woff2"/);
  assert.match(css, /--page-gutter: 48px/);
  assert.match(css, /--page-width: 1600px/);
});

test('covers how it works steps and the FAQ topics', () => {
  for (const step of ['Connect your store', 'Configure the board', 'Pair your TV']) {
    assert.ok(html.includes(step), step);
  }
  assert.equal(countOf(html, 'class="step-number"'), 3);
  assert.match(html.replace(/\s+/g, ' '), /verify your email with a code/);
  assert.equal(countOf(html, '<details>'), 5);
  for (const topic of ['privacy', 'read-only', 'TV', 'update', 'beta include']) {
    assert.match(html, new RegExp(`<summary>[^<]*${topic}`, 'i'));
  }
});
