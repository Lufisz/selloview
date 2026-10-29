# MetricTV Shopify connection slice

## Scope and boundaries

Build real standalone Shopify OAuth behind the EXISTING loopback/Tailscale owner gate. One configured store per instance; NOT public multi-tenant authentication. Keep the working CLI pilot as the default when `SHOPIFY_AUTH_MODE` is absent or `cli`. Explicit `SHOPIFY_AUTH_MODE=oauth` must NEVER fall back to CLI, fixtures or a different store. No infrastructure/account changes or real Shopify installation are authorized by this coding task. Dedicated application credentials are not available; prove behavior with labelled synthetic transport tests, not claims of a real Shopify installation.

Use pinned installed `@shopify/shopify-api@15.0.1` for OAuth state-cookie/HMAC handling, with its web-api adapter so responses can be inspected and converted to the existing Node HTTP server. See installed SDK source. It supports `auth.callback({expiring:true,...})` and expiring offline sessions. No framework required. Fixed requested scopes: read_all_orders,read_orders,read_products,read_inventory. Reject unexpectedly broader/write scopes returned in token data. Current official docs: https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps and https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens.

## Backend ownership and exports

Backend worker owns NEW server/shopify-connection.mjs, server/shopify-token-store.mjs and focused tests, plus NEW optional helper if a genuine responsibility demands it. Do not edit live-server, existing shopify adapter, frontend, manifests or shared static helpers; parent integrates them.

Export `loadConnectionConfig(env, {store, origin})` from shopify-connection.mjs. Return {mode:'cli',store,origin} by default; oauth mode reads SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY (canonical base64 32 bytes), SHOPIFY_TOKEN_STORE_PATH (absolute private file OUTSIDE project/public root). Missing oauth config returns a safe setup-required configuration (no secret/path exposed to browser); malformed partial/unsafe config fails closed with a safe error. Never read .env or CLI credential files. No secrets printed. Validate HTTPS origin and exact configured *.myshopify.com store. Do not generate/persist credentials or keys automatically.

Export `createShopifyConnection({config, fetchImpl=fetch, now=Date.now, onChange=async()=>{}})` returning:

- `status(principal)` => safe serializable object described below. Can be async.
- `handle(request,response,{pathname,principal})` => Promise<boolean>, true if a connection route handled, false if unrelated. Parent already enforces loopback, exact Host, owner identity and validated path BEFORE calling. Enforce own method allowlists, body bounds (4KB), no duplicate ambiguous headers/query fields, safe errors, origin and CSRF on every POST. Parent catches unhandled rejection safely.
- `getAccessToken()` => token string server-only, refreshing expiring offline tokens early (singleflight), persist rotated refresh token atomically before using it. Reject expired refresh/revoked grants with `ShopifyError('reauthorization_required')`; transient failure keeps credentials for retry. Never log upstream/token bodies. May expose a `markReauthorizationRequired()` method for revoked API credentials. No browser credentials.
- `disconnect()` internal helper if useful. User disconnect is POST and deletes LOCAL credentials, invalidates pending OAuth attempts, calls onChange; UI must clearly distinguish local disconnect from uninstalling in Shopify. Never perform a remote uninstall/mutation.

Use a small encrypted atomic file token store (one configured store, not SQLite or generalized DB). AES-256-GCM with random IV and authenticated app-client/store binding. Directory 0700/file0600, reject symlinks/unsafe paths/files, bounded reads, atomic fsync+rename, no plaintext token backups; do not overwrite unknown non-store files. Corruption/wrong key fails closed, never drops into CLI. Serialize operations and invalidate refresh/write work on disconnect so late work cannot restore deleted credentials. Validate stored grant's shop/client identity, offline nature, expiry/refresh data and scopes on reload. Persistence survives a new service instance and tokens stay encrypted on disk.

## Browser API contract

GET /api/connection => HTTP200 JSON:

```
{ mode:'cli'|'oauth', state:'cli_pilot'|'setup_required'|'not_connected'|'connected'|'reconnect_required', store:'example.myshopify.com', scopes:['read_orders','read_products','read_inventory'], csrfToken:'opaque runtime token for this principal or empty', callbackUrl:'https://configured-origin/auth/shopify/callback' }
```

