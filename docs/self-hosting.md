# Self-hosting MetricTV

This guide runs MetricTV for **one Shopify store** on a server you control: your own domain,
your own Shopify app, your own email sender. Expect about an hour the first time.

> Status: early. The self-hosted path uses the same code as the hosted beta, which is still
> invite-only. Nothing here is a supported release yet, and configuration names still carry a
> `BETA_` prefix. They will be renamed before 1.0 with a migration note.

## What you get

- A sign-in page for you (email code, no password).
- A read-only connection to one Shopify store.
- A board with sales, orders, average order value, a trend chart, things that need attention and
  the latest orders.
- TV pairing: open `/tv` on the TV, type the code it shows into your workspace, done. The TV gets a
  display-only session; it never sees your login, Shopify credentials or store admin links.

MetricTV only reads data. It requests `read_orders`, `read_all_orders`, `read_products` and
`read_inventory`, and no customer names, emails, addresses or payment details.

## What you need

| Requirement | Why |
| --- | --- |
| A Linux server (1 vCPU, 512 MB RAM is enough) | Runs one Node.js process and a SQLite file. |
| Node.js 22.13 or later | Uses the built-in `node:sqlite`. No other runtime. |
| A domain name pointing at the server | Shopify and secure cookies need HTTPS. |
| A reverse proxy with HTTPS, e.g. [Caddy](https://caddyserver.com) | MetricTV only listens on `127.0.0.1`. |
| A [Resend](https://resend.com) account with a verified sending domain | Delivers sign-in codes. It is currently the only supported mail provider. |
| A Shopify store you can install apps on, and a Shopify Partner account | You create a private app for your own store. |

## 1. Install the code

```sh
sudo useradd --system --home /var/lib/metrictv --shell /usr/sbin/nologin metrictv
sudo install -d -o metrictv -g metrictv -m 700 /var/lib/metrictv
sudo git clone <repository-url> /opt/metrictv
cd /opt/metrictv
sudo npm ci --omit=dev --ignore-scripts
```

`--ignore-scripts` is deliberate: no dependency needs an install script, so none gets to run one.

## 2. Create your Shopify app

Create a custom app for your own store in the
[Shopify Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard).
Apps can no longer be created directly in the store admin.

1. Create an app, for example "MetricTV (self-hosted)".
2. Create a version with:
   - **App URL:** your `BETA_ORIGIN`, e.g. `https://metrictv.example.com`
   - **Redirect URL:** `https://metrictv.example.com/auth/beta/shopify/callback`
   - **Scopes:** `read_orders,read_all_orders,read_products,read_inventory`
   - Not embedded in the Shopify admin.
3. Release the version and choose custom distribution to your one store.
4. `read_all_orders` lets the board compare 30 and 60-day periods. Shopify may ask you to request it
   in the app's API access settings first.
5. Copy the client ID and client secret for step 3. Do not install the app yet: MetricTV starts the
   installation itself when you press **Connect Shopify**.

MetricTV refuses a token that comes back with any other scopes.

## 3. Configure

```sh
sudo install -d -m 755 /etc/metrictv
sudo cp /opt/metrictv/.env.example /etc/metrictv/metrictv.env
sudo chown metrictv:metrictv /etc/metrictv/metrictv.env
sudo chmod 600 /etc/metrictv/metrictv.env
sudo -e /etc/metrictv/metrictv.env
```

Every setting is explained in [`.env.example`](../.env.example). Generate the two secrets with:

```sh
openssl rand -base64 48   # BETA_AUTH_SECRET
openssl rand -base64 32   # BETA_SHOPIFY_ENCRYPTION_KEY
```

Use a new value for each; never reuse the Shopify client secret. The server refuses to start on a
missing or malformed value and names the setting, never its value.

## 4. Create the database and invite yourself

```sh
cd /opt/metrictv
sudo -u metrictv node --env-file=/etc/metrictv/metrictv.env scripts/admin.mjs init
sudo -u metrictv node --env-file=/etc/metrictv/metrictv.env scripts/admin.mjs invite you@example.com
```

Invite the same address as `BETA_SHOPIFY_OWNER_EMAIL`. Inviting sends nothing; you request a code on
the sign-in page. Other commands: `owners`, `revoke <email>` (signs that person out everywhere) and
`migrate` (after an upgrade).

## 5. Run it

```sh
sudo cp /opt/metrictv/deploy/metrictv.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now metrictv
journalctl -u metrictv -n 20
```

The log should report the origin, `Email delivery: configured` and `Shopify store connection:
configured`. Node prints a warning that `node:sqlite` is experimental; that is expected.

Then put HTTPS in front of it. With Caddy, adapt [`deploy/Caddyfile`](../deploy/Caddyfile), copy it to
`/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`. If you use Caddy's `X-Real-IP` line,
also set `BETA_TRUSTED_IP_HEADER=x-real-ip` and restart MetricTV, so rate limits see real visitor
addresses instead of the proxy.

## 6. First use

1. Open `https://metrictv.example.com/app`, enter your email and the code you receive.
2. Press **Connect Shopify**, approve the app in Shopify and wait for the first sync (up to a few
   minutes for a store with a long order history).
3. On the TV, open `https://metrictv.example.com/tv`. Type the code it shows into **Screens** in your
   workspace. The TV switches to the board by itself.

The board refreshes about every two minutes while an owner page or TV is open, and stops collecting
when nothing is watching. A TV pairing lasts 30 days and is renewed while the TV is in use. Remove a
screen in **Screens** to sign it out immediately.

## Backups

Back up three things together. Any one of them alone is not enough to restore.

| What | Where (default) |
| --- | --- |
| Database | `/var/lib/metrictv/metrictv.sqlite` |
| Encrypted Shopify credentials | `/var/lib/metrictv/shopify-grants/` |
| Configuration, including both secrets | `/etc/metrictv/metrictv.env` |

Copy the database safely while the service runs (install the `sqlite3` command first, e.g.
`sudo apt install sqlite3`):

```sh
sudo -u metrictv sqlite3 /var/lib/metrictv/metrictv.sqlite ".backup '/var/lib/metrictv/backup.sqlite'"
```

Keep the configuration backup somewhere private: it contains the secrets that decrypt the Shopify
credentials. Restore once on a spare machine before you rely on a backup. If the encryption key is
lost, the board says **Reconnect** and you connect Shopify again; no data is lost, because figures
are always re-read from Shopify.

## Upgrading

```sh
cd /opt/metrictv
sudo systemctl stop metrictv
# back up first (see above)
sudo git pull
sudo npm ci --omit=dev --ignore-scripts
sudo -u metrictv node --env-file=/etc/metrictv/metrictv.env scripts/admin.mjs migrate
sudo systemctl start metrictv
```

The server refuses to start on a database from a different schema version until you run `migrate`.
Paired TVs reload themselves to the new version within a minute.

## Removing MetricTV

1. In the workspace, **Disconnect** the store. This deletes MetricTV's stored Shopify credentials.
2. Uninstall the app in your Shopify admin. Disconnecting alone does not uninstall it.
3. Stop and disable the service, then delete `/var/lib/metrictv` and `/etc/metrictv`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Service exits at start | `journalctl -u metrictv`. The message names the setting that is missing or malformed. |
| "Email delivery is not set up" | Both `BETA_RESEND_API_KEY` and `BETA_MAIL_FROM` must be set. |
| "The code email could not be sent" | The Resend key, and that `BETA_MAIL_FROM` uses a domain verified in Resend. |
| Shopify shows a redirect error | The redirect URL in the app version must equal `BETA_ORIGIN` + `/auth/beta/shopify/callback` exactly. |
| "...can connect only one specific store" or "Store connection is not available for this account" | The store must equal `BETA_SHOPIFY_ALLOWED_STORE` and you must be signed in as `BETA_SHOPIFY_OWNER_EMAIL`. |
| Board says data is out of date | Shopify could not be reached or the app was uninstalled. The last good figures stay visible with a warning; nothing is replaced by zeros. |
| Everyone gets rate-limited together | Configure `BETA_TRUSTED_IP_HEADER` with a proxy that overwrites that header. |

## Limits of the self-hosted version today

- One store and one owner per instance.
- Email codes need Resend. SMTP support is planned.
- The board layout is fixed; metric selection is planned.
- No Shopify uninstall or privacy webhooks yet. A single-store self-host does not need them for
  App Store review, but uninstalling in Shopify is only noticed on the next failed read.
- Tested on Linux with systemd. Other setups should work but are not documented yet.

Read [SECURITY.md](../SECURITY.md) before exposing an instance, and report vulnerabilities privately
as described there.
