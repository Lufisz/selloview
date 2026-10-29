# Live backend contract (CLI pilot)

This document defines the adapter, pure metrics and HTTP boundary for the private live pilot. See `live-pilot.md` for owner setup, deployment and operational limits.

Runtime is dependency-free Node ESM. The existing static demo is a separate server. The adapter uses cached Shopify CLI 4.9.4 with the approved `read_orders,read_products,read_inventory` scopes. Credentials remain managed by CLI, not this app. This is explicitly an online CLI-session pilot, not a permanently installed public app.

## Shopify adapter

Use execFile argument arrays, never a shell:

`npx --offline --yes --package=@shopify/cli@4.9.4 shopify store execute --store ENV_STORE --query FIXED_QUERY --variables JSON --version 2026-07 --no-input --json`

ENV_STORE is read from SHOPIFY_STORE and validated as a strict myshopify.com hostname. FIXED_QUERY means one of the exact fixed queries below; never accept requests containing queries or store URLs. All interpolation here is in application variables, not user-facing CLI commands.

Set SHOPIFY_CLI_AGENT_INFO to `n:hermes-agent|v:none|p:openai-codex|m:gpt-6.1-sol` and SHOPIFY_CLI_AGENT_IDS to empty. Timeout 60s, bounded maxBuffer. CLI emits JSONL progress events followed by pretty JSON. Parse the result robustly; detect API errors. Never log or expose stdout/stderr/credentials/query results on failures. Inject the query runner in tests.

Validated against 2026-07:

```graphql
query DashboardShop {
  shop {
    name
    myshopifyDomain
    currencyCode
    ianaTimezone
    plan {
      publicDisplayName
    }
  }
}
query DashboardOrders($query: String!, $after: String) {
  orders(first: 100, after: $after, sortKey: CREATED_AT, query: $query) {
    nodes {
      id
      name
      createdAt
      updatedAt
      cancelledAt
      test
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
query DashboardInventory($after: String) {
  productVariants(first: 100, after: $after) {
    nodes {
      id
      displayName
      inventoryQuantity
      inventoryItem {
        tracked
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Fetch orders created between a fixed collection cutoff minus 59 days and that cutoff (read_orders only covers 60). Use the same cutoff for metric calculation. Paginate all pages, dedupe by ID, detect repeated cursors and cap at 100 pages per connection. A cap must produce an explicit incomplete flag rather than quietly returning a complete total. Inventory query covers all accessible variants; do not claim active products only.

## Metrics

'Order value' is the sum of Shopify currentTotalPriceSet for non-test, non-cancelled orders created in the selected period. NOT Net sales, cash received, profit or a reconciled period-based Shopify sales report. Do not claim refund behaviour beyond the exact field. Reject malformed amounts, currency mismatches and invalid dates instead of converting them into zeros.

Week: last seven COMPLETE store-local days, versus preceding seven. Today: current store-local day, versus yesterday up to the same local clock time. Use Intl date parts and plain-date day arithmetic so DST boundaries work. Chart: 14 complete local days split into two arrays of seven.

Recent orders: last eight qualifying orders descending createdAt; no names, emails, addresses, country, line items or messages. Backlog: fetched coverage only, non-test/non-cancelled, financial statuses PAID/PARTIALLY_PAID/PARTIALLY_REFUNDED, fulfillment UNFULFILLED/PARTIALLY_FULFILLED (confirm actual enum values). Overdue means more than 24 elapsed hours. Low stock: tracked variants with inventoryQuantity <= 5. Attention max three concise factual items. Empty arrays and zero totals are valid only for real successful empty responses. Always note that older order backlog is unavailable.

Snapshot shape:

```json
{
  "source": "shopify",
  "shop": {
    "name": "string",
    "domain": "string",
    "currency": "EUR",
    "timeZone": "Europe/Stockholm",
    "plan": "Basic"
  },
  "fetchedAt": "ISO instant",
  "coverage": {
    "since": "ISO instant",
    "until": "ISO instant",
    "historyDays": 59,
    "ordersComplete": true,
    "inventoryComplete": true,
    "notes": []
  },
  "periods": {
    "week": {
      "label": "date range",
      "comparisonLabel": "compared with previous 7 full days",
      "current": { "valueCents": 0, "orders": 0, "averageCents": 0 },
      "previous": { "valueCents": 0, "orders": 0, "averageCents": 0 }
    },
    "today": {
      "label": "date",
      "comparisonLabel": "compared with yesterday at same local time",
      "current": { "valueCents": 0, "orders": 0, "averageCents": 0 },
      "previous": { "valueCents": 0, "orders": 0, "averageCents": 0 }
    }
  },
  "chart": {
    "current": [{ "date": "YYYY-MM-DD", "label": "weekday", "valueCents": 0 }],
    "previous": []
  },
  "recentOrders": [
    {
      "number": "order number",
      "createdAt": "ISO instant",
      "amountCents": 0,
      "paymentStatus": "enum",
      "fulfillmentStatus": "enum",
      "url": "https Shopify admin URL"
    }
  ],
  "attention": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "url": "optional safe Shopify URL"
    }
  ],
  "backlog": { "count": 0, "overdueCount": 0 },
  "inventory": { "trackedVariants": 0, "lowCount": 0 },
  "metricDefinition": "plain exact definition"
}
```

Numbers above document the shape only, not fabricated live responses.

## HTTP server

Bind ONLY 127.0.0.1, PORT default4318. Require SHOPIFY_STORE, LIVE_ALLOWED_USERS and LIVE_ORIGIN. LIVE_ORIGIN is an HTTPS origin and its hostname/port must match request Host. Every request must have a loopback socket address and an exact case-insensitive Tailscale-User-Login match in LIVE_ALLOWED_USERS. Reject missing, duplicate/array or comma-separated identity headers. Fail closed if configuration is missing. This trusts only the local Tailscale Serve proxy, which strips spoofed identity headers; never bind this backend to LAN or tailnet interfaces.

GET/HEAD only; other methods 405, no CORS. Serve / as public/live.html. Static files restricted to public root and css/js/svg/html extensions, dotfiles and traversal denied. No endpoints accepting user-supplied queries, stores, refreshes or paths outside public.

/api/snapshot returns last good snapshot plus sync state:

```json
{
  "sync": {
    "state": "ok or stale or loading or error",
    "lastSuccessAt": "ISO or null",
    "lastAttemptAt": "ISO or null",
    "errorCode": "safe code or null"
  }
}
```

If no good snapshot exists, use status503 with structured state and no manufactured metrics. In-memory cache only, start sync after listen, then every120s, singleflight. On failure preserve last good snapshot and mark stale. Age beyond5min is stale even if no recent attempt. No expensive per-request CLI calls. Export server construction and cache helpers for tests; start only when invoked as entrypoint.

Headers: CSP default-src self; script-src self; style-src self unsafe-inline; img-src self data; connect-src self; object-src none; base-uri none; frame-ancestors none. Also no-store, nosniff, no-referrer, X-Frame-Options DENY. No sensitive request logging.

Tests: auth/Host/socket/method/path boundaries, anonymous failures, pagination/partial flags, genuine empty-data zero, invalid currency, timezone/DST and same-time-today comparison, failed refresh preserves old data. Explicit synthetic fixtures only. Run node --test tests/live-*.test.mjs.
