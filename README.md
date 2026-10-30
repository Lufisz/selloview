# MetricTV

A read-only Shopify dashboard for TVs. See sales, orders, trends and stock alerts without opening Shopify admin.

**Early beta:** hosted access is invite-only. Self-hosting currently supports one configured store and one connecting owner per instance.

![MetricTV sample dashboard with sales, trends, stock alerts and recent orders](docs/screenshots/dashboard.png)

*Fictional Sunday Supply store. No real merchant data appears in these screenshots.*

## What works

- Email-code sign-in and read-only Shopify authorization.
- Sales and order metrics with previous-period comparisons.
- TV pairing using a short code. The TV gets a separate, revocable display session, not the owner's login or Shopify credentials.
- Saved period and theme settings, with automatic refresh while the board is open.
- A visible warning when the latest sync fails.

## Run the demo

Requires **Node.js 22.13+**. The demo uses fictional data and needs no Shopify account or dependencies.

```sh
git clone https://github.com/Lufisz/metrictv.git
cd metrictv
npm start
```

Open **http://127.0.0.1:4317**. The repository is private, so cloning requires access.

The demo's connection setup is simulated. Its preferences are stored in your browser, not connected to a real store.

<details>
<summary>Screenshot: demo settings</summary>

![Demo settings for the fictional Sunday Supply store](docs/screenshots/demo-settings.png)

These are prototype controls. Connected workspaces currently save period and theme; the demo's section toggles and weekly goal are not available there yet.

</details>

## Connect your own store

Follow the **[self-hosting guide](docs/self-hosting.md)**. You need:

- A server running Node.js, with an HTTPS reverse proxy.
- A Shopify app configured for your store.
- A Resend account and verified sending domain for login codes.

The guide covers configuration, owner invitations, Shopify authorization, TV pairing and backups. Example configuration is in [`.env.example`](.env.example); deployment examples are in [`deploy/`](deploy/).

**Not ready yet:** public merchant onboarding, account deletion, uninstall/privacy webhooks, billing and custom board layouts. Google Analytics is not implemented. A clean-server installation and restore still need end-to-end verification before a supported release.

## Development

Plain JavaScript, HTML and CSS, with Node.js and SQLite. No frontend framework or build step.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

| Path | Purpose |
| --- | --- |
| `server/beta/` | Owner accounts, Shopify connections and TV sessions |
| `server/` | Shared Shopify queries, encrypted credentials and metrics |
| `public/` | Pages, styles and shared board renderers |
| `scripts/beta-admin.mjs` | Database setup, invitations and migrations |
| `tests/` | Tests using synthetic data |

See [contributing](CONTRIBUTING.md) for code conventions and [security](SECURITY.md) for data boundaries and reporting. Never include real store data or credentials in issues or screenshots.

## Licence

[AGPL-3.0-only](LICENSE). The bundled Archivo font uses the [SIL Open Font License](public/fonts/OFL.txt).
