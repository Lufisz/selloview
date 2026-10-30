# AGENTS.md

MetricTV is a small, dependency-light business wallboard: a read-only Shopify dashboard for TVs. Plain Node ESM on the server, plain browser JavaScript and CSS, no build step, two runtime dependencies (`better-auth`, `@shopify/shopify-api`). Keep source code as calm and understandable as the interface.

## Quick map

Needs Node 22.16 or later. The database is the built-in `node:sqlite`.

| To… | Run |
| --- | --- |
| try the sample board (fictional data, no accounts) | `npm start`, then open http://127.0.0.1:4317 |
| run the real app | `npm run start:server` (settings: `.env.example`) |
| create the database, invite, sign out or remove an owner | `npm run admin -- init \| migrate \| invite <email> \| revoke <email> \| remove <email> \| owners` |
| format, then check syntax and formatting | `npm run format`, `npm run check` |
| run every test | `npm test` |
| run one test file | `node --test tests/server/metrics.test.mjs` |
| run the tests whose title matches | `node --test --test-name-pattern="reload" tests/browser/tv-flow.test.mjs` |

| Folder | What lives there |
| --- | --- |
| `server/` | `main.mjs` starts the app, `app.mjs` routes requests, `config.mjs` reads the settings, `metrics.mjs` is the pure snapshot maths, `demo.mjs` serves the sample |
| `server/http/` | host, origin and body guards, static files, which files each server may serve, the rate limiter, who a visitor is for it (`client-address.mjs`) |
| `server/accounts/` | owner sign-in (Better Auth), sessions, workspaces, the SQLite file |
| `server/screens/` | TV pairing and display sessions, what a TV may see |
| `server/shopify/` | the store connection: OAuth, encrypted grants, queries, the per-store cache |
| `public/` | one folder per page (`landing/`, `demo/`, `owner/`, `tv/`) and `shared/` for what they have in common |
| `tests/` | `server/`, `browser/`, `helpers/`, `qa/`; synthetic data only |
| `docs/` | start at [docs/README.md](docs/README.md); [docs/architecture.md](docs/architecture.md) says where a change belongs |

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
- The server listens on loopback only, with an HTTPS reverse proxy in front. A client address from a proxy header is trusted only when the operator names that header in `METRICTV_TRUSTED_IP_HEADER`. Do not widen the listener or trust more headers without explicit approval.
- Escape all external text and attributes, validate numbers before building SVG, and restrict external links to intended HTTPS destinations. Shared templates must not trust a value merely because another caller validated it.
- Restrict static files to the public root, allowed file types and intended entry points. Block dotfiles and symlink escapes.
- Bound requests, pagination and output. Use fixed query allowlists and argument arrays, never a shell with interpolated input.
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

## Before calling a change done

1. `npm run format` and `npm run check` pass.
2. `npm test` passes. A bug fix comes with a test that failed before the fix.
3. A new file under `public/` is listed in `server/http/public-files.mjs` (an unlisted file is a 404). A new setting is in `.env.example` and `docs/self-hosting.md`.
4. Nothing stored or registered outside this repository was renamed (the list is in [docs/architecture.md](docs/architecture.md), "Names that never change").
5. Code a TV loads still avoids the newer built-ins listed in [docs/architecture.md](docs/architecture.md), "TV code stays in the field". The tests check this.
6. A limit you add or rely on carries a comment `// ceiling: <limit>, upgrade: <trigger>`. `grep -rn "ceiling:" server` lists them all.
7. The docs that describe what you changed are updated in the same change.

## Code wins over docs

If a document and the code disagree, the code is right. Fix the document in the same change.
