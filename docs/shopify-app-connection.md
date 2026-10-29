# Dedicated Shopify app connection

This is the first real authorization slice, not a public multi-merchant release. It replaces the CLI collector only when explicitly enabled. The existing private Tailscale owner gate remains in front of every route, including the OAuth callback. One configured store belongs to each MetricTV instance; there is no public account signup, store switching, TV pairing or tenant administration yet.

## What the connection flow does

1. The authorized owner opens the live board's Connection page.
2. A configured, disconnected instance offers **Connect Shopify** for its configured store.
3. A same-origin, CSRF-protected request starts Shopify's standalone authorization flow.
4. Shopify handles login and app-install approval on its own domain.
5. MetricTV validates the signed callback, browser state, initiating owner and store before exchanging the code for an expiring offline grant.
6. The server encrypts the grant on disk and starts a real read-only sync using the existing fixed queries and reporting calculations.
7. Background collection renews expiring credentials. Revocation requires reconnecting; it never silently substitutes CLI authorization or sample figures.
8. **Disconnect from MetricTV** removes local credentials and clears the snapshot. It does not uninstall the app from Shopify or revoke Shopify's app installation. Uninstalling is a separate action in Shopify.

A successful authorization is not a successful initial data read. Until a valid snapshot is available, the board shows sync/error state rather than invented zero figures. Read-only scopes do not make order and inventory totals public information.

## Before activation

No dedicated MetricTV app has been created or installed by this implementation. Real Shopify authorization cannot be verified until the owner supplies an approved app configuration and completes Shopify's approval screen. Synthetic token/API responses in automated tests exercise protocol and failure handling only; they are not evidence of a live installation.

For this single-store private pilot, create a dedicated standalone/non-embedded app using the appropriate Shopify organization/distribution setup. A Partner app with custom distribution can target one merchant; do not reuse that route as public distribution to unrelated stores. Public distribution needs Shopify's review and the additional release gates in SECURITY.md.

Configure:

- Application URL: the private live board's HTTPS origin.
- Allowed redirect URL: that exact origin plus `/auth/shopify/callback`.
  -- Read-only scopes: `read_all_orders,read_orders,read_products,read_inventory`.
- `read_all_orders` enables historical orders for 30 and 60-day windows with equal-length comparisons. No write scopes, customer identity fields or additional integrations.
- The browser completing authorization must be able to reach the private Tailscale HTTPS origin. Shopify's browser redirect does not require a public callback listener. This does not make the private instance suitable for Shopify-to-server webhooks.

For the existing approved private deployment, the callback is:

`https://<private-host>/auth/shopify/callback`

Do not publish this private deployment or its business data, change Tailscale listeners, create accounts/apps, install the app or widen scopes without approval. The source code alone does not register these settings with Shopify.

## Server configuration

Keep the existing `SHOPIFY_STORE`, `LIVE_ALLOWED_USERS`, `LIVE_ORIGIN` and `PORT` settings. Add these through a private server environment or secret manager, not browser forms, chat, committed files or shell arguments:

| Setting                        | Meaning                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `SHOPIFY_AUTH_MODE`            | `oauth` enables the dedicated app adapter. Omitted or `cli` preserves the old pilot.                      |
| `SHOPIFY_CLIENT_ID`            | Dedicated Shopify app client ID.                                                                          |
| `SHOPIFY_CLIENT_SECRET`        | Dedicated app secret, server-only.                                                                        |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | Canonical base64 encoding of 32 cryptographically random bytes; retain it securely across restarts.       |
| `SHOPIFY_TOKEN_STORE_PATH`     | Absolute path to the encrypted credential file in a private location outside the project and public root. |

Do not reuse the Shopify app secret as the encryption key. Losing or changing the encryption key makes stored grants unreadable; restore the correct key or intentionally reconnect after handling the old encrypted file. Corruption is a fail-closed error, not permission to delete unknown files or fall back to the CLI.

The credential directory must be private, and files must not be symlinks. The token store enforces restrictive permissions, bounded reads, authenticated encryption and atomic writes. Encrypting credentials protects accidental file disclosure, not a fully compromised host that also has the key. Restrict the operator/service account and maintain backups/secret handling accordingly.

Install pinned dependencies with `npm ci --ignore-scripts`, then run the existing `npm run start:live` with the approved private environment. An OAuth instance with no app configuration shows setup required. Malformed or unsafe configuration must fail closed. A normal CLI instance remains a CLI pilot and does not pretend that the real app is configured.

## Verification and limits

### Storage-failure recovery

- If the configured path contains an unrecognized file, reconnect and disconnect refuse to overwrite or delete it. Stop the instance, inspect the path, and preserve or move that file only with the owner's approval before correcting the configuration.
- A failed local disconnect returns an error even though in-memory figures are cleared. The encrypted file may still exist and can be loaded after a restart. Do not report access removed until the disk problem is fixed and local deletion succeeds; uninstall in Shopify if remote access must be revoked immediately.
- If Shopify rotates a refresh token but its encrypted disk write fails, the instance may require a new authorization after storage is repaired. It does not use an unpersisted new access token or fall back to CLI. Keep the private credential directory owned by the service user with mode 0700, monitor writable storage, and reconnect after correcting a write failure.

Run `npm run format`, `npm run check`, `npm test` and `npm audit`. Focused tests cover signed callback validation, CSRF, replay/store/owner binding, encrypted persistence, token renewal/revocation, fixed-query transport, cache invalidation and honest UI states. Exercise actual HTTP routes and browser behavior separately before declaring the slice ready.

Activation acceptance is a real merchant approving the dedicated app, an actual post-callback Shopify read, encrypted persistence across a process restart, and verified reconnect/disconnect behavior. Do not report this gate passed on synthetic tests alone.

Public release still requires independent account authentication and tenant isolation, display-only pairing/revocation, supported uninstall and required privacy webhooks on a reachable endpoint, deletion/retention policy, operational controls, and the applicable Shopify distribution/review process. The private collector detects lost access on API reads; it does not claim public webhook-driven uninstall handling.

## Primary references

- https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
- https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
