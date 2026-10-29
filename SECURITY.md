# Security and user protection

## Scope

This is an owner-only private Shopify pilot with a CLI adapter and an opt-in dedicated-app OAuth adapter, not a public or multi-tenant service. Each instance is pinned to one store. Read-only access reduces risk, but sales, inventory and order numbers are still confidential business data.

The current trust model assumes the Linux operator and local processes are trusted. The live backend trusts identity headers only from its local Tailscale Serve proxy, binds to loopback, and checks the configured owner and Host. A local process running on the same machine can imitate that proxy. Do not present this deployment as isolation from other local users or as public-service authentication.

The invite-only beta (`server/beta/`, see `docs/beta-owner-auth.md`) adds a second, separate
Shopify path: workspace-scoped, read-only, restricted by configuration to one owner and one exact
store, with its own app credentials, encryption key and grant files. It never uses the private
private pilot grant, CLI session or callback. Its OAuth callback is cross-site and therefore cannot carry
the SameSite=Strict owner cookie; it is authorized by the SDK's signed state and HMAC, a single-use
pending attempt, a path-scoped binding cookie and a check that the initiating owner session still
exists. TVs receive only a server-side display projection.

## Protect each boundary

| Boundary | Protection required |
| --- | --- |
| Device to private board | Tailscale HTTPS and an explicit owner allowlist on every live route. A private URL or hidden menu is not authorization. |
| Browser to server | No arbitrary GraphQL, store host, credentials or expensive refresh operation. Most routes are GET/HEAD. Only explicit connection POST routes and the opt-in `/api/settings` POST accept bounded JSON, exact same Origin and principal-bound CSRF tokens after the owner gate. Reject malformed and duplicate security headers. |
| Server to Shopify | Fixed read-only queries and exact approved scopes. CLI uses argument arrays without shell interpolation; OAuth/API HTTPS calls are pinned to the configured Shopify host, bounded and cannot follow redirects. Preserve pagination completeness checks. |
| Shopify callback to credentials | Official SDK cookie/HMAC validation plus initiating-owner/store binding, one-use pending state, bounded lifetime and duplicate-query rejection. Request expiring offline access; do not use the browser callback as public account authentication. |
| Credentials to disk | Authenticated encryption bound to app/store, private directory/file permissions, symlink rejection and atomic writes outside the project/public root. Keep the encryption key in a separate private environment or secret manager. Lost/corrupt state fails closed. |
| API response to metrics | Validate source metadata, dates, currency, money precision and safe aggregate arithmetic. Invalid or incomplete reads must not silently become valid zero totals. |
| Store text to HTML/SVG | Escape text/attributes; validate chart numbers; allow only intended HTTPS Shopify links and known icon names. Renderers do not assume provider data is safe HTML. |
| URL to filesystem | Restrict types and entry points, resolve the public root and actual file, reject dotfiles/traversal and symlinks escaping the public directory. |
| Application to logs/browser | Expose safe error codes and display fields only, never raw CLI output, upstream errors, tokens or associated-user details. |
| Live service to demo | Share presentation, not secrets or data. The sample server has no live API and cannot contact Shopify from the browser. No live snapshot is copied into fixtures. |

Security checks at distinct trust boundaries are intentional. Do not remove server-side validation because a browser or shared helper performs a similar check.

## Data minimization

- Request only store metadata, the required order financial/fulfillment fields and tracked stock quantities.
- Do not request customer names, email addresses, delivery addresses, payment details or messages for this dashboard.
- Keep Shopify authorization server-side: either the managed CLI session or the dedicated app's encrypted credential store outside this repository/public directory. App secrets, access/refresh tokens and the encryption key never enter browser state or logs. No browser token-entry form.
- Keep snapshots in server memory and transient browser memory. Browser localStorage contains period/theme preferences only. When `LIVE_SETTINGS_PATH` is set, the server also keeps those two choices and a revision in a private 0600 file bound to the configured store; nothing else is stored.
- Keep real-store screenshots, exports and QA reports outside source control and the public directory.
- Do not add third-party analytics, remote fonts or browser AI calls without an explicit product need and a privacy review.

## Honest failure handling

An unavailable API is not a zero-sales day. Preserve the last good snapshot only with a visible stale warning. Clear displayed metrics after authorization denial. Keep source, reporting window, currency, coverage and last-success time available.

The CLI session can expire or be revoked. The dedicated-app adapter renews expiring offline credentials; rejected/revoked grants require reconnecting. The app must fail closed rather than broadening scopes, falling back from OAuth to CLI, opening a public endpoint, prompting for credentials through the page or substituting sample data. Disconnect clears cached figures and invalidates old in-flight results; late refresh work must not restore deleted credentials or a newly replaced grant.

Local disconnect deletes MetricTV's credentials; it does not uninstall the Shopify app. Detecting revoked access through API reads is not a substitute for public-release uninstall/privacy webhooks. Every callback remains behind the existing owner gate, and the TV currently has the same private access boundary rather than a separate display session.

## Verification gates

Use synthetic unit fixtures for malformed inputs, rendering attacks, unsafe links, header ambiguity, path/symlink escapes, overflow, upstream errors and cache recovery. Also exercise actual HTTP routes and the real private HTTPS proxy; in-process handler tests alone do not prove a deployed boundary.

Browser checks must cover normal navigation, keyboard/TV behaviour, mobile overflow, real snapshot matching, stale warnings and authorization loss. Explicit failure injection is test tooling, never a replacement for real integration evidence.

Run project formatting/syntax checks, Node tests and a dependency audit. A clean audit or passing tests are limited evidence, not a guarantee of security. The official Shopify CLI and host/proxy configuration require separate maintenance from this app's npm dependencies.

## Before other people can use a hosted release

Do not expose the private pilot publicly. First implement and independently verify:

1. A dedicated supported Shopify app authorization flow with secure token storage, renewal and revocation.
2. Explicit merchant/account ownership and tenant isolation on every query, cache entry and display session; verify with a second account.
3. Separate owner setup from revocable, scoped TV/display access. No permanent secret links or privileged credentials on a television.
4. Rate limits, bounded resource use, operational monitoring, safe recovery and secure updates.
5. Retention/deletion and uninstall handling, an accurate privacy notice, and a monitored private vulnerability-reporting channel.

The current owner allowlist and Tailscale header trust are not substitutes for those public-service requirements.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through the
repository's private vulnerability reporting ("Report a vulnerability" on the Security tab). Include
what an attacker could do, the steps to reproduce and the affected version. Never include real store
data or credentials.

This is a small project maintained in spare time. Reports are read, but no response-time promise is
made yet. Only the latest version receives fixes.

## Changes

Changes to scopes, accounts, data collection, network exposure or authentication design require the owner's explicit approval. Do not disable protection merely to make a test or preview load.
