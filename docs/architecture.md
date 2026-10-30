# Architecture

## What runs

One Node process and one SQLite file. No other service is needed.

| Command | What it is |
| --- | --- |
| `npm start` (`server/demo.mjs`) | The sample board: fictional data, no API, no database, no accounts. |
| `npm run start:server` (`server/main.mjs`) | The app: landing page, sample, owner page (`/app`, `/register`), TV page (`/tv`), the JSON API and `/healthz`. It listens on `127.0.0.1` only; an HTTPS reverse proxy sits in front ([`deploy/Caddyfile`](../deploy/Caddyfile)). |
| `npm run admin` (`scripts/admin.mjs`) | Operator commands on the same database. Never reachable over HTTP. |

Outside the process there are two services: Shopify's Admin API (read-only GraphQL) and Resend (sign-in codes).

What is kept where:

- **SQLite file:** accounts, sessions, sign-in rate limits, workspaces, screens, store links.
- **One encrypted grant file per connected store:** the Shopify credentials.
- **Memory only:** store figures, logos and the pairing rate limiters. All of it is rebuilt on demand after a restart.

## How a request is handled

`server/app.mjs` only routes. In order:

1. The `Host` header must be the configured origin's host (`assertExpectedHost`).
2. `parseRequestPath` refuses a malformed target: not starting with a single `/`, control characters, backslashes, broken percent-escapes.
3. `/api/auth/*` goes to `accounts/auth-gateway.mjs`, the one door to Better Auth. Only send-code, sign-in and sign-out get through.
4. An exact `METHOD /path` match in the route table. Each of `createOwnerRoutes`, `createScreenRoutes` and `createShopifyRoutes` returns a `Map` of handlers, and `app.mjs` joins them with `/healthz`.
5. Otherwise a `GET` or `HEAD` is a static file. `findPublicFile` serves it only if `server/http/public-files.mjs` lists the path, it has no empty or dot segment, is not a dotfile, has an allowed extension, and still lies inside `public/` after symlinks are resolved. Anything else is a 404 or 405.

A handler throws `RequestRejection(status, code)` for an expected refusal, which is answered as `{ "error": code }`. Any other error is logged by name only and answered `500 server_error`. A raw upstream error never reaches a browser.

Who may call what, in short (details in [auth-and-pairing.md](auth-and-pairing.md)): owner routes find the owner from the session cookie, and routes that change something also need the exact `Origin`, a JSON content type and the session-bound CSRF token (`requireCsrfSession`). TV routes use their own cookies. No route accepts a workspace or a store from the request.

## Where the store figures come from

```
Shopify Admin API → shop-data.mjs → metrics.mjs → snapshot cache → owner page  (full snapshot)
  fixed queries     pages of orders   pure maths   one per store  → TV page     (display-board.mjs removes
                                                                                  links, domain, details)
```

1. An owner page or a TV polls (`GET /api/shopify`, `GET /api/display`). `connection-service.mjs` finds the workspace's runtime (`workspace-runtimes.mjs`) and asks it to refresh.
2. A refresh starts only when the figures are due (two minutes since the last start), none is running for that store, and fewer than two are running overall. Otherwise the poll simply gets the cached figures. Nothing runs on a timer, so a store nobody is watching costs nothing.
3. `snapshot-cache.mjs` calls `fetchShopData` (`shop-data.mjs`): fixed GraphQL queries, 130 days of orders in pages of 100, sent through the bounded transport (`http.mjs`, `admin-runner.mjs`) with the workspace's grant (`grant-manager.mjs` renews it, `token-store.mjs` keeps it encrypted). Then `buildSnapshot` (`metrics.mjs`, pure) computes the periods, charts, backlog and attention items in the store's own time zone.
4. The cache keeps the last good snapshot. A failed refresh keeps the old figures and records a safe error code; figures older than five minutes, or with an error, are reported `stale`. The pages say so. A failure is never shown as zero.
5. The owner page receives the full snapshot. The TV receives `projectBoardForDisplay`: no store domain, no admin links, orders reduced to number, time, amount and status. Both pages check the snapshot with `shared/snapshot-validation.js` before drawing it.

