# Project conventions

MetricTV is a small, dependency-light business wallboard. Keep source code as calm and understandable as the interface.

## Readability and reuse

- Use descriptive names: `order`, `snapshotCache`, `dateFormatter`, `previousPeriod`, not `o`, `c`, `fmt` or `p` for business logic.
- Write ordinary loops and explicit branches. One meaningful operation per statement; do not compress loops, conditions or several assignments into a line.
- Format HTML templates and returned objects across readable lines. Do not hide entire pages in single strings on one line.
- Share repeated presentation and behaviour through small functions or modules. Demo fixtures and live store data stay separate, but their board, chart and UI primitives should be reused.
- Give renderers explicit view models and currency/timezone inputs. Do not let a formatting helper secretly depend on mutable global application state.
- Extract helpers for meaningful responsibilities and real repetition. Do not create a framework, deeply configurable renderer, inheritance hierarchy or dozens of tiny files.
- Use existing CSS variables and reusable classes. This project uses plain CSS; do not introduce a preprocessor just to obtain mixins.
- Use named constants for business rules. Explain non-obvious decisions such as store-local reporting windows and historical coverage, not obvious syntax.
- Run `npm run format` and `npm run check`. Formatting is necessary but does not replace clear naming or good boundaries.

## User protection from the start

- Read `SECURITY.md` before changing data access, rendering, files, authentication or deployment.
- Keep Shopify access read-only and server-side. No browser token fields, secrets in Git, client-controlled GraphQL or arbitrary store URLs.
- Authorize every live route on the server. Client state and UI visibility are never authorization.
- The local Tailscale Serve proxy is a specific trust boundary, not a generic authentication mechanism for public hosting. Do not widen listeners or change proxy/account settings without explicit approval.
- Escape all external text and attributes, validate numbers before building SVG, and restrict external links to intended HTTPS destinations. Shared templates must not trust a value merely because another caller validated it.
- Restrict static files to the public root, allowed file types and intended entry points. Block dotfiles and symlink escapes.
- Bound requests, CLI execution, pagination and output. Use fixed query allowlists and argument arrays, never a shell with interpolated input.
- Return only display data. Never request or expose customer identities, delivery addresses, payment details or credential metadata unnecessarily.
- Keep failures explicit: unavailable is not zero, stale is not live, and incomplete is not complete. Do not expose raw upstream exceptions to browsers.
- Keep independent server-side validation even when browser code validates the same input. This is intentional defence at separate trust boundaries, not duplication to remove.
- Never copy real store data into fixtures, source files or public screenshots.

## Verification and scope

- Preserve the existing UI, metric definitions and demo/live separation during refactors.
- Test pure helpers with explicitly synthetic data and add regression tests for actual bugs or security boundaries.
- Run all Node tests and the relevant demo/live browser checks. Exercise real HTTP routes as well as in-process handler tests.
- Do not disguise blocked network requests with fabricated results. Clearly labelled failure injection is allowed in tests, not as replacement live data.
- Keep optional browser QA artifacts outside the repository and public root.
- Do not commit, publish, modify store records or change infrastructure unless the owner explicitly authorizes that scope.
