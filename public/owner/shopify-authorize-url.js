// The only Shopify address a page may navigate to when connecting a store. Used by the owner
// page; pure, no fetching.
import { normaliseStore } from '../shared/model.js';

export const AUTHORIZE_PATH = '/admin/oauth/authorize';
export const READ_ONLY_SCOPES = Object.freeze([
  'read_all_orders',
  'read_orders',
  'read_products',
  'read_inventory',
]);

/**
 * Accepts only an HTTPS Shopify authorize URL on the exact configured store host.
 * Optional scope and redirect_uri parameters must match what this app requests.
 * Returns the normalised URL string, or null.
 */
export function validateAuthorizeUrl(value, { store, callbackUrl }) {
  if (typeof value !== 'string' || typeof store !== 'string' || normaliseStore(store) !== store) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const isExactEndpoint =
    url.protocol === 'https:' &&
    url.hostname === store &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === AUTHORIZE_PATH &&
    url.hash === '';
  if (!isExactEndpoint) return null;
  const scopeValues = url.searchParams.getAll('scope');
  if (scopeValues.length > 1) return null;
  if (scopeValues.length === 1) {
    const requested = scopeValues[0].split(',');
    const matches =
      requested.length === READ_ONLY_SCOPES.length &&
      READ_ONLY_SCOPES.every((scope) => requested.includes(scope));
    if (!matches) return null;
  }
  const redirects = url.searchParams.getAll('redirect_uri');
  if (redirects.length > 1) return null;
  if (redirects.length === 1 && callbackUrl && redirects[0] !== callbackUrl) return null;
  return url.href;
}
