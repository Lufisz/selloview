# Gotchas

Things that look harmless and are not. Each one has bitten, or would.

## A TV keeps its page code until it reloads

The only thing that replaces the page code on a TV is that page's own reload logic, so a gap there stays on every screen until someone walks up to it. New fleet-wide behaviour (poll pace, reload, error recovery) belongs in the TV page early. TVs also have old browsers: no `Object.hasOwn`, `replaceAll`, `.at()` and friends in anything a TV loads. Both are explained in [architecture.md](architecture.md#tv-code-stays-in-the-field) and the second is enforced by a test.

## Unavailable is not zero

A failed Shopify read keeps the last good figures and shows them as stale with a warning; it never turns into `0` or an empty board. A store too large for one refresh is reported as incomplete (`coverage.ordersComplete`, and an "Order data incomplete" item on the board), not shown with totals that are quietly too low. When you add a code path that can fail, decide what the board says, and test that.

## The history window is tied to the longest period

`HISTORY_DAYS` (130, in `server/shopify/shop-data.mjs`) must reach back to the start of the previous 60-day window, 120 days ago. `buildPeriods` in `server/metrics.mjs` throws `bad_date` if it does not, rather than compare against missing orders. A longer period means raising `HISTORY_DAYS`, and more days mean more orders per refresh, which meets the 10,000-order limit sooner.

## A reporting day is the store's day

Periods start at midnight in the store's own time zone, taken from Shopify, not the server's or the viewer's. A day around a daylight-saving change is 23 or 25 hours long, so never add 24 hours to an instant to get "tomorrow": add days to a plain date (`addDays`) and convert once (`localToInstant`). `tests/server/metrics.test.mjs` has the daylight-saving weeks. The formatter for each time zone is built once and reused; pass the store's zone explicitly instead of reading a global.

## Money is whole cents

Amounts are integers in the currency's smallest unit (`amountCents`), validated when read (`bad_amount`). A snapshot never mixes currencies: a second one stops the refresh with `currency_mismatch`. Format with `money` from `public/shared/format.js` and always pass the currency.

## SameSite=Strict and Shopify's redirect

The owner's session cookie is `SameSite=Strict`, so it is not sent when Shopify redirects the browser back to `/auth/beta/shopify/callback`, which is a cross-site navigation. Do not loosen the session cookie to make that work. The callback is authorised by what the browser holds instead: the SDK's signed state cookies, a binding cookie, a single-use pending attempt in SQLite, and the initiating session still being valid. [auth-and-pairing.md](auth-and-pairing.md#connecting-a-shopify-store) has the details.

## A file in `public/` is a 404 until it is listed

`server/http/public-files.mjs` lists every file each server may serve. A new script, stylesheet or image that is not listed there works in no browser, and `tests/server/public-files.test.mjs` fails because it compares the lists with what the pages really load.

## Some names say "beta" and must keep saying it

The session cookie, the CSRF label, the Shopify callback path and its cookies are stored in browsers or registered in each operator's Shopify app. Renaming them logs everyone out or breaks the connection. The list is in [architecture.md](architecture.md#names-that-never-change), and `tests/server/stable-identifiers.test.mjs` fails if one changes.

## Reporting periods live in several places

The table in `public/shared/periods.js`, the windows in `server/metrics.mjs`, the accepted values in `server/accounts/workspaces.mjs` and a SQL `CHECK` in the workspace table. The last one needs a database migration to change. See "Where to add what" in [architecture.md](architecture.md#where-to-add-what).

## Behind a proxy, every visitor looks like the proxy

Without `SELLOVIEW_TRUSTED_IP_HEADER`, the rate limits key on the socket address, which behind a reverse proxy on the same host is one address for everyone. A handful of sign-in requests from one person then use up everybody's allowance. That fails closed, but it also means anyone on the internet can keep the owner from getting a sign-in code (3 a minute), from pairing a TV or from finishing a Shopify connection, just by sending requests at that rate. Signed-in sessions and paired screens keep working. Set the header only when the proxy always overwrites it ([`deploy/Caddyfile`](../deploy/Caddyfile) does, and `.env.example` trusts the header it overwrites). The start-up log's `Client address for rate limits` line says which of the two applies, and the journal gets one `proxy_header_not_trusted` line when a proxy header shows up that is not being read.

## Sign-in answers wait on purpose

The send-code and verify-code endpoints hold every answer until `MIN_ANSWER_MS` (100 ms, `server/accounts/auth-gateway.mjs`) has passed, so how long an answer takes does not tell an invited address from any other. Without it an invited address answered about 0.1 ms faster, which is measurable. The timer starts before the work, which is what makes the end of the wait independent of how long the work took: do not start it after the work, and do not shorten it to speed up tests (a real sign-in costs about 0.2 s). For the same reason the mail provider is not awaited. `deliverCode` in `server/accounts/auth.mjs` sends the code after the reply, and a failure goes to the log as `code_delivery_failed`, not to the visitor. A new endpoint that answers an invited address differently from an uninvited one needs the same treatment.

## `node:sqlite` is experimental

Node prints a warning about it at start. That is expected. The app uses only `DatabaseSync`. The minimum Node version is 22.16, the first where Better Auth's SQLite adapter works: it calls `statement.columns()`. On an older Node, `loadServerConfig` stops the server and the admin CLI with a message, instead of letting the first sign-in fail inside the library.