## Folder map

| Folder | Responsibility |
| --- | --- |
| `server/` | `main.mjs` starts, `app.mjs` routes, `config.mjs` reads settings, `metrics.mjs` computes snapshots, `housekeeping.mjs` purges expired rows hourly, `demo.mjs` serves the sample |
| `server/http/` | `guards.mjs` (host, origin, JSON bodies, cookies), `static-files.mjs` (safe file serving, security headers), `public-files.mjs` (which files each server may serve), `rate-limiter.mjs`, `client-address.mjs` (the network a visitor is counted under, and the trusted proxy header) |
| `server/accounts/` | `auth.mjs` and `auth-gateway.mjs` (Better Auth, invite-only), `owner-session.mjs` (session and CSRF), `owner-routes.mjs`, `workspaces.mjs`, `registration.mjs`, `mail-transport.mjs`, `private-database.mjs`, `accounts.mjs` (what `npm run admin` calls) |
| `server/screens/` | `screens.mjs` (pairing and display sessions in SQLite), `screen-routes.mjs`, `display-board.mjs` (what a TV may see), `app-version.mjs` |
| `server/shopify/` | `config.mjs`, `connect-flow.mjs` (OAuth), `connection-service.mjs` (the facade the routes use), `workspace-runtimes.mjs` (per-store grant, cache, logo, refresh), `snapshot-cache.mjs`, `shop-data.mjs` (queries and paging), `grant-manager.mjs`, `token-store.mjs`, `sdk.mjs`, `http.mjs`, `admin-runner.mjs`, `links.mjs`, `shop-logo.mjs`, `routes.mjs` |
| `public/landing/`, `demo/`, `owner/`, `tv/` | One folder per page: its HTML, its controller (`demo.js`, `owner.js`, `tv.js`), `*-view.js` (pure HTML), `*-client.js` (server calls), its own `*.css` |
| `public/shared/` | What the pages share: `styles.css` (tokens, header, buttons, forms), `board.css`, `board.js` (renders any board), `board-model.js` (snapshot to view model), `format.js`, `periods.js`, `ui.js`, `api-client.js`, `snapshot-validation.js` |
| `tests/` | See [testing.md](testing.md) |

A page links `styles.css`, then `board.css` if it shows a board, then its own stylesheet. A page never imports another page's folder.

## Where to add what

| To add… | Touch |
| --- | --- |
| **A metric on the board** | compute it in `server/metrics.mjs`; accept it in `shared/snapshot-validation.js`; shape it in `shared/board-model.js`; draw it in `shared/board.js`; add it to `server/screens/display-board.mjs` (a field not copied there never reaches a TV); give the sample the same field in `demo/demo-board.js`; add tests |
| **A reporting period** | the table in `shared/periods.js`, the windows in `server/metrics.mjs`, `PERIOD_VALUES` in `server/accounts/workspaces.mjs`. That file also has a SQL `CHECK` on the allowed periods, in a table that already exists on every deployed database, so a new period needs a schema migration too (see "A table or column"). `tests/server/settings-contract.test.mjs` fails until the lists agree |
| **A page** | a folder under `public/`; the URL in `APP_PAGES` and every file in `APP_PUBLIC_FILES` (`server/http/public-files.mjs`); styles linked in the order above (`tests/browser/app-shell.test.mjs` checks it) |
| **An API route** | the handler goes in the route module that owns the path, or a new `create…Routes` that returns a `Map` and is spread into the table in `app.mjs`. A route that changes state calls `requireCsrfSession` first. Test it over real HTTP with `startAppServer` |
| **A setting** | read and validate it in `server/config.mjs` (or the `load…Config` of the module that owns it), fail at start on a bad value, add it to `.env.example` and `docs/self-hosting.md`, test the refusal |
| **A table or column** | the schema text lives with the module that owns the table (`SCREEN_SCHEMA`, `SHOPIFY_SCHEMA`, `WORKSPACE_SCHEMA`). `CREATE TABLE IF NOT EXISTS` never alters an existing table, so changing one is a numbered migration: bump `SCHEMA_VERSION` in `accounts/accounts.mjs`, make `applySchema` upgrade the old shape, and say so in the upgrade notes. The server refuses to start on any other version |
| **A Shopify query** | add it to `QUERIES` in `shop-data.mjs`. The runner accepts only names listed there. A new OAuth scope makes every owner reconnect: avoid it |

