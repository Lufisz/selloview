# MetricTV

Your Shopify store on the big screen.

MetricTV turns a spare TV into a calm, readable board for your shop: sales and orders, a trend
against the previous period, what needs attention and the latest orders. It fits one screen at any
resolution, updates itself and never needs a keyboard on the TV.

- **Read-only.** It reads orders, products and inventory. It cannot change your store and never
  requests customer names, emails, addresses or payment details.
- **Safe on a shared screen.** The TV is paired with a short code and gets a display-only session.
  Your login, Shopify credentials and admin links never reach it.
- **Honest numbers.** If Shopify can't be reached, the board says so and keeps the last good
  figures with a warning. Missing data never becomes a zero.
- **Small.** Plain Node.js, SQLite and HTML/CSS/JavaScript. No build step, no frontend framework,
  two runtime dependencies.

> **Status: early beta.** The hosted version is invite-only, and self-hosting is documented but not
> yet a supported release. Configuration names will change before 1.0.

## Try it

The sample dashboard runs on fictional data and needs only Node.js 22.13 or later:

```sh
npm start
```

Open http://127.0.0.1:4317. No store is connected and nothing leaves your machine. More about the
sample dashboard: [docs/sample-dashboard.md](docs/sample-dashboard.md).

## Self-host it

Run MetricTV for your own store with your own Shopify app, domain and email sender. Follow the
**[self-hosting guide](docs/self-hosting.md)**. In short:

```sh
npm ci --omit=dev --ignore-scripts
cp .env.example /etc/metrictv/metrictv.env   # fill in, then chmod 600
node --env-file=/etc/metrictv/metrictv.env scripts/beta-admin.mjs init
node --env-file=/etc/metrictv/metrictv.env scripts/beta-admin.mjs invite you@example.com
node --env-file=/etc/metrictv/metrictv.env server/beta/beta-server.mjs
```

Then put an HTTPS reverse proxy in front of it. The guide covers the Shopify app, systemd, Caddy,
backups and upgrades.

## How it works

```text
TV (/tv)  ───── display session ──┐
                                  ├──►  MetricTV server  ── read-only OAuth ──►  Shopify Admin API
Phone or laptop (/app) ─ owner ───┘           │
                                              └── SQLite: owners, sessions, screens, settings
```

1. The owner signs in with an emailed code and connects Shopify through Shopify's own approval page.
2. The server stores the Shopify credentials encrypted and runs a fixed set of read-only queries. It
   collects only while an owner page or a TV is open, at most every two minutes.
3. A TV shows a pairing code. The owner types it into the workspace. The TV then receives a
   display-only view: aggregate figures, chart points and attention titles.

## Project layout

```text
server.mjs                 Sample dashboard server (fictional data only)
server/beta/               The app: sign-in, workspaces, TV pairing, Shopify connection, routes
server/                    Shared Shopify transport, OAuth grants, encrypted token store, metrics
public/                    Pages, styles and browser code, served as plain files
  board.js, ui.js          Board and UI renderers shared by every page
  beta*.js, tv*.js         Owner workspace and TV
  demo-view.js, data.js    Sample dashboard and its fictional data
  landing.html             Hosted landing page
scripts/beta-admin.mjs     Operator commands: init, migrate, invite, revoke, owners
deploy/                    Example systemd unit and Caddy configuration
docs/                      Self-hosting guide and design notes
tests/                     Node tests, synthetic data only
```

`server/live-server.mjs` is an older single-store prototype kept while its remaining features move
into `server/beta/`. New work belongs in `server/beta/`.

## Develop

```sh
npm ci --ignore-scripts
npm run check    # syntax and formatting
npm test         # all Node tests
npm run format   # apply formatting
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md)
before touching data access, sign-in or rendering.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
Never include store data or credentials in an issue.

## Licence

[GNU Affero General Public License v3.0](LICENSE). You can use, self-host and modify MetricTV
freely. If you run a modified version as a service for other people, you must offer them its source
code under the same licence.

The bundled Archivo font is under the SIL Open Font License; see `public/fonts/OFL.txt`.
