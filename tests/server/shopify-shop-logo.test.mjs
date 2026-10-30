// Reading the store logo for the TV: only a PNG or JPEG from Shopify's CDN is accepted.
// Synthetic responses only; nothing here contacts Shopify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShopLogo, logoDownloadUrl } from '../../server/shopify/shop-logo.mjs';

const STORE = 'synthetic-logo-store.myshopify.com';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const CDN_LOGO = 'https://cdn.shopify.com/s/files/1/0001/files/logo.webp?v=7';

/** A fake fetch: the Storefront answer names `logoUrl`; the CDN answers with `image`. */
function fakeShopify({ logoUrl = CDN_LOGO, image = { bytes: PNG_BYTES, type: 'image/png' } }) {
  const requests = [];
  async function fetchImpl(url, options) {
    requests.push({ url, options });
    if (url.startsWith(`https://${STORE}/api/`)) {
      const logo = logoUrl === null ? null : { image: { url: logoUrl } };
      return Response.json({ data: { shop: { brand: { logo } } } });
    }
    return new Response(image.bytes, { headers: { 'content-type': image.type } });
  }
  return { fetchImpl, requests };
}

test('downloads the logo as a PNG of fixed width from the CDN, never following redirects', async () => {
  const { fetchImpl, requests } = fakeShopify({});
  const logo = await fetchShopLogo({ store: STORE, fetchImpl });

  assert.deepEqual(logo.bytes, PNG_BYTES);
  assert.equal(logo.contentType, 'image/png');
  assert.match(logo.version, /^[A-Za-z0-9_-]{16}$/);

  const [query, download] = requests;
  assert.equal(query.url, `https://${STORE}/api/2026-07/graphql.json`);
  assert.equal(query.options.headers.Authorization, undefined, 'no token for public brand data');
  const downloadUrl = new URL(download.url);
  assert.equal(downloadUrl.searchParams.get('format'), 'png');
  assert.equal(downloadUrl.searchParams.get('width'), '800');
  assert.equal(downloadUrl.searchParams.get('v'), '7');
  for (const request of requests) assert.equal(request.options.redirect, 'error');
});

test('a store without a logo gives null, so the TV shows the name', async () => {
  const { fetchImpl } = fakeShopify({ logoUrl: null });
  assert.equal(await fetchShopLogo({ store: STORE, fetchImpl }), null);
});

test('refuses logos from anywhere but Shopify’s CDN', async () => {
  for (const logoUrl of [
    'http://cdn.shopify.com/logo.png',
    'https://cdn.shopify.com.attacker.test/logo.png',
    'https://user:pass@cdn.shopify.com/logo.png',
    'https://cdn.shopify.com:8443/logo.png',
    'not a url',
  ]) {
    assert.equal(logoDownloadUrl(logoUrl), null, logoUrl);
    const { fetchImpl, requests } = fakeShopify({ logoUrl });
    await assert.rejects(fetchShopLogo({ store: STORE, fetchImpl }), { code: 'bad_shape' });
    assert.equal(requests.length, 1, 'nothing is downloaded');
  }
});

test('refuses anything that is not really a PNG or JPEG', async () => {
  const cases = [
    { bytes: Buffer.from('<svg onload="alert(1)"/>'), type: 'image/svg+xml' },
    { bytes: Buffer.from('<html>not an image</html>'), type: 'image/png' },
    { bytes: PNG_BYTES, type: 'text/html' },
    { bytes: Buffer.alloc(0), type: 'image/png' },
  ];
  for (const image of cases) {
    const { fetchImpl } = fakeShopify({ image });
    await assert.rejects(fetchShopLogo({ store: STORE, fetchImpl }), { code: 'bad_shape' });
  }
});

test('refuses a logo larger than 1 MB', async () => {
  const bytes = Buffer.concat([PNG_BYTES, Buffer.alloc(1024 * 1024)]);
  const { fetchImpl } = fakeShopify({ image: { bytes, type: 'image/png' } });
  await assert.rejects(fetchShopLogo({ store: STORE, fetchImpl }), {
    code: 'api_response_too_large',
  });
});

test('refuses an invalid store before any request', async () => {
  const { fetchImpl, requests } = fakeShopify({});
  await assert.rejects(fetchShopLogo({ store: 'attacker.test', fetchImpl }));
  assert.equal(requests.length, 0);
});
