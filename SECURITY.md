# Security and user protection

## Scope

MetricTV is a read-only Shopify wallboard. This document describes the trust model of the code in this repository. If it disagrees with the code, the code wins and the document has a bug: please report it.

An instance connects **one configured store** for **one configured owner**. It is not yet a public multi-merchant service (see [Not yet implemented](#not-yet-implemented)). Read-only access reduces risk, but sales, inventory levels and order numbers are still confidential business data.

| Role | Identified by | Can |
| --- | --- | --- |
| Owner | Email-code sign-in and an HttpOnly, SameSite=Strict session cookie | Use the board of their own workspace, change its settings, connect or disconnect the store, pair and remove TVs |
| TV display | A paired display session in its own cookie | Read the display-only projection of its own workspace's board, and nothing else |
| Anyone else | Nothing | Open the public pages and the sample dashboard, ask for a sign-in code, and start TV pairing, which grants nothing until an owner approves the code |
| Operator | Shell access to the server | Create the database, invite owners, sign them out everywhere and remove them, with local commands that are not reachable over HTTP; holds every key |

The server listens on `127.0.0.1` only and expects an HTTPS reverse proxy in front of it. The configured public origin must be HTTPS, except for loopback trials. It trusts the operating-system account it runs as: anyone who can read that account's files or environment, root included, can read the database, the encrypted Shopify credentials and the keys that decrypt them. MetricTV does not isolate itself from other local users with that access.

## Protect each boundary

| Boundary | Protection required |
| --- | --- |
| Owner browser to server | The session cookie is HttpOnly and SameSite=Strict, and `Secure` with a `__Secure-` prefix over HTTPS. The owner and workspace always come from the server-side session, never from the request. State-changing requests need the exact configured `Origin`, `Sec-Fetch-Site: same-origin` whenever the browser sends it, a JSON content type, a body of at most 2 KiB with exactly the expected keys, and a CSRF token bound to that session (kept in browser memory only). The `Host` header must be the configured host. Duplicate or comma-joined security headers are rejected, never merged. Pages carry a strict Content-Security-Policy (no inline scripts, no framing), `no-store`, `nosniff`, `no-referrer` and, over HTTPS, HSTS. |
| Sign-in | Email one-time codes only: six digits, valid five minutes, three attempts, stored hashed and rate limited. No passwords, social login or account linking. Of Better Auth's endpoints a browser can reach only send-code, verify-code and sign-out; the others are also disabled inside the library. Accounts exist because an operator invited that exact address. Self-service registration is off by default; when enabled it is capped, needs a verified code and limits how many codes go to new addresses. An address without an account gets the same reply body and status and no email; how long the answer takes is not hidden (see [Known limits](#known-limits)). A failed email delivery is reported as a failure, never as success. |
| TV pairing and display | A TV page asks for a challenge: a random secret in an HttpOnly cookie plus a short code on screen (8 characters, five minutes, at most 200 open at once). An owner approves the code, which needs their session, the exact Origin and a CSRF token, is rate limited, and locks out after repeated wrong codes. Only the holder of the challenge secret can exchange an approved challenge, exactly once, for a display session. Display credentials are random, stored only as SHA-256 hashes and compared in constant time. They last 30 days, renew while the screen is in use, and an owner can remove a screen at once. A workspace has at most 10 screens. Owner routes read only the owner's cookie and display routes only the display cookie. |
| What a TV may see | The server builds a display-only projection: figures, charts, a short order feed (number, time, amount, payment and fulfillment status) and stock-alert titles. It contains no store domain or plan, no Shopify admin links, no customer data, no owner details and no credentials. The store logo is fetched by the server and served from MetricTV (cached privately for a day), so a TV never contacts Shopify. |
| Server to Shopify | Fixed read-only GraphQL queries and exactly four scopes: `read_orders`, `read_all_orders`, `read_products` and `read_inventory`. A token that comes back with other scopes is refused. The HTTPS transport is pinned to the configured store's host and two API paths, sends POST only, refuses redirects, times out and bounds response size. The logo comes from the store's public storefront and Shopify's CDN under the same kinds of limits, and is accepted only as a PNG or JPEG whose first bytes match. |
| Shopify callback to credentials | The callback is a cross-site navigation from Shopify, so the SameSite=Strict owner cookie is not sent, and it is not loosened. The callback is authorized instead by the SDK's signed state cookie and HMAC; a single-use pending attempt stored server-side (state and binding kept as hashes, one per workspace, five-minute expiry, so a replay finds nothing); a binding cookie scoped to the callback path; exactly the query fields Shopify sends; and a check that the initiating owner session still exists and still belongs to the allowed owner, both before and after the code exchange. Every refusal gives the same fixed redirect, nothing from the query string is echoed, and the three cookies are cleared. The one exception is a request over the rate limit: it gets a bare 429 before anything is read and leaves the pending attempt and the cookies as they were, so the owner can retry. |
| Credentials to disk | Shopify grants are encrypted with AES-256-GCM. The authenticated data binds the app's client id, the store and the workspace, so a copied or swapped file fails to decrypt. Files are mode 0600 in a private 0700 directory owned by the service user and outside the project; symlinks and hard-linked files are refused and writes are atomic. The database file and its directory must also be private to the service user (no group or other access) and outside the project, and a symlinked database file or directory is refused; hard links are not checked. A wrong key or damaged file fails closed as "reconnect required", never as sample data. Disconnect and revocation use epochs, so a refresh that finishes late cannot bring deleted credentials back. |
| API response to metrics | Validate source metadata, dates, currency and money precision, and keep arithmetic within safe integers. An unusable response is an error, and an incomplete order or inventory read is reported as incomplete. Neither silently becomes a valid zero total. |
| Store text to HTML/SVG | Store-provided text and attributes are escaped wherever they are rendered. Pages validate a whole snapshot before drawing it and show nothing they cannot validate. Shopify links are accepted only as HTTPS admin links for the configured store. Chart values are forced to finite numbers before any SVG is built. |
| URL to filesystem | The app and the sample dashboard server each serve an explicit list of public files (`server/http/public-files.mjs`), so a file added to `public/` stays private until it is listed; a test ties each list to what its pages load. Request paths are rejected if they contain control characters, backslashes, empty or dot segments or dotfiles. Only known file types are served, the resolved real path must stay inside the public directory and be listed itself (a symlink can neither escape it nor publish an unlisted file), and file size is capped. |
| Application to logs and browser | Browsers get stable error codes and display fields only. Server logs record error names, not request bodies, tokens, codes or upstream error text. The Shopify SDK's own logger is silenced because it would print shop names and request details. |
| Sample server to app | The sample server has no API, no database and no credentials, and its Content-Security-Policy forbids network requests from the page. It shares presentation code with the app, never data. No real store data is copied into fixtures, tests, screenshots or documentation. |

Security checks at distinct trust boundaries are intentional. Do not remove server-side validation because a browser or shared helper performs a similar check.

## Data minimization

- Request only store metadata (name, domain, currency, time zone, plan), the order fields needed for totals and status (number, times, cancelled and test flags, payment and fulfillment status, total price) and tracked stock quantities. The fixed queries are the only place that decides what is requested.
- Do not request customer names, email addresses, delivery addresses, payment details or messages.
- Keep Shopify authorization server-side. The app secret, access and refresh tokens and the encryption key never enter browser state or logs. There is no browser token-entry form.
- Keep snapshots in server memory (one cache per workspace) and transient browser memory; they are never written to disk. The database holds accounts (email address), sessions (including client address and user agent), one-time codes (hashed), rate-limit counters, workspace settings (period and theme), store links, pending OAuth attempts (state and binding as hashes) and TV pairing and display credentials (secrets as hashes). Email and client addresses are personal data: the operator is responsible for the retention and privacy notice that apply to their instance.
- The owner and TV pages use no browser storage. The sample dashboard keeps only its own fictional display preferences in localStorage.
- Keep real-store screenshots, exports and QA reports outside source control and the public directory.
- Do not add third-party analytics, remote fonts or browser AI calls without an explicit product need and a privacy review.

## Honest failure handling

An unavailable API is not a zero-sales day. The last good snapshot is kept only with a visible stale warning, and an incomplete order or inventory read is reported as incomplete. Figures are cleared when Shopify access is denied, revoked or disconnected. Source, reporting window, currency, coverage and last-success time stay available.

Shopify access tokens expire after about an hour and MetricTV renews them with the stored refresh token. A rejected or revoked grant means the owner must reconnect. The app fails closed rather than broadening scopes, opening a public endpoint, asking for credentials in the page or substituting sample data. Disconnect clears cached figures and invalidates in-flight results, so late refresh work cannot restore deleted credentials or a replaced grant.

Disconnect deletes MetricTV's stored credentials. It does not uninstall the Shopify app; the owner does that in the Shopify admin.

## Known limits

- The Content-Security-Policy allows inline styles (`style-src 'unsafe-inline'`). Scripts are restricted to the site's own files.
- Most rate limits (TV pairing, Shopify start and callback, new-address codes) live in process memory and reset on restart. Sign-in limits are stored in the database. Run one server process per database.
- Per-address limits see the address of the reverse proxy unless the operator trusts a client-address header. `.env.example` trusts `X-Real-IP`, which the shipped Caddyfile always overwrites. Without a trusted header every visitor shares one allowance, so anyone can use up the sign-in (3 code requests a minute), TV pairing and Shopify callback allowances for the real owner; signed-in sessions and paired screens keep working. The server logs `proxy_header_not_trusted` once when a proxy header shows up unread. Trust a header only when the proxy always overwrites it: a header clients can set themselves would let them dodge the limits. IPv6 visitors are counted by /64, so a client that holds a larger block can still rotate through its /64s. A local process can also reach the loopback port directly; that does not bypass sign-in.
- A display credential is a bearer cookie valid for up to 30 days, renewed while in use. Whoever holds it sees that workspace's display data until the owner removes the screen. Approving a pairing code gives that screen access, so owners should only enter codes shown on screens they control.
- A stolen owner session cookie works until it expires (seven days, extended while in use) or the operator revokes that owner's sessions. Owners cannot yet list or end their other sessions.
- `npm run admin -- revoke` signs an owner out everywhere; the address stays invited, so the owner can request a new code and sign in again. `npm run admin -- remove` deletes the owner with the workspace, paired screens and stored Shopify credentials, and the address is uninvited. It does not uninstall the Shopify app, and it should run with the service stopped: a running server could still write the credentials back, and keeps that workspace's figures in memory until it restarts.
- A sign-in code request does not hide whether an address is invited: the mail provider is awaited only for an invited address, so its answer takes longer, and while the provider is failing an invited address gets an error where an uninvited one gets success.
- There is no audit log of sign-ins or owner actions.
- Shopify uninstall and privacy webhooks are not implemented. An uninstall is noticed on the next failed read.
- The auth secret and the grant encryption key live in the service's environment file. Anyone who can read that file together with the grant files can decrypt the credentials.
- `node:sqlite` is still experimental in Node.js. The database file is standard SQLite.

## Not yet implemented

Needed, and independently reviewed, before MetricTV is offered to other merchants as a public service:

1. More than one store and owner per instance. The data model is workspace-bound (a store belongs to at most one workspace and the reverse), but lifting the single-store restriction needs a fresh isolation review with a second account on every query, cache entry and display session.
2. Account deletion by the owner (an operator can remove one), data export and a retention policy.
3. Shopify uninstall and privacy webhooks.
4. Operational monitoring, alerting, safe updates and a restore that has been tested end to end.
5. An independent security review.

## Verification gates

Use synthetic fixtures for malformed inputs, rendering attacks, unsafe links, header ambiguity, path and symlink escapes, overflow, upstream errors and cache recovery. Also exercise real HTTP routes: in-process handler tests alone do not prove a deployed boundary. The tests start the real server and talk to it with `curl` over plain HTTP on loopback, so HTTPS-only behaviour (`Secure` cookies, cookie prefixes, HSTS) is checked with an HTTPS origin setting but a real reverse proxy still needs its own check.

Browser checks should cover normal navigation, keyboard and TV behaviour, mobile overflow, stale warnings and authorization loss. Explicit failure injection is test tooling, never a replacement for real integration evidence.

Run `npm run check`, `npm test` and `npm audit --omit=dev`. A clean audit or passing tests are limited evidence, not a guarantee of security. The reverse proxy and the host need separate maintenance from this app's npm dependencies.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through the
repository's private vulnerability reporting ("Report a vulnerability" on the Security tab). Include
what an attacker could do, the steps to reproduce and the affected version. Never include real store
data or credentials.

This is a small project maintained in spare time. Reports are read, but no response-time promise is
made yet. Only the latest version receives fixes.

## Changes

Changes to scopes, accounts, data collection, network exposure or authentication design require the maintainer's explicit approval. Do not disable protection merely to make a test or preview load.
