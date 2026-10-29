# Sample dashboard and prototype notes

Detailed notes for the fictional sample dashboard (`npm start`), its routes and browser QA, kept from
the original prototype README. For the project overview see the main [README](../README.md).

## Run the sample demo

Requires Node.js 22 or later. There is no build step. The fictional demo uses Node's built-ins; the live server also uses the pinned official Shopify API library for authorization. Prettier remains development-only. Install dependencies with `npm ci --ignore-scripts` before running the live server.

```sh
npm start
```

Open `http://127.0.0.1:4317`.

For a private network preview:

```sh
HOST=0.0.0.0 PORT=4317 npm start
```

Only expose this sample-data prototype to trusted reviewers. It has no authentication or TLS and is not ready for real store data. Binding to all interfaces makes it reachable wherever the host's network/firewall allows; this does not configure port forwarding or public hosting.

## Explore

- `#/`: landing page and sample board preview.
- `#/setup`: store-address validation, simulated permissions, board preferences.
- `#/dashboard`: sample metrics, equivalent-period comparisons, attention items, recent orders and an optional traffic-connection prompt.
- `#/connections`: actual prototype connection status and planned integrations.
- `#/settings`: business name, weekly goal, visible sections and TV appearance.
- `#/tv`: simplified screen presentation, optional browser fullscreen and Escape to exit.

On the dashboard, use **Preview a connection issue** to see stale-data handling. Attention buttons explain the future action; they do not open or change real orders. Project and support buttons explicitly explain that GitHub publication and donation accounts are not configured.

Settings are saved only in this browser's localStorage under the legacy key `stillboard-prototype-v1`, retained to preserve preferences after the MetricTV rename. Clear that entry to reset the demonstration. The sample fixtures always remain sample fixtures, including after entering a real-looking store address.

## Code map

```text
server.mjs              Sample-only static server
server/
  static-files.mjs       Shared file confinement, security headers and HTTP limits
  live-server.mjs        Owner authorization, snapshot cache and live HTTP routes
  shopify.mjs            Fixed read-only queries, CLI adapter and pagination
  shopify-admin.mjs      Dedicated-app transport for the same fixed queries
  shopify-http.mjs       Bounded, fixed-host Shopify HTTPS transport
  shopify-connection.mjs Owner-bound OAuth, connection state and token renewal
  shopify-token-store.mjs Encrypted private credential persistence
  metrics.mjs            Pure reporting windows, order/stock summaries and snapshot
public/
  index.html, live.html  Separate sample/live entry points
  app.js, live.js        State, routing and browser events
  demo-view.js          Sample models and readable setup/settings/page templates
  live-view.js          Live models and page templates, explicit currency/timezone
  live-client.js        Same-origin snapshot fetch and response validation
  board.js              Shared board, chart, metrics, attention and orders renderers
  ui.js                 Shared icons, navigation, controls, dialogs and safe links
  model.js              Pure calculations, formatting, validation and escaping
  data.js               Fictional fixtures; never imported by live/shared code
  styles.css, live.css  Shared design tokens/layouts plus live-only additions
  mark.svg              Local prototype mark
scripts/check.mjs       Recursive JavaScript syntax verification
tests/                  Synthetic unit/security tests and optional browser/HTTP QA
```

Design tokens are at the top of `styles.css`; breakpoint rules follow the base layout. `model.js` has no DOM or storage dependencies. UI events are delegated from one root, with ordinary named rendering functions rather than a framework or hidden state system. Page templates escape editable values; dialog text is escaped. No third-party scripts, fonts, analytics or images are loaded.

The data flow is deliberately direct: controller state goes to a demo or live view builder, then to shared board/UI renderers. Rendering helpers receive explicit view models and do not fetch, import fixtures or read global application state. String templates escape data at rendering boundaries; trusted HTML slots are built only by project-owned renderers, never API responses.

## Verify

Install the pinned dependencies and development tools with `npm ci --ignore-scripts`. The sample-only static server can run without npm packages; the live server requires the official Shopify API dependency.

```sh
npm run format
npm run check
npm test
```

`check` discovers JavaScript modules recursively and checks their syntax, then verifies formatting. A newly added module is not silently omitted from a hardcoded file list.

## Contributor standards and user protection

Read [AGENTS.md](../AGENTS.md) for project coding conventions and [SECURITY.md](../SECURITY.md) for trust boundaries and user-protection requirements. Use descriptive names, simple loops, readable templates and small shared helpers. Reuse behaviour and presentation without joining demo fixtures to live data or introducing a framework for its own sake.

Security belongs in the design: authorize on the server, keep credentials out of the browser, minimize collected fields, validate upstream data, escape rendered values, restrict files/links, and bound external work. Similar validation at independent client/server trust boundaries is intentional and must not be removed as duplication.

## Browser verification

Browser QA is optional development tooling, not an application dependency. It needs a Python environment with Playwright and its Chromium installed:

```sh
python3 tests/browser_qa.py
```

Environment options:
- `BASE_URL`: running server, defaults to `http://127.0.0.1:4317`.
- `CHROME`: optional explicit Chromium executable path.
- `QA_OUTPUT`: screenshot/report directory.
- `HTTP_BRIDGE=1`: workaround for a host firewall that prevents Chromium reaching localhost. Python fetches the actual static server responses and forwards their bytes, headers and status into Chromium through Playwright routing. This is not a mocked application response. Direct HTTP availability must still be checked separately.

The browser check exercises setup, validation, metrics, settings persistence, escaping, dialogs, stale data, TV exit and six routes at multiple viewport widths. It reports JavaScript errors and unexpected external requests.

## Live pilot and production boundaries

The next-release implementation brief is [Owner accounts and TV pairing](owner-and-screen-onboarding.md). It defines the proposed shared self-hosted/managed onboarding, separate display access and verification gates. Owner login, accounts and TV pairing are planned, not implemented. The one slice implemented so far is opt-in server-saved period/theme settings behind the existing private owner gate, enabled only by `LIVE_SETTINGS_PATH` (see [Optional shared dashboard settings](live-pilot.md#optional-shared-dashboard-settings)).

The private pilot defaults to a server-side Shopify CLI session and owner-restricted Tailscale Serve access. An opt-in dedicated-app OAuth adapter adds real browser authorization, encrypted credentials and expiring offline token renewal for the one configured store. See [Dedicated Shopify app connection](shopify-app-connection.md) for setup and the real-install verification gate. No app registration or merchant installation is performed merely by running the code, and this is still not a public multi-store service.

Never add a token field to the frontend or put actual business data into the unauthenticated demo. A public connected service still requires appropriate distribution/review, account and tenant isolation, report reconciliation, display sessions, uninstall/privacy webhooks, deletion and operational recovery. Google Analytics is unimplemented. [Live setup and coverage](live-pilot.md) documents the reporting restrictions.

MetricTV is the selected name. The public repository, licence, Ko-fi account and deployment domain are not yet finalised. No GitHub repository has been created or published by this prototype work. Domain purchase and trademark clearance have not been completed.
