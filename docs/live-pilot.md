# Private Shopify pilot

The sample-data demo and real-store board are separate entry points and separate servers.

- `npm start`: unchanged static, fictional demo on 4317. Never serves the live API.
- `npm run start:live`: read-only Shopify collector and private board, **127.0.0.1 only**, on 4318 by default.
- `public/live.html` and `public/live.js` never import sample data. All store text is escaped and administrative links are restricted to Shopify HTTPS hosts. No business snapshot or credentials are stored in browser localStorage; only period and theme preferences are saved.

## Authorization

For the opt-in real browser authorization flow, encrypted credentials and dedicated-app setup, see [Dedicated Shopify app connection](shopify-app-connection.md). The following CLI path remains the default; OAuth mode never falls back to it automatically.

This pilot uses Shopify CLI 4.9.4's stored authenticated session, not a copied Admin API token. Authenticate interactively on the server with scopes `read_orders,read_products,read_inventory`. Browser challenges and approval are completed by the owner. Do not paste credentials into this app or chat. The CLI's default mutation protection remains enabled; collection uses fixed read-only queries only.

Prime the CLI once, with the store you own:

```sh
npx --yes --package=@shopify/cli@4.9.4 shopify store auth \
  --store your-store.myshopify.com \
  --scopes read_orders,read_products,read_inventory
```

Collection uses `npx --offline` after that, so it cannot silently install a different version. Offline here applies to npm package resolution, not Shopify's HTTPS API requests.

A CLI session can expire or be revoked. The UI then labels the last successful snapshot as stale, or shows unavailable if none exists. It never substitutes sample numbers. Reauthorize on the server when needed. For unattended production use, replace the CLI adapter with an appropriately distributed dedicated Shopify app using supported token renewal. This pilot is **not** that production installation or a public multi-store OAuth service.

## Private deployment

The backend must sit behind **Tailscale Serve**, which authenticates the incoming Tailscale user and strips spoofed identity headers. The backend trusts those headers only from loopback and checks an explicit owner allowlist and exact configured Host. Local processes on the same computer remain trusted; do not expose 4318 directly or deploy this header trust model behind an untrusted proxy.

Example configuration, replacing these example values with your own:

```sh
SHOPIFY_STORE=your-store.myshopify.com \
LIVE_ALLOWED_USERS=owner@example.com \
LIVE_ORIGIN=https://your-machine.your-tailnet.ts.net:9443 \
PORT=4318 npm run start:live
```

In another terminal, after approving this network change:

```sh
tailscale serve --bg --https=9443 http://127.0.0.1:4318
tailscale serve status --json
```

Do not use `tailscale funnel`. Do not reset Serve or replace other existing listeners. Rollback just this mapping with `tailscale serve --https=9443 off`, then stop this app's server process. The app does not configure firewall rules, change the store, install a daemon or autostart at boot.

Serve must already have HTTPS support enabled. If it asks for account-wide configuration changes, obtain owner approval rather than silently expanding scope. Access-control policy and the app's allowlist are separate checks; a private URL alone is not authentication. TVs need an authorized Tailscale access path for this pilot. Public TV pairing is not implemented.

## Optional shared dashboard settings

Off by default. Without it, reporting period and theme stay in each browser's localStorage and `/api/settings` does not exist (404). To let your owner browsers share those two choices and keep them across server restarts, set `LIVE_SETTINGS_PATH` to an absolute, normalized `.json` path in a private directory outside this project, for example:

```sh
install -d -m 700 "$HOME/.local/share/metrictv"
LIVE_SETTINGS_PATH="$HOME/.local/share/metrictv/dashboard-settings.json" \
SHOPIFY_STORE=... LIVE_ALLOWED_USERS=... LIVE_ORIGIN=... npm run start:live
```

This is a configuration change for the next start only; nothing in the repository enables it, and the running deployment is unchanged until you restart it with the variable.

- Stored: `period` (`today`, `week`, `month`, `days60`), `theme` (`light`, `dark`) and a revision number, bound to the configured store. The file is written atomically with mode 0600. The directory must be owned by you with no group/other access and no symlinks; the file must not be a symlink or hard link, and is limited to 2 KB. A file written for another store, or one that is corrupt or oversized, makes `/api/settings` answer `503 settings_unavailable` and is never overwritten.
- Routes, behind the same loopback/Host/Tailscale-owner gate as everything else: `GET`/`HEAD /api/settings` returns `{ enabled, revision, settings, csrfToken }`; `POST /api/settings` takes `{ revision, settings: { period?, theme? } }` (1 KB limit, JSON only, known fields only). Writes need the exact `LIVE_ORIGIN` as `Origin`, a same-origin fetch and a CSRF token bound to the owner and generated per server process by the settings service. They do not depend on Shopify connection state. Responses are `no-store`.
- A stale `revision` gets `409 revision_conflict` with the current state; the browser adopts it and shows a notice rather than silently overwriting another screen's choice.
- The browser reads settings with each 30 s refresh, discards any read that began before a local change, saves one request at a time, keeps the CSRF token only in memory, and shows a toast when a save fails. A server that has never saved (revision 0) does not override a browser's own preferences; that browser's first change then seeds the shared settings. If the endpoint returns 404, nothing changes from the local-only behaviour.
- The TV route currently shares owner access, so it uses the same settings. Separate TV sessions are still not implemented.

