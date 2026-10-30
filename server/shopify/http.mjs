// Bounded, server-only transport shared by Shopify token exchange and fixed GraphQL reads.
import { API_VERSION, ShopifyError, validateStore } from './shop-data.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

/** Reads a response body, failing once it passes `maxBytes`. Shared with the logo download. */
export async function readBoundedBody(response, maxBytes, signal) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw new ShopifyError('api_response_too_large');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const cancelRead = () => reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancelRead, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ShopifyError('api_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', cancelRead);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function createShopifyFetch({
  store,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  validateStore(store);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new ShopifyError('invalid_config');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ShopifyError('invalid_config');
  const origin = `https://${store}`;
  const paths = new Set(['/admin/oauth/access_token', `/admin/api/${API_VERSION}/graphql.json`]);

  return async function shopifyFetch(input, options = {}) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new ShopifyError('invalid_store');
    }
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !paths.has(url.pathname) ||
      options.method !== 'POST'
    ) {
      throw new ShopifyError('invalid_store');
    }

    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let abortListener;
    const aborted = new Promise((resolve, reject) => {
      abortListener = () => reject(new ShopifyError('api_timeout'));
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const operation = async () => {
        const response = await fetchImpl(url.href, {
          ...options,
          signal,
          redirect: 'error',
          credentials: 'omit',
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel();
          throw new ShopifyError('api_error');
        }
        if (signal.aborted) {
          await response.body?.cancel();
          throw new ShopifyError('api_timeout');
        }
        const body = await readBoundedBody(response, maxBytes, signal);
        const headers = new Headers(response.headers);
        // The fetch implementation has already decoded any HTTP content encoding.
        headers.delete('content-encoding');
        headers.delete('content-length');
        headers.delete('set-cookie');
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      };
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      controller.abort();
      throw error instanceof ShopifyError ? error : new ShopifyError('api_error');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortListener);
    }
  };
}
