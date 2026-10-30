// Authenticated Admin API transport. Collection still uses the same fixed queries and metric code.
import { API_VERSION, QUERIES, ShopifyError, extractData, validateStore } from './shop-data.mjs';
import { createShopifyFetch } from './http.mjs';

export function createAdminRunner({ store, connection, fetchImpl = fetch }) {
  validateStore(store);
  const shopifyFetch = createShopifyFetch({ store, fetchImpl });
  const endpoint = `https://${store}/admin/api/${API_VERSION}/graphql.json`;

  async function request(name, variables, forceRefresh) {
    const accessToken = await connection.getAccessToken({ forceRefresh });
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 16384) {
      throw new ShopifyError('reauthorization_required');
    }
    const response = await shopifyFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: QUERIES[name], variables }),
    });
    return { response, accessToken };
  }

  return async function run(name, variables = {}) {
    if (typeof name !== 'string' || !Object.hasOwn(QUERIES, name)) {
      throw new ShopifyError('unknown_query');
    }
    let result = await request(name, variables, false);
    if (result.response.status === 401) result = await request(name, variables, true);
    const { response, accessToken } = result;
    if (response.status === 401 || response.status === 403) {
      await connection.markReauthorizationRequired({ accessToken });
      throw new ShopifyError('reauthorization_required');
    }
    if (!response.ok) throw new ShopifyError('api_error');
    const servedVersion = response.headers.get('x-shopify-api-version');
    if (servedVersion && servedVersion !== API_VERSION)
      throw new ShopifyError('api_version_mismatch');
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ShopifyError('bad_output');
    }
    // A GraphQL permission error can arrive with HTTP200 after scopes change.
    if (Array.isArray(payload?.errors)) {
      const denied = payload.errors.some((error) => error?.extensions?.code === 'ACCESS_DENIED');
      if (denied) {
        await connection.markReauthorizationRequired({ accessToken });
        throw new ShopifyError('reauthorization_required');
      }
    }
    return extractData(payload);
  };
}