No app secret, tokens, encryption keys, filesystem paths, user identities or raw errors. State connected means authorized grant, NOT proof first snapshot finished. CLI pilot uses state cli_pilot. Missing OAuth config uses setup_required. csrfToken is bound to authenticated principal and process; status no-store.

POST /auth/shopify/start, JSON {store: configured store}, headers Content-Type application/json, Origin exact configured origin, X-CSRF-Token from status => HTTP200 {authorizationUrl: exact HTTPS configured-store /admin/oauth/authorize URL}; include secure HttpOnly SameSite=Lax state cookies returned by SDK. Browser navigates window.location.assign to returned URL. Validate store equality BEFORE SDK/network calls. Bind OAuth pending state to initiating principal/store, short expiry, one-use, bounded concurrent attempts and rate limiting. SDK cookie+HMAC validation is necessary but not enough; reject replay, stale timestamp, duplicate query params, another owner or another store. Tokens exchanged only AFTER validation. Callback may be GET only, no origin requirement since Shopify top-level navigation is cross-origin. HEAD must never trigger state changes.

GET /auth/shopify/callback => validate, exchange code with expiring:true, validate exact read-only scopes, save encrypted grant, call onChange, HTTP303 same-origin `/#/connections` with fixed query result `?connection=connected#/connections` or `?connection=failed#/connections` (build the URL so query precedes hash). Never reflect upstream messages/callback contents into HTML/logs. Clear OAuth cookies. A callback error must preserve a prior still-valid grant on failed reconnect where safe. No raw authorization code/state in redirect URLs.

POST /api/connection/disconnect, JSON {} and same Origin/CSRF => local deletion, onChange, HTTP200 {disconnected:true}. Clearly documented local-only, uninstall remains a Shopify action. In CLI mode reject both POST actions (409) without affecting existing auth. Disabled oauth returns 503 setup_required. Status should still be available.

## Frontend worker ownership

Frontend worker owns public/live.js, public/live-client.js, public/live-view.js, public/live.css and focused frontend tests ONLY. Preserve fixture separation, canonical MetricTV / Metric TV wordmark and existing metrics/TV behavior. Fetch status from real API, keep CSRF only in memory, call start/disconnect with same-origin JSON POST + token, navigate only to validated exact configured Shopify auth URL. Do not change demo's explicitly simulated setup into something falsely real. Existing CLI board remains functional with honest CLI-pilot notice; oauth setup-required should show honest server-setup state, not a fake active connect button. Configured unconnected/reconnect state gets clear Connect Shopify form, configured store prefilled/read-only (one store per instance), read-only access explanation and Shopify redirect expectation. Render connection page even without snapshot. Handle first sync, denied authorization, expired/revoked grant, network failures. Local disconnect needs explicit in-app confirmation, clears current snapshot immediately and explains it does not uninstall the Shopify app. Callback result query must be consumed with fixed safe messages and removed from URL to avoid repeat notifications.

Use `connection` state passed into renderLivePage (optional for backwards-compatible unit test rendering). Before status finishes keep existing loading state. Fetch it with refresh cadence; avoid wiping a newer snapshot after races/disconnect. Keep page navigation/focus and pending forms stable during polling. Do not leak sensitive setup values into localStorage. Add actual behavior tests. Do not claim to have completed external app install.

## Parent integration

Parent integrates connection service into owner-gated live handler before generic read-method enforcement; no public callback bypass. Add async rejection guard. Parent creates fixed-query direct Admin API runner sharing QUERIES, fetchShopData/buildSnapshot, max time/output, no redirects, HTTPS exact configured Shopify host, no arbitrary user GraphQL, safe API errors and refresh/revocation behavior. CLI default unchanged. Cache clear/generation guard on disconnect to prevent old in-flight snapshot resurrection; HTTP auth-related snapshot denial clears browser data. Document dedicated app config and exact callback; keep all real app creation/install/network changes blocked pending approval. Parent runs all tests, real HTTP/browser checks, immutable independent review. Report live-Shopify OAuth E2E as BLOCKED until credentials/merchant approval exist.
