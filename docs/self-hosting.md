# Self-hosting Selloview

This guide runs Selloview for **one Shopify store** on a server you control: your own domain,
your own Shopify app, your own email sender. Expect about an hour the first time.

> Status: early. The self-hosted path uses the same code as the hosted service, which is still
> invite-only. Nothing here is a supported release yet.

## What you get

- A sign-in page for you (email code, no password).
- A read-only connection to one Shopify store.
- A board with sales, orders, average order value, a trend chart, things that need attention and
  the latest orders.
- TV pairing: open `/tv` on the TV, type the code it shows into your workspace, done. The TV gets a
  display-only session; it never sees your login, Shopify credentials or store admin links.

Selloview only reads data. It requests `read_orders`, `read_all_orders`, `read_products` and
`read_inventory`, and no customer names, emails, addresses or payment details.

## What you need

| Requirement | Why |
| --- | --- |
| A Linux server (1 vCPU, 512 MB RAM is enough) | Runs one Node.js process and a SQLite file. [architecture.md](architecture.md#capacity-and-growth) says what one server carries. |
| Node.js 22.16 or later | Uses the built-in `node:sqlite`. No other runtime. Older versions are refused at start. |
| A domain name pointing at the server | Shopify and secure cookies need HTTPS. |
| A reverse proxy with HTTPS, e.g. [Caddy](https://caddyserver.com) | Selloview only listens on `127.0.0.1`. |
| A [Resend](https://resend.com) account with a verified sending domain | Delivers sign-in codes. It is currently the only supported mail provider. |
| A Shopify store you can install apps on, and a Shopify Partner account | You create a private app for your own store. |

## 1. Install the code

```sh
sudo useradd --system --home /var/lib/selloview --shell /usr/sbin/nologin selloview
sudo install -d -o selloview -g selloview -m 700 /var/lib/selloview
sudo git clone <repository-url> /opt/selloview
cd /opt/selloview
sudo npm ci --omit=dev --ignore-scripts
```

`--ignore-scripts` is deliberate: no dependency needs an install script, so none gets to run one.

## 2. Create your Shopify app

Create a custom app for your own store in the
[Shopify Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard).
Apps can no longer be created directly in the store admin.

1. Create an app, for example "Selloview (self-hosted)".
2. Create a version with:
   - **App URL:** your `SELLOVIEW_ORIGIN`, e.g. `https://selloview.example.com`
   - **Redirect URL:** `https://selloview.example.com/auth/beta/shopify/callback`
   - **Scopes:** `read_orders,read_all_orders,read_products,read_inventory`
   - Not embedded in the Shopify admin.
3. Release the version and choose custom distribution to your one store.
4. `read_all_orders` lets the board compare 30 and 60-day periods. Shopify may ask you to request it
   in the app's API access settings first.
5. Copy the client ID and client secret for step 3. Do not install the app yet: Selloview starts the
   installation itself when you press **Connect Shopify**.

Selloview refuses a token that comes back with any other scopes.

## 3. Configure

```sh
sudo install -d -m 755 /etc/selloview
sudo cp /opt/selloview/.env.example /etc/selloview/selloview.env
sudo chown selloview:selloview /etc/selloview/selloview.env
sudo chmod 600 /etc/selloview/selloview.env
sudo -e /etc/selloview/selloview.env
```

Every setting is explained in [`.env.example`](../.env.example). The first group is required. The email
and Shopify groups are commented out: uncomment and fill in the whole group you use (all of the Shopify
group, both email lines). Left commented, the server still starts and reports email delivery or the store
connection as not set up. `SELLOVIEW_TRUSTED_IP_HEADER` is already on: it matches the Caddyfile in step 5,
which always overwrites that header. With another proxy, keep it only if that proxy does the same. Generate
the two secrets with:

```sh
openssl rand -base64 48   # SELLOVIEW_AUTH_SECRET
openssl rand -base64 32   # SELLOVIEW_SHOPIFY_ENCRYPTION_KEY
```

Use a new value for each; never reuse the Shopify client secret. The server refuses to start on a
missing or malformed value and names the setting, never its value.

Self-service registration (`SELLOVIEW_SELF_REGISTRATION`) is off and not needed for one owner; it is
described in [auth-and-pairing.md](auth-and-pairing.md#self-service-registration-optional).

## 4. Create the database and invite yourself

```sh
cd /opt/selloview
sudo -u selloview node --env-file=/etc/selloview/selloview.env scripts/admin.mjs init
sudo -u selloview node --env-file=/etc/selloview/selloview.env scripts/admin.mjs invite you@example.com
```

Invite the same address as `SELLOVIEW_SHOPIFY_OWNER_EMAIL`. Inviting sends nothing; you request a code on
the sign-in page. Other commands: `owners`, `revoke <email>` (signs that person out everywhere; the
address stays invited), `remove <email>` ([below](#removing-an-owner)) and `migrate` (after an upgrade).

## 5. Run it

```sh
sudo cp /opt/selloview/deploy/selloview.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now selloview
journalctl -u selloview -n 20
```

The log should report the origin, `Email delivery: configured`, `Shopify store connection:
configured` and `Client address for rate limits: the x-real-ip header`. Node prints a warning that
`node:sqlite` is experimental; that is expected.

Then put HTTPS in front of it. With Caddy, adapt [`deploy/Caddyfile`](../deploy/Caddyfile), copy it to
`/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`. That file sets `X-Real-IP`, which
`.env.example` already trusts (step 3): the two go together. Without a trusted header every visitor shares
one set of rate limits, and anyone can use up the owner's sign-in allowance. With another proxy, trust a
header only if that proxy always overwrites it. If the journal shows `proxy_header_not_trusted`, the proxy
sends a header Selloview is not reading.

Check that it is up. `/healthz` answers `{"status":"ok"}`, or `503` when the database cannot be read,
and is what an uptime monitor should poll. The server only answers the host in `SELLOVIEW_ORIGIN`, so
from the server itself send that host:

```sh
curl -s https://selloview.example.com/healthz
curl -s -H 'Host: selloview.example.com' http://127.0.0.1:4330/healthz   # before HTTPS is set up
```

## 6. First use

1. Open `https://selloview.example.com/app`, enter your email and the code you receive.
2. Press **Connect Shopify**, approve the app in Shopify and wait for the first sync (up to a few
   minutes for a store with a long order history).
3. On the TV, open `https://selloview.example.com/tv`. Type the code it shows into **Screens** in your
   workspace. The TV switches to the board by itself.

The board refreshes about every two minutes while an owner page or TV is open, and stops collecting
when nothing is watching. A TV pairing lasts 30 days and is renewed while the TV is in use. Remove a
screen in **Screens** to sign it out immediately.

## Backups

Back up three things together. Any one of them alone is not enough to restore.

| What | Where (default) |
| --- | --- |
| Database | `/var/lib/selloview/selloview.sqlite` |
| Encrypted Shopify credentials | `/var/lib/selloview/shopify-grants/` |
| Configuration, including both secrets | `/etc/selloview/selloview.env` |

Copy the database safely while the service runs (install the `sqlite3` command first, e.g.
`sudo apt install sqlite3`):

```sh
sudo -u selloview sqlite3 /var/lib/selloview/selloview.sqlite ".backup '/var/lib/selloview/backup.sqlite'"
```

Keep the configuration backup somewhere private: it contains the secrets that decrypt the Shopify
credentials. Restore once on a spare machine before you rely on a backup. If the encryption key is
lost, the board says **Reconnect** and you connect Shopify again; no data is lost, because figures
are always re-read from Shopify.

## Upgrading

```sh
cd /opt/selloview
sudo systemctl stop selloview
# back up first (see above)
sudo git pull
sudo npm ci --omit=dev --ignore-scripts
sudo -u selloview node --env-file=/etc/selloview/selloview.env scripts/admin.mjs migrate
sudo systemctl start selloview
```

The server refuses to start on a database from a different schema version until you run `migrate`.
Paired TVs notice the new version on their next poll and reload themselves. A screen already on this
version or later waits a random moment within the following minute, so they do not all fetch the page
at once; a screen still on an older page reloads at once.

## Coming from the earlier `BETA_` settings

Only for an instance that ran before the settings were renamed. Settings that started with `BETA_` now
start with `SELLOVIEW_`, and the rest of each name is unchanged: `BETA_DB_PATH` is now
`SELLOVIEW_DB_PATH`, `BETA_SHOPIFY_TOKEN_DIR` is now `SELLOVIEW_SHOPIFY_TOKEN_DIR`, and so on for all
fifteen. Rename them in your environment file before you restart. The server and `npm run admin`
refuse to start while an old name is still set, and the error lists each old name with its
replacement (never a value).

| Before | Now |
| --- | --- |
| `npm run start:beta` | `npm run start:server` |
| `npm run beta:init`, `beta:migrate`, `beta:owners` | `npm run admin -- init`, `migrate`, `owners` |
| `npm run beta:invite -- <email>`, `beta:revoke -- <email>` | `npm run admin -- invite <email>`, `revoke <email>` |
| `ExecStart=… server/beta/beta-server.mjs` | `ExecStart=… server/main.mjs` |

The owner API moved from `/api/beta/…` to `/api/…`, and nothing answers under the old prefix. A
browser tab that was open during the upgrade shows an error until it is reloaded, and a reverse
proxy rule that matched `/api/beta/` needs the new prefix. Your database, the encrypted Shopify
credentials, the Shopify redirect URL and paired TVs are not otherwise affected.

## Removing an owner

`revoke` only signs an owner out; the address stays invited and can sign in again. `remove` deletes the
owner with the workspace, its paired screens and the stored Shopify credentials, so the address is
uninvited and a later `invite` starts from nothing:

```sh
sudo systemctl stop selloview
sudo -u selloview node --env-file=/etc/selloview/selloview.env scripts/admin.mjs remove you@example.com
sudo systemctl start selloview
```

Stop the service first: a running server could still write the credentials back. Use the same
environment file as the server so the command can find the credentials; without the Shopify settings it
refuses to remove an owner who linked a store (`shopify_settings_missing`). `grant_not_removed` means the
credentials could not be deleted, usually because the command did not run as the service user (the
credentials must belong to whoever runs it, root included) or `SELLOVIEW_SHOPIFY_TOKEN_DIR` holds something
that is not Selloview's. Nothing was removed then, so run it again once that is fixed. The Shopify app stays installed in the store until you uninstall it in the
Shopify admin.

## Removing Selloview

1. In the workspace, **Disconnect** the store. This deletes Selloview's stored Shopify credentials.
2. Uninstall the app in your Shopify admin. Disconnecting alone does not uninstall it.
3. Stop and disable the service, then delete `/var/lib/selloview` and `/etc/selloview`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Service exits at start | `journalctl -u selloview`. The message names the setting that is missing or malformed. |
| Every page answers `400 bad_host` | The proxy must pass the original `Host` header, and it must equal the host in `SELLOVIEW_ORIGIN`. |
| "Email delivery is not set up" | Both `SELLOVIEW_RESEND_API_KEY` and `SELLOVIEW_MAIL_FROM` must be set. |
| An owner's sign-in code never arrives | The page cannot say why, on purpose. The journal has a `code_delivery_failed` line when sending failed: `delivery_rejected` means Resend refused the request (check the Resend key, and that `SELLOVIEW_MAIL_FROM` uses a domain verified in Resend), `delivery_unreachable` means Resend could not be reached from the server. With no such line, check the spam folder and that the invited address is exactly the one typed. |
| Shopify shows a redirect error | The redirect URL in the app version must equal `SELLOVIEW_ORIGIN` + `/auth/beta/shopify/callback` exactly. |
| "...can connect only one specific store" or "Store connection is not available for this account" | The store must equal `SELLOVIEW_SHOPIFY_ALLOWED_STORE` and you must be signed in as `SELLOVIEW_SHOPIFY_OWNER_EMAIL`. |
| Board says data is out of date | Shopify could not be reached or the app was uninstalled. The last good figures stay visible with a warning; nothing is replaced by zeros. |
| Everyone gets rate-limited together | The start-up log says `Client address for rate limits: the connection` when no header is trusted, and the journal has a `proxy_header_not_trusted` line when a proxy sends one that is not read. Set `SELLOVIEW_TRUSTED_IP_HEADER` to a header the proxy always overwrites. |

## Limits of the self-hosted version today

- One store and one owner per instance.
- Email codes need Resend. SMTP support is planned.
- The board layout is fixed; metric selection is planned.
- No Shopify uninstall or privacy webhooks yet. A single-store self-host does not need them for
  App Store review, but uninstalling in Shopify is only noticed on the next failed read.
- Tested on Linux with systemd. Other setups should work but are not documented yet.

Read [SECURITY.md](../SECURITY.md) before exposing an instance, and report vulnerabilities privately
as described there.