## Reuse before writing

Server: `sendJson`, `readJsonObject`, `assertSameOriginJson`, `buildCookie`, `readCookie` (`http/guards.mjs`); `findPublicFile`, `sendPublicFile`, `createSecurityHeaders` (`http/static-files.mjs`); `createRateLimiter`; `sha256Hex`, `constantTimeEqual` (`hashing.mjs`); `inTransaction` (`accounts/private-database.mjs`); `CodedError` (`errors.mjs`); `logEvent` (`log.mjs`, one JSON line on stderr: ids, error names and safe codes only); `createSnapshotCache`.

Browser: `escapeHtml`, `hasOwn`, `money`, `percentChange`, `normaliseStore` (`shared/format.js`); `PERIODS` and the option lists (`shared/periods.js`); `messageHtml`, `optionsHtml`, `actionButton`, `statusDot`, `brandLink`, `safeShopifyAdminUrl` (`shared/ui.js`); `renderBoard` (`shared/board.js`); `sendRequest` (`shared/api-client.js`, returns a failure as a value instead of throwing).

## Capacity and growth

**The shape.** One process, one SQLite file. The browsers' polling is the only scheduler. Each store's figures are computed once and shared by all of its screens, so ten TVs on one store cost one Shopify read per refresh.

**Built in early on purpose.** Each of these is cheap now and expensive to add once many screens run old code:

