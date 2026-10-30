# Sign-in, TV pairing and the Shopify connection

How people and devices prove who they are, and what each may do. Read it before changing any of `server/accounts/`, `server/screens/` or `server/shopify/`. [SECURITY.md](../SECURITY.md) lists the trust boundaries this implements.

| Who | Proves itself with | May | May not |
| --- | --- | --- | --- |
| Owner | a session cookie from an emailed code; a CSRF token for anything that changes state | read and change their own workspace: settings, screens, store connection | touch another workspace, or send a workspace or store id the server would believe |
| TV | a display cookie from pairing | read the display board of its workspace | call any owner route; see the store domain, admin links or owner details |
| Operator | shell access to the server | `npm run admin -- …` | nothing is reachable over HTTP |
| Shopify's redirect | state cookies, a binding cookie and a pending attempt | finish the one connection that was started | anything else |

Every route starts from a verified session or display cookie. No route reads an owner, workspace or store from the request; the workspace is whatever the session or the display session belongs to.

## Owner sign-in

- [Better Auth](https://www.better-auth.com) with its `emailOTP` plugin owns users, sessions, one-time codes (stored hashed; 6 digits, valid 5 minutes, 3 attempts) and the sign-in rate limits (stored in SQLite). The settings are named constants at the top of `server/accounts/auth.mjs`.
- **Invite only.** The running server cannot create a user (`databaseHooks.user.create.before` refuses). An account exists because an operator ran `npm run admin -- invite <email>`, or, only when [self-service registration](#self-service-registration-optional) is on, because an emailed code proved the address and there is room. A code request for an uninvited address gets the same answer as for an invited one, and nothing is sent.
- **Three endpoints only.** Of Better Auth's endpoints, a browser can reach send-code, sign-in and sign-out. Everything else (sign-up, passwords, social login, email change, session listing) answers 404, both in `accounts/auth-gateway.mjs` and inside the library (`disabledPaths` and a `hooks.before` allowlist). Better Auth's bodies are never passed through; only its cookies and its rate-limit delay are.
- **One owner, one workspace** (`workspace.owner_user_id` is `UNIQUE`). Its settings (period and theme, plus a revision that lets screens notice a change) live in SQLite and change only through `POST /api/settings`.
- **Cookies** are `HttpOnly` and `SameSite=Strict`. When the origin is https they are also `Secure` and carry the `__Secure-` prefix. A session lasts 7 days. Sign-out and `npm run admin -- revoke <email>` delete the session rows.
- **State-changing requests** need the exact `Origin`, `Sec-Fetch-Site: same-origin` when the browser sends it, a JSON content type, a body of at most 2 KiB with exactly the expected keys, and the CSRF token in `X-CSRF-Token`. The token is an HMAC of the session id (`server/accounts/owner-session.mjs`); the page keeps it in memory only.
- **Rate limits** for sign-in: 3 code requests, 6 sign-ins and 20 sign-outs a minute per client address, 30 for anything else.

## Self-service registration (optional)

Off by default. `METRICTV_SELF_REGISTRATION=enabled` together with `METRICTV_REGISTRATION_MAX_ACCOUNTS` (1 to 10,000) lets people create their own account. Invalid values stop the server at start.

- No new endpoint: the same email-code sign-in creates the account, and only after the emailed code was verified. A code request alone creates nothing.
- The cap counts every account, invited ones included. Existing owners can still sign in at capacity.
- Codes for addresses without an account cost real email, so they are limited to 5 an hour per client and 60 an hour overall.
- `GET /api/registration` tells a visitor only `enabled` and `available`. When registration is closed or full, a code request does not reveal which addresses already have accounts.
- Verifications that may create an account run one at a time in the server process so the capacity check and the insert cannot interleave. That is correct for one process only. With several processes on one database, replace it with a database-enforced rule first. `npm run admin -- invite` runs as a separate short-lived process and is not covered by that lock.

## TV pairing and display sessions

Code: `server/screens/screens.mjs` (storage), `screen-routes.mjs` (HTTP), `app-version.mjs`, `display-board.mjs`, and the pages `public/tv/tv.html` and `tv.js`.

1. **A code.** The TV page calls `POST /api/tv/challenge`. The server stores a hashed random secret and a hashed 8-symbol code (40 bits, no look-alike characters) for 5 minutes, puts the secret in an HttpOnly `SameSite=Strict` cookie, and returns only the visible code. A TV that asks again drops its earlier challenge. At most 200 are open at once.
2. **Approval.** A signed-in owner submits the code and a screen name to `POST /api/screens/pair` (the checks above apply). That only marks the challenge approved for the owner's workspace. A wrong, expired or used code gets one identical answer (`400 invalid_code`), so a code never reveals an owner. After 5 wrong codes in 5 minutes that owner cannot approve anything until the window ends, even with the right code. A workspace holds at most 10 screens.
3. **The exchange.** The TV polls `GET /api/tv/pairing` and, once approved, calls `POST /api/tv/pairing/exchange`. Only the holder of the challenge cookie can do this, once. The challenge row is deleted in the same transaction that creates the display session: an opaque random credential whose SHA-256 hash is stored.
4. **Display.** `GET /api/display` returns the screen name, the workspace's period, theme and revision, the server's clock (`serverTime`, so a TV with a wrong clock still judges staleness correctly), `appVersion` (the TV reloads when it changes), `pollSeconds` (how often to ask next), an honest `storeConnection` state and, for a connected store, the display-only `board`. A screen in use renews its pairing to a full 30 days, at most once a day; one that is off for 30 days is paired again. Owners list their screens (`GET /api/screens`) and remove one (`POST /api/screens/revoke`); removal takes effect on the next request. A TV can also load the store's logo from `GET /api/display/logo`, served by MetricTV so no Shopify address reaches the TV.

Display cookies are not accepted by any owner route, and session cookies are not accepted by any TV route. On https the TV cookies are `__Host-` prefixed and `Secure`.

Rate limits are in memory, so a restart clears them. They count a visitor by the address in the header named by `METRICTV_TRUSTED_IP_HEADER` (on in `.env.example`, matching the Caddyfile that overwrites it), or by the socket address when none is trusted. An IPv6 visitor is counted by /64. The numbers:

| What | Limit |
| --- | --- |
| new pairing codes | 6 a minute per address |
| pairing requests | 240 a minute per address |
| pairing polls | 40 a minute per challenge |
| failed display requests | 60 a minute per address |
| display polls | 30 a minute per paired screen |
| approvals | 10 a minute per owner |
| wrong codes | 5 per 5 minutes per owner |

Only failed display requests count against an address. The paired screens of one office, or of every customer behind a proxy that hides addresses, share an address, and each is already held to its own 30 a minute. The numbers are in `createLimiters` in `screen-routes.mjs`.

## Connecting a Shopify store

Code, all in `server/shopify/`: `config.mjs` (settings), `connect-flow.mjs` (the OAuth start and callback), `links.mjs` (store links and pending attempts in SQLite), `workspace-runtimes.mjs` (per-store grant, cache, logo and when they refresh), `connection-service.mjs` (what a workspace may see, and disconnect), `routes.mjs` (HTTP). The official SDK does the protocol work (`sdk.mjs`, `grant-manager.mjs`, `token-store.mjs`, `http.mjs`, `admin-runner.mjs`). The fixed queries and the 130-day collector are `shop-data.mjs`; the metric code is `server/metrics.mjs`.

### Settings (all six, or none)

| Setting | Meaning |
| --- | --- |
| `METRICTV_SHOPIFY_CLIENT_ID`, `METRICTV_SHOPIFY_CLIENT_SECRET` | The Shopify app's credentials, server-only. |
| `METRICTV_SHOPIFY_ENCRYPTION_KEY` | Canonical base64 of 32 random bytes. Never reuse the app secret. |
| `METRICTV_SHOPIFY_TOKEN_DIR` | Absolute directory outside the project for the encrypted grant files (`<workspace-id>.grant.json`, mode 0600, directory 0700). |
| `METRICTV_SHOPIFY_ALLOWED_STORE` | The one exact `*.myshopify.com` host that may be connected. |
| `METRICTV_SHOPIFY_OWNER_EMAIL` | The one owner address that may connect it. |

None set: the owner page and TVs say "setup required" and nothing contacts Shopify. Some but not all, or any malformed value: the server refuses to start, naming the setting but never its value. The Shopify app must allow the redirect URL `METRICTV_ORIGIN` + `/auth/beta/shopify/callback`, and request only `read_all_orders`, `read_orders`, `read_products` and `read_inventory`. A token that comes back with any other scope is refused.

### Rules

- **Workspace-bound.** Every store read starts from a workspace derived from a verified owner or display session. A shop name in a request authorizes nothing. SQLite enforces one store per workspace and one workspace per store (`workspace_store`, `UNIQUE` on both), so a second owner can never read the first owner's figures. Other owners get `owner_not_allowed`. The allowed owner and store are configuration, not part of the data model.
- **Owner routes:** `GET /api/shopify` (state and validated snapshot), `POST /api/shopify/start` (`{store}`), `POST /api/shopify/disconnect` (`{}`). The POSTs need the session, exact Origin, JSON and the CSRF token, and the store must be the canonical host.
- **The callback** `GET /auth/beta/shopify/callback` arrives from Shopify as a cross-site navigation, so the `SameSite=Strict` session cookie is not sent, and is not loosened. It is authorized by: (1) the SDK's HMAC and signed state cookie; (2) a single-use pending attempt stored in SQLite (hashes of the state and the binding, workspace, user, session id, shop, 5-minute expiry; deleted when read, so a replay finds nothing); (3) a random binding cookie (HttpOnly, `SameSite=Lax`, `Path` = the callback only, `__Secure-` on https) whose hash must match; (4) the initiating session still existing and unexpired, owned by the allowed owner who owns that workspace. Sign-out, `revoke` or expiry while pending, even during the code exchange, cancels the finish. Starting again replaces the earlier attempt.
- **Cookie names.** The SDK's state cookies are renamed on the wire (`metrictv_beta_oauth_state` and its `.sig`, scoped to the callback path) so they cannot collide with the SDK's defaults on the same host name. The callback restores the SDK names before validation, answers with a fixed `303` to `/app?shopify=connected` or `failed` and clears all three cookies. Only a request over the rate limit (30 a minute per address) gets a bare `429` before anything is read, and it leaves the pending attempt and the cookies alone so the owner can retry.
- **Credentials.** One AES-256-GCM encrypted grant file per workspace. The authenticated data binds the app client id, the store and the workspace id, so a copied file fails to decrypt. A wrong key, a corrupt file or a missing file is `reconnect_required`, never sample data.
- **Figures.** One snapshot cache per workspace, shared by its screens and its owner page, refreshed as described in [architecture.md](architecture.md#where-the-store-figures-come-from). Disconnect, revocation and reconnect drop cached figures and ignore the results of collections that began earlier.
- **TV payload** (`projectBoardForDisplay`). Aggregate periods, charts, backlog, coverage and sync state, attention items without their links, and recent orders reduced to number, time, amount and status. No store domain or plan, admin links, customer details or owner details. The TV validates it with the shared snapshot validator and shows nothing it cannot validate.

## Email delivery

The sign-in code reaches the auth layer through an injected, server-only transport. The only production one is Resend over HTTPS (`server/accounts/mail-transport.mjs`): 8 second timeout, redirects refused, no provider detail passed on. Without it, the send endpoint answers `503 delivery_not_configured` and the page says no code was sent; if the provider fails, the page says delivery failed. Codes are never logged, returned or exposed through a development endpoint. Tests use an in-memory transport that exists only under `tests/`.

## Known limits

- A code request for an uninvited address gets the same reply body and status as for an invited one, but not the same timing: the mail provider is awaited only for an invited address, so anyone can tell them apart by how long the request takes, and while the provider is failing an invited address gets an error where an uninvited one gets success. All this reveals is that an address is invited.
- Behind a proxy without `METRICTV_TRUSTED_IP_HEADER`, all visitors share one rate-limit bucket, so anyone can use up the sign-in, pairing and callback allowances for the owner ([gotchas.md](gotchas.md#behind-a-proxy-every-visitor-looks-like-the-proxy)).
- Removing an owner is an operator command, `npm run admin -- remove <email>`: it deletes the account, workspace, screens and stored Shopify credentials (the grant file first, so a failure leaves the owner untouched and the command can be run again), but not the Shopify app in the store. `revoke` only signs an owner out and the address stays invited.
- Not implemented: an owner deleting their own account, email change, Shopify uninstall and privacy webhooks, billing. One store and one owner may connect per instance.
- Better Auth creates its own tables through its migration; `npm run admin -- migrate` applies it and the app's own tables.

## What has been verified

Automated: real HTTP (`curl`) against the real server, Better Auth and SQLite, with a synthetic Shopify transport (`tests/server/shopify-*.test.mjs`, `tests/server/screens.test.mjs`); the owner and TV pages run in Node against a fake page, and in Chrome against the real server with a synthetic Shopify. Not verified: a real Shopify approval and first read, a restart and a disconnect against a deployed origin, and real TV hardware.