Everything is shared by all allowlisted owners of this one store. This is not per-user preferences, an account system or tenant isolation.

## What is collected

- Store name, currency, timezone and plan.
- Order number, creation/update time, cancellation/test status, financial/fulfillment status and `currentTotalPriceSet.shopMoney`.
- Variant display name, tracked status and inventory quantity.
- No customer names, email addresses, delivery addresses, messages or payment details.

The server caches the display snapshot **in memory**, refreshes every two minutes and coalesces overlapping refreshes. The browser reads that small local cache every 30 seconds. Restarting the server discards the snapshot and initiates a new read. There is no database, order mutation, AI API call, cloud analytics, telemetry script, webhook endpoint or public refresh button. The official Shopify CLI may have its own behaviour outside this app.

## Metric definitions and honest limits

- **Order value** sums Shopify's `currentTotalPriceSet` for orders created in the selected period, excluding test and cancelled orders. It is not labelled Net sales, revenue, profit or cash received. It is not reconciled with Shopify's period-based sales reports, and no independent refund arithmetic is invented.
- **Orders** counts that same set. **Average order** divides that value by that count. A genuine empty successful set is zero; a failed read is not.
- **Last 60 full days**, **Last 30 full days**, and **Last 7 full days** exclude today and compare against the preceding period of equal length in store-local days. **Today** compares against yesterday up to the same local clock time. The chart dynamically matches the selected timeframe: hourly today vs yesterday, daily 7 days vs previous 7, daily 30 days vs previous 30, and daily 60 days vs previous 60.
- 60 days requires 120 full days of history for comparison, enabled by the `read_all_orders` scope on the private app. If the fetched history ever starts after the comparison window, the snapshot fails rather than counting missing days as zero.
- **To fulfill** counts qualifying paid/partially paid/partially refunded unfulfilled or partially fulfilled orders inside the available history, independent of the period selector. More than 24 elapsed hours is overdue. Older pending orders can be missing.
- Only the last **59 elapsed days** are fetched because ordinary order access is limited to 60 days. Collection timestamps, pagination completeness and history limits accompany the snapshot. No all-orders permission is requested.
- Stock alerts use a fixed threshold of **5 or fewer** for tracked variants returned by Shopify. They are not restricted to active products. Inventory and order-query caps are explicit incomplete-data states, not silent totals.
- Store currency is retained. No currency conversion or artificial sales target is applied. The current pilot was exercised in a two-decimal currency; arbitrary currency precision needs verification before multi-store release.
- Traffic, views, sessions, inbox/messages, GA and historical sales-report parity are not implemented.

## Code map

- `server/shopify.mjs`: fixed CLI queries, output parsing and pagination.
- `server/metrics.mjs`: pure local-day aggregation and display snapshot.
- `server/live-server.mjs`: owner authorization, static files and cached snapshot endpoint.
- `server/static-files.mjs`: shared file confinement, security headers and HTTP resource limits.
- `public/live.html`, `public/live.js`, `public/live.css`: live entry, state/events and styles, separate from simulated setup.
- `public/live-client.js`: same-origin fetch and complete validation of fields used by the views.
- `public/live-view.js`: pure live view models and page templates with explicit currency/timezone inputs.
- `public/board.js`, `public/ui.js`, `public/model.js`: shared presentation, safe UI helpers and formatting; no fixtures, fetching or live global state.
- `tests/live-*.test.mjs`: synthetic unit and HTTP boundary tests.
- `tests/browser_live_qa.py`: checks a running authorized live board against its actual snapshot, plus explicitly injected network/auth failures. It does not manufacture store data.
- `tests/deployment_live_qa.py`: non-mutating checks on the real HTTPS route, security headers, unauthorized backend requests, methods, private paths and proxy identity-header replacement. Requires `LIVE_BASE_URL` and `LIVE_TEST_OWNER` (the allowlisted non-secret identity).

## Verification

```sh
npm run check
npm test
LIVE_BASE_URL=https://your-machine.your-tailnet.ts.net:9443 \
QA_OUTPUT="$TMPDIR/metrictv-live-qa" \
python3 tests/browser_live_qa.py
```

Optional `CHROME` sets a Chromium path. `HTTP_BRIDGE=1` transports **actual** HTTPS/Serve responses through Python if Chromium's direct network is blocked by the host; preserve their status, headers and bytes. Test this separately from the proxy's real network and authorization checks. Screenshot files contain private business information: keep the QA directory private and out of Git/public assets.

Before publishing: choose a name and licence, replace personal deployment configuration, inspect all source/test/screenshot artifacts for private data, use a dedicated supported app-auth flow, and independently review multi-tenant isolation and display-session design. Nothing is published by this pilot.
