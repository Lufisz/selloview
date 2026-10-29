# MetricTV: owner accounts and TV pairing

Status: implementation brief. Build step 1 (local owner login, invite-only accounts, one workspace per owner, per-workspace appearance settings) now exists as an opt-in loopback beta entry point; see `docs/beta-owner-auth.md`. Build step 3 (TV pairing, display sessions, Screens list/revoke) is also implemented in the beta, see the same document; a pilot-restricted, workspace-scoped Shopify connection now feeds the owner page and paired TVs (see the same document); managed email onboarding is not implemented. A separate, older precursor also exists: opt-in, single-store period/theme settings saved on the server behind the existing Tailscale owner allowlist (`LIVE_SETTINGS_PATH`, see `docs/live-pilot.md`). It has no board name or visible-section settings and no per-owner identity or workspace binding.

## Release outcome

A nontechnical merchant can create an account, connect their own Shopify store, see a useful default dashboard, change its appearance from their phone, and pair a TV without editing files or entering credentials on the television.

Keep the self-hosted and managed experiences on the same application core. Self-hosters configure infrastructure; merchants using managed hosting do not. The existing private single-store deployment remains private until explicitly approved changes are implemented and verified.

## First release boundaries

- One owner, one store and one dashboard per workspace. No team roles, arbitrary dashboard builder, custom domains or extra integrations.
- Invite-only managed pilot before unrestricted public registration.
- Email-code login for managed hosting. Use an established authentication implementation; do not invent cryptographic/session primitives.
- Self-hosted owner bootstrap must work without a MetricTV-operated service. Document a supported local authentication method and recovery path; email delivery must not become an undisclosed mandatory cloud dependency.
- A default board appears after first successful sync. Setup is not complete merely because Shopify authorization returned successfully.
- Server-persisted board name, light/dark theme, reporting period and a small allowlist of visible sections. Current localStorage preferences are not a cross-device settings system.
- Separate revocable display sessions. An authenticated display can read only its assigned board, not owner settings, other stores, credentials or Shopify administration routes.

## User journeys

### Owner

1. Request access during the managed pilot.
2. Receive an invitation and authenticate through the supported email-code flow.
3. Connect Shopify and approve the minimum requested read scopes.
4. Wait for the first real sync, with an explicit pending/error state.
5. Preview the default board; optionally edit name, theme, timeframe and visible sections.
6. Open Screens, enter the pairing code shown on the TV, and name the screen.
7. See the paired screen online. Later edit the board or revoke the screen from the same management area.

For self-hosting, replace invitation with one-time owner bootstrap. Disable further public registration by default. Do not ship a universal default password.

### TV

1. Open the instance's /tv page in a supported browser.
2. The server creates a bounded pending pairing request. The browser gets an opaque challenge secret in a secure cookie and displays a short human-readable code.
3. An authenticated owner submits the code and explicitly approves the screen for their dashboard.
4. Only the TV possessing that challenge secret can exchange the approved request for its display session. The short code alone cannot claim an approved screen.
5. The TV displays the board and receives saved appearance changes automatically.
6. Revocation, expiry or invalid sessions return to pairing without retaining private figures.

Codes expire after a short configured interval, are one-use, and have attempt/rate limits. Never put a long-lived display credential in a URL. Name and list active screens; provide individual revocation. Define session lifetime and renewal explicitly before implementation. Re-pair after cookies are cleared. Do not promise universal smart-TV browser compatibility before device testing.

## Minimum data ownership

Persist these responsibilities, without assuming the current project already has these tables:

- Owner identity and server-side authentication sessions.
- Workspace and its owner.
- Store connection bound to workspace and exact Shopify shop; encrypted authorization stored separately from display data.
- Board settings bound to workspace, with a settings revision for cross-device updates.
- Pending screen-pairing challenges, with hashed verifier/code material, expiration, state and attempt limits.
- Display sessions bound to a board, with hashed opaque credentials, creation/expiry, last seen and revocation.

