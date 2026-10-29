// The store's own logo for the TV heading, from the brand settings in the Shopify admin
// (Settings > Brand).
//
// The Admin API does not expose brand assets; the Storefront API does, without a token, because
// the logo is already public on the storefront. The server downloads the image itself and the
// TV loads it from MetricTV, so the TV never contacts Shopify and the page keeps `img-src 'self'`.
//
// Only a PNG or JPEG from Shopify's CDN is accepted (some older TV browsers cannot show WebP),
// and every read is bounded in time and size.
import crypto from 'node:crypto';
import { API_VERSION, ShopifyError, validateStore } from '../shopify.mjs';
import { readBoundedBody } from '../shopify-http.mjs';

const LOGO_QUERY = 'query ShopLogo { shop { brand { logo { image { url } } } } }';
const LOGO_HOST = 'cdn.shopify.com';
// Wide enough for a sharp heading on a 4K screen.
const LOGO_WIDTH_PX = '800';
const TIMEOUT_MS = 10_000;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;

const IMAGE_SIGNATURES = Object.freeze({
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
});

function startsWithBytes(bytes, signature) {
  return bytes.length > signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** The CDN address with a PNG at a fixed width requested, or null when it is not Shopify's CDN. */
export function logoDownloadUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== LOGO_HOST || url.port) return null;
  if (url.username || url.password) return null;
  url.hash = '';
  url.searchParams.set('format', 'png');
  url.searchParams.set('width', LOGO_WIDTH_PX);
  return url.href;
}

/** One bounded GET or POST; the body is returned as a Buffer with the response's content type. */
async function boundedRequest(fetchImpl, url, options, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ShopifyError('api_error');
    }
    const body = await readBoundedBody(response, maxBytes, controller.signal);
    return { body: body ?? Buffer.alloc(0), contentType: response.headers.get('content-type') };
  } finally {
    clearTimeout(timer);
  }
}

async function findLogoUrl(fetchImpl, store) {
  const { body } = await boundedRequest(
    fetchImpl,
    `https://${store}/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: LOGO_QUERY }),
    },
    MAX_QUERY_BYTES,
  );
  const parsed = JSON.parse(body.toString('utf8'));
  return parsed?.data?.shop?.brand?.logo?.image?.url ?? null;
}

/**
 * Reads the store's logo. Resolves to { bytes, contentType, version } or null when the store has
 * no logo. Rejects on network or format problems; the caller keeps the text name then.
 */
export async function fetchShopLogo({ store, fetchImpl = fetch }) {
  validateStore(store);
  const logoUrl = await findLogoUrl(fetchImpl, store);
  if (logoUrl === null) return null;
  const downloadUrl = logoDownloadUrl(logoUrl);
  if (!downloadUrl) throw new ShopifyError('bad_shape');

  const { body, contentType } = await boundedRequest(
    fetchImpl,
    downloadUrl,
    { method: 'GET' },
    MAX_IMAGE_BYTES,
  );
  const mimeType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const signature = IMAGE_SIGNATURES[mimeType];
  // The declared type must match the file's first bytes, so nothing else is served as an image.
  if (!signature || !startsWithBytes(body, signature)) throw new ShopifyError('bad_shape');

  const version = crypto.createHash('sha256').update(body).digest('base64url').slice(0, 16);
  return { bytes: body, contentType: mimeType, version };
}
