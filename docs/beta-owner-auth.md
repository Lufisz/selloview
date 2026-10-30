# MetricTV invite-only beta: owner login and workspaces

Status: implemented foundation, loopback only. It is a separate entry point from the fictional demo
(`server.mjs`), which does not serve the beta page files.

Added since: a workspace-scoped, read-only Shopify store connection restricted to one pilot owner
and one exact store (see "Shopify store connection" below). Not implemented: account deletion,
email change, uninstall/privacy webhooks, public sign-up. Nothing here is public hosting:
exposing it needs a separately approved tunnel or proxy, a domain and an email provider.

## What it does

- [Better Auth](https://www.better-auth.com) 1.7.14 with the `emailOTP` plugin owns users, sessions,
  one-time codes (stored hashed, 6 digits, 5 minutes, 3 attempts) and rate limits (stored in SQLite).
- SQLite is Node's built-in `node:sqlite` (`DatabaseSync`, Node 22.5+) in one private file.
- Invite only: the runtime cannot create users (`databaseHooks.user.create.before` refuses) and the
  email-OTP plugin runs with `disableSignUp`. Accounts exist only because an operator ran
  `beta:invite` for that exact email. Unknown emails get the same response but no code is sent.
- One owner, one workspace (UNIQUE owner column), created at invite time and stable across restarts.
  The workspace is always derived from the server-side session, never from the request.
- Per-workspace appearance settings (period, theme, revision) live in the same database, behind the
  session, exact `Origin`, JSON content type and a session-bound CSRF token.
- Only three Better Auth endpoints are reachable: send code, sign in with code, sign out. All others
  (sign-up, password, social/linking, email change, session listing, `/get-session`) return 404, both in
  the HTTP layer and inside the library (`disabledPaths` plus a `hooks.before` allowlist).
- Cookies: `HttpOnly`, `SameSite=Strict`, 7-day expiry, `Secure` and `__Secure-` prefix whenever the
  configured origin is https. Sign-out and `beta:revoke` delete the session rows.

## TV pairing and display sessions

Schema version 3 (`PRAGMA user_version`; run `npm run beta:migrate` on an older database, the
server refuses to start on any other version). Code: `server/beta/screens.mjs` (storage),
`screen-routes.mjs` (HTTP), `rate-limiter.mjs`; pages `public/tv.html`, `tv.js`.

1. `/tv` calls `POST /api/tv/challenge`. The server stores a hashed random challenge secret and a
   hashed 8-symbol code (40 bits, no look-alike characters) for 5 minutes, sets the secret in an
   HttpOnly `SameSite=Strict` cookie and returns only the visible code. A page asking again replaces
   its own earlier challenge; at most 200 challenges are open at once.
2. A signed-in owner submits code and screen name to `POST /api/beta/screens/pair` (exact Origin,
   JSON, session CSRF token). This only marks the challenge approved for that owner's workspace;
   wrong, expired and used codes give one identical answer, so a code never reveals an owner.
3. The TV polls `GET /api/tv/pairing` and, once approved, `POST /api/tv/pairing/exchange`. Only the
   holder of the challenge cookie can do this, once; the challenge row is deleted in the same
   transaction that creates the display session (opaque cookie, SHA-256 hash stored, fixed 30 days,
   never extended).
4. `GET /api/display` returns the screen name, the workspace's period/theme/revision, the server's
   clock (`serverTime`, so a TV with a wrong clock still judges staleness correctly), an honest
   `storeConnection` state and, only for a connected pilot workspace, a display-only `board`. Owners list their screens (`GET /api/beta/screens`) and remove
   one (`POST /api/beta/screens/revoke`); removal takes effect on the next request. A workspace holds
   at most 10 screens. Display cookies are not accepted by any owner endpoint and vice versa.

On https origins the cookies are `__Host-` prefixed and `Secure`. Rate limits are in memory (a
restart clears them): 6 new codes/min per address, 240 TV requests/min per address, 40 pairing polls
and 30 display polls/min per credential, 10 approvals/min and 5 failed codes per 5 minutes per owner
(the owner is then locked out of approving until the window ends, even with a correct code). The
address is the socket address unless `BETA_TRUSTED_IP_HEADER` is set. Tests: `tests/beta-screens*.test.mjs`.
Real TV browsers were not tested, and no browser rendering of `/tv` or Screens was exercised.

## Setup (all local; nothing is sent or exposed)

Choose a private directory outside the project, for example `~/.local/share/metrictv-beta/`.
Environment variables (put them in your service manager or a private env file; never in the repo):

| Variable                                | Meaning                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `BETA_DB_PATH`                          | Absolute path ending in `.sqlite`, outside the project. Never created by the server. |
| `BETA_AUTH_SECRET`                      | Random secret, at least 32 characters (`openssl rand -base64 48`).                   |
| `BETA_ORIGIN`                           | Exact public origin: `https://host` (or `http://127.0.0.1:PORT` for local trials).   |
| `BETA_PORT`                             | Loopback port, default 4330. The listener is always `127.0.0.1`.                     |
| `BETA_RESEND_API_KEY`, `BETA_MAIL_FROM` | Both or neither. Without them code delivery fails closed.                            |
| `BETA_TRUSTED_IP_HEADER`                | Optional, e.g. `cf-connecting-ip`, only if a trusted proxy always overwrites it.     |
| `BETA_SHOPIFY_*`                        | Optional, all six or none: see "Shopify store connection".                           |

```
npm run beta:init                         # creates the 0700 directory and 0600 database; refuses if it exists
npm run beta:invite -- owner@example.com  # registers the exact email; sends nothing
npm run beta:owners                       # emails and workspace ids
npm run beta:revoke -- owner@example.com  # signs that owner out everywhere
npm run beta:migrate                      # after upgrading the package
npm run start:beta                        # http://127.0.0.1:$BETA_PORT, page at /
```

There is no automatic bootstrap: starting the server on a missing database fails.

## Email delivery

The auth layer calls an injected server-only transport. The only production transport is Resend over
HTTPS (`server/accounts/mail-transport.mjs`: 8 s timeout, no redirects, no provider detail leaked). If it
is not configured the send endpoint answers `503 delivery_not_configured` and the page says that no
code was sent. If the provider fails, the page shows a delivery failure. Codes are never logged,
returned, or exposed through a development endpoint. Tests use an in-memory transport that is clearly
synthetic and lives only under `tests/`.

## Known limits

- Rate limiting is keyed on the socket address unless `BETA_TRUSTED_IP_HEADER` is set. Behind a
  tunnel on the same host every client then shares one bucket per path, so one abuser can lock others
  out of sign-in (fail-closed, not a bypass). Configure the header when a trusted proxy exists.
- A code request for an uninvited email returns the same success body as an invited one; delivery
  timing/failure can still reveal invited status to an attacker who can trigger provider errors.
- The session cookie has a fixed 7-day life from sign-in; database expiry slides but the cookie does not.
- `node:sqlite` is marked experimental by Node and prints a warning at start.
- Browser behaviour of `beta.html` was not exercised in a real browser in the build sandbox.
- Better Auth's schema is created by its own migration (`getMigrations`); upgrade with `beta:migrate`.

## Shopify store connection (pilot)

Code: `server/beta/shopify-config.mjs` (settings), `shopify-links.mjs` (SQLite store links and
pending attempts), `shopify-service.mjs` (OAuth, grants, per-workspace cache), `shopify-routes.mjs`
(HTTP), `display-board.mjs` (TV projection). The OAuth protocol, grant renewal and encrypted grant
files are handled by the official-SDK modules `server/shopify-sdk.mjs`, `shopify-grant-manager.mjs`,
`shopify-token-store.mjs`, `shopify-http.mjs` and `shopify-admin.mjs`; the fixed 2026-07 queries and
the 130-day collector are in `server/shopify.mjs`, the metric code in `server/metrics.mjs`.

### Configuration (all six names, or none)

| Variable                                               | Meaning                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BETA_SHOPIFY_CLIENT_ID`, `BETA_SHOPIFY_CLIENT_SECRET` | The Shopify app's credentials, server-only.                                                                                              |
| `BETA_SHOPIFY_ENCRYPTION_KEY`                          | Canonical base64 of 32 random bytes. A new key for the beta; never reuse the app secret.                                                 |
| `BETA_SHOPIFY_TOKEN_DIR`                               | Absolute directory outside the project for per-workspace encrypted grant files (`<workspace-id>.grant.json`, mode 0600, directory 0700). |
| `BETA_SHOPIFY_ALLOWED_STORE`                           | The one exact `*.myshopify.com` host that may be connected.                                                                              |
| `BETA_SHOPIFY_OWNER_EMAIL`                             | The one owner address that may connect it.                                                                                               |

None set: the owner page and TVs say "setup required" and nothing contacts Shopify. Some but not
all, or any malformed value: the server refuses to start (error code only, no values). The Shopify
app must allow the redirect URL `BETA_ORIGIN` + `/auth/beta/shopify/callback`, and no other scopes
than `read_all_orders,read_orders,read_products,read_inventory` (any other scope set in a token
response is refused).

### Rules

- Workspace-bound. Every store read starts from a workspace derived from a verified owner or display
  session. A shop name in a request authorizes nothing. SQLite enforces one store per workspace and one
  workspace per store (`workspace_store`, UNIQUE on both). Other owners get `pilot_unavailable` and never
  data; the pilot restriction (owner and store) is configuration, not part of the data model.
- Owner routes: `GET /api/beta/shopify` (state + validated snapshot), `POST /api/beta/shopify/start`
  (`{store}`), `POST /api/beta/shopify/disconnect` (`{}`). The POSTs need the Better Auth session, the
  exact Origin, JSON and the session-bound CSRF token. The store must be the canonical host.
- The callback `GET /auth/beta/shopify/callback` arrives from Shopify as a cross-site navigation, so the
  SameSite=Strict session cookie is not sent and is not loosened. It is authorized by (1) the SDK's HMAC
  and signed state cookie, (2) a single-use pending attempt stored in SQLite (state hash, binding hash,
  workspace, user, session id, shop, 5 minute expiry; deleted when read, so a replay finds nothing),
  (3) a random binding cookie (HttpOnly, SameSite=Lax, Path = the callback only, `__Secure-` on https)
  whose hash must match, and (4) the initiating Better Auth session still existing and unexpired, owned by
  the pilot owner who owns that workspace. Sign-out, `beta:revoke` or expiry while pending, including
  during the code exchange, cancels the finish. A repeated start replaces the earlier attempt.
- The SDK's state cookies are renamed on the wire (`metrictv_beta_oauth_state[.sig]`, callback-path
  scoped) so they cannot collide with the SDK's default `shopify_app_state` cookies on the same host
  name; the callback restores the SDK names before validation. The callback answer is always a fixed
  303 to `/?shopify=connected|failed` and clears all three cookies.
- Credentials: one encrypted grant file per workspace; the authenticated data binds app client id, store
  **and workspace id**, so a copied file fails to decrypt. A wrong key, corrupt file or missing file is
  `reconnect_required`, never sample data.
- Data: one snapshot cache per workspace, shared by all of its screens and the owner page; singleflight,
  at most two collections in flight overall, at most one per 2 minutes per workspace, started lazily by
  an authorized owner or display poll (no timers, no fetch without a linked authorized workspace).
  Disconnect, revocation and reconnect drop cached figures and ignore results of collections that began
  earlier.
- TV payload: aggregate periods, charts, backlog count, coverage and sync state, plus attention titles
  without links. No store domain or plan, order numbers, Shopify admin links or owner details. The TV
  validates it with the shared snapshot validator and shows nothing it cannot validate.

### Upgrading an existing beta database (schema 2 to 3)

Stop the service, copy the database (`beta.sqlite` plus `-wal`/`-shm`), load the service environment
and run `npm run beta:migrate`; it adds `workspace_store` and `shopify_oauth_attempt` and keeps
accounts, sessions, screens and settings. A version 2 database is refused at startup until migrated.

### Verified, and not

Automated: real HTTP (curl) against the real server, Better Auth and SQLite, with a synthetic Shopify
transport (`tests/beta-shopify-*.test.mjs`); no real Shopify approval, store data or browser has
exercised this code. Activation acceptance needs the pilot owner to approve the app in Shopify, an
actual first read, a restart and a disconnect/reconnect against the deployed origin.