- A store refreshes when someone reads it and it is due, never on a timer; at most two refreshes run at once. A busy server makes figures older ("stale"), not wrong.
- The TV learns its poll pace from the server (`pollSeconds` in `/api/display`) and spreads its reload after a deploy over a minute. The whole fleet can be slowed down, and a deploy does not stampede, without touching any screen.
- Everything that grows is bounded: pages of orders, request bodies, open pairing codes, open store connections, rate-limiter keys. An hourly purge (`housekeeping.mjs`) keeps the database small.
- A screen writes its "last seen" time once a minute and renews its pairing once a day, not on every poll.
- The date formatter is built once per time zone (a refresh of 10,000 orders went from 1.2 s to 0.16 s).
- `/healthz` answers `ok` or `unavailable` for uptime monitors and container probes.
- SQL lives only in `accounts/`, `screens/screens.mjs` and `shopify/links.mjs` (plus Better Auth's own tables), so a different database touches those files only.

**What it carries today.** Each limit is a named constant with a `// ceiling:` comment saying what it is and when to change it. `grep -rn "ceiling:" server` lists them. The numbers are estimates from the code, not benchmarks.

| Limit | Today | Change it when |
| --- | --- | --- |
| Orders read per refresh (`MAX_PAGES` in `shop-data.mjs`) | 10,000; a bigger store is reported as incomplete | a store needs more: build an incremental sync that keeps orders between refreshes |
| Refreshes at once (`MAX_CONCURRENT_REFRESHES`, `workspace-runtimes.mjs`) | 2, about 60 stores kept fresh at 4 s a refresh | stores turn stale while the server is otherwise idle: raise it |
| Screens polling (`DISPLAY_POLL_SECONDS`, `screen-routes.mjs`) | about 1,000 screens at 10 s, 100 requests a second | raise the pace value (every screen follows within one poll), then answer unchanged boards from a cache |
| Stores held in memory (`workspace-runtimes.mjs`) | about 20 KB each plus a logo up to 1 MiB | thousands of stores are linked: evict idle ones |
| Open pairing codes (`MAX_OPEN_CHALLENGES`, `screens.mjs`) | 200, about 40 screens pairing a minute | a large fleet starts at once: per-address caps |
| Open store connections (`MAX_OPEN_ATTEMPTS`, `links.mjs`) | 50 | many owners connect at once: per-workspace caps |
| The hourly purge (`housekeeping.mjs`) | one synchronous pass: about 15 ms to scan 500,000 live rows, 0.4 s to delete 500,000 expired ones | the pause shows up: delete in batches |
| One SQLite file, one process (`private-database.mjs`) | one instance | a second instance is needed: Postgres |
| Rate limiter counters (`rate-limiter.mjs`) | in process | a second instance is needed: a shared counter store |
| What a limit counts (`networkOf`, `http/client-address.mjs`) | an IPv4 address or an IPv6 /64 | a client with a larger IPv6 block rotates past a limit: count a shorter prefix |

**Order of moves when it grows.** Measure first (`/healthz`, the journal, whether stores turn stale). Then the cheap knobs: the concurrency and pace constants above, a bigger server. Then incremental sync for very large stores. A second instance is the one real step: it needs Postgres and shared limiters, and each instance would keep its own figures in memory, which doubles Shopify reads until that cache is shared. Everything before it fits in one process.

**Deliberately not built yet:** a job queue, background workers, websockets or server-sent events, Redis, a CDN. Polling works on old TV browsers and fits the numbers above; each of these is an extra thing to run for a problem the table shows we do not have. Static files and API answers are sent `Cache-Control: no-store`, which keeps deploys simple: a reloaded TV can never be handed an old file from a cache. When page weight matters, add ETags to the static files first.

## Names that never change

These are stored on disk, registered outside this repository or held by open browser tabs. Renaming one signs owners out, unpairs TVs, orphans encrypted grants or breaks the Shopify app configuration. `tests/server/stable-identifiers.test.mjs` asserts them, and several still say "beta" for that reason.

- Owner session cookie prefix `metrictv_beta` (`accounts/auth.mjs`), and the CSRF label `beta-csrf` (`accounts/owner-session.mjs`).
- TV cookies `metrictv_tv_challenge` and `metrictv_tv_display` (`__Host-` prefixed on https).
- The Shopify redirect path `/auth/beta/shopify/callback`, which each operator registers in their own Shopify app, and the cookies `metrictv_beta_oauth_state` (with `.sig`) and `metrictv_beta_oauth_bind`.
- The database layout and `PRAGMA user_version`, the grant file names `<workspace-id>.grant.json` and the encryption binding data in `token-store.mjs`.
- `/api/auth`, `/api/display*`, `/api/tv/*`, which pages already open in browsers and on TVs call.

## TV code stays in the field

A TV runs the page code it loaded until its own reload logic replaces it, so a gap in that logic stays on every screen until someone walks up to it. That is why the TV page has these from the start, and why new fleet-wide behaviour is added to the TV page early:

- It compares the `appVersion` of every display answer with its own and reloads when it changes (`server/screens/app-version.mjs` fingerprints the served files).
- It spreads that reload over a minute (`RELOAD_SPREAD_MS`).
- It polls at the pace the server names (`pollDelayMs`, kept between 5 seconds and 5 minutes).
- It never stops on a surprise: an error shows on screen and the page starts over after 15 seconds.

What the server sends may change shape in the same release as the page that reads it. A screen compares `appVersion` before it draws, so old page code reloads instead of drawing an answer it cannot read (`tests/browser/tv-flow.test.mjs`: "newer page code reloads the page before anything is drawn from the new answer"). Keep that order in `tv.js`: version first, then draw.

TVs also have old browsers. Every module a TV loads (everything in `tv/` plus the `shared/` modules it imports) must avoid `Object.hasOwn`, `replaceAll`, `.at()`, `AbortSignal.timeout` and `AbortSignal.any`, `structuredClone`, `findLast`, `toSorted` and `Object.groupBy`. Use `hasOwn` from `shared/format.js` instead of `Object.hasOwn`. `tests/browser/tv-startup.test.mjs` fails on any of them, and on a TV module that imports from `owner/` or `demo/`.