Tenant identity always comes from an authorized server-side session, never a browser-supplied store/workspace ID alone. Protect settings, screen approval and revocation with CSRF controls. Pairing approval cannot attach a screen to another owner's board. No bearer credentials in application logs.

## Existing code: reuse versus change

Reuse:

- public/board.js, public/ui.js and shared styles for board rendering.
- server/metrics.mjs for reporting calculations, after the remaining hourly-chart correctness fix.
- Fixed read-only Shopify queries and bounded HTTP transport.
- Official SDK OAuth validation and encrypted credential persistence mechanisms.

Change deliberately:

- server/live-server.mjs currently pins SHOPIFY_STORE, an owner allowlist and one in-memory cache. It is not a multi-tenant server. Do not replace the allowlist with a login page and call that tenant isolation.
- server/shopify-connection.mjs binds OAuth to the existing owner principal and one configured store. Resolve the correct authenticated workspace before constructing a store connection; retain initiating-owner/store binding and one-use OAuth state.
- The existing single encrypted grant file cannot hold every merchant's credentials. Define per-workspace storage and key handling before hosted onboarding.
- public/live.js currently stores preferences in the browser. Move shared board settings to authenticated server persistence; keep harmless device-only preferences local where appropriate.
- The existing TV route shares the owner's access boundary. Add an independently authorized display surface rather than exposing owner routes to TV sessions.

Prefer one codebase and a simple persistent relational data model. Select the mature auth/session library and persistence approach in a small technical decision before adding dependencies. Avoid parallel bespoke auth implementations for hosted and self-hosted modes.

## Funnel

Public page -> fictional interactive demo -> two explicit paths:

1. Self-host: public repository, license, supported quickstart, deployment prerequisites, Shopify app setup and troubleshooting. No email gate on source access.
2. Managed: request an invitation, with a minimal contact/store/use-case form and truthful availability. Do not advertise immediate provisioning, prices, uptime or universal TV support that do not exist.

The current repository/domain/license are not publication-ready merely because this brief exists. Publishing, creating accounts, selecting license terms, purchasing infrastructure or exposing the private pilot requires the corresponding approval.

## Shopify and operational gates

- Retain the own-store pilot app for its existing purpose. A shared app for unrelated merchants needs the appropriate Shopify distribution/review path; merchant-owned self-hosted instances configure their own app.
- Confirm historical-order scope approval requirements for the actual production app, not the pilot organization's exception.
- Before public hosted use: uninstall/privacy handling, deletion/retention policy, monitored errors, backups and restore test, dependency review and independent two-account isolation tests.
- Run long-lived servers under an explicitly approved supervisor; chat-owned background process success is not restart/reboot durability.
- Do not onboard paying customers to the personal Linux host. For any explicitly approved experimental host trial, treat a small invitation cap as a risk limit, not a performance guarantee.
- Reuse one cached snapshot per store across screens. Bound/stagger collection and test a larger store before making capacity promises.

## Build sequence and completion tests

1. Local account/workspace persistence and owner bootstrap. Verify restart persistence, session revocation, unauthenticated denial and no second bootstrap takeover.
2. Owner settings API plus UI. Verify settings saved on one browser appear in another and that a second owner cannot read or update them.
3. Pairing API and screen UI. Verify wrong/expired/replayed codes, challenge-secret binding, rate limits, cancellation and individual revocation. A screen must fail every owner-management request.
4. Workspace-scoped Shopify connection and cache. Verify cross-store callbacks, credential selection, cache boundaries, failed/revoked access and deletion with two synthetic tenants. Keep real merchant activation separate from synthetic protocol evidence.
5. Managed email delivery and invitation onboarding using an approved provider and verified sender. Do not expose a development code viewer or fake successful delivery in production.
6. Public-safe package and funnel, then observe independent installations and request hosted pilot commitments.

Finish line: a nontechnical person connects their own store and pairs a screen without the operator editing their configuration. Changing the board from their phone updates the TV; revoking the screen removes its access; a second account cannot reach their data; restart does not lose the authorized setup.
