# Deploying Your Own Instance

A complete walkthrough for standing up your own copy of WME Requests on Cloudflare — dashboard, API, database, and userscript all pointed at your own deployment.

---

## 1 — Prerequisites

- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (the free tier is enough)
- [Node.js](https://nodejs.org/) 18+ and npm
- The Wrangler CLI:

```bash
npm install -g wrangler
wrangler login
```

## 2 — Clone and install

```bash
git clone https://github.com/michaelrosstarr/wme-requests.git
cd wme-requests
npm install
```

## 3 — Create the D1 database

```bash
npm run db:create
```

This prints a `database_id`. Copy it into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "wme-requests",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", // <- paste here
    "remote": true
  }
]
```

Then create the R2 bucket for request screenshots, with a lifecycle rule that deletes each one
7 days after upload (Terms of Service §4). The app never deletes screenshots itself; its daily
cron only clears `requests.screenshot_key` once they're a week old.

```bash
wrangler r2 bucket create wme-requests-screenshots
wrangler r2 bucket lifecycle add wme-requests-screenshots expire-screenshots-7d "" --expire-days 7
```

## 4 — Apply the schema

All migrations need to run, in order, against **both** your local dev database and the remote (production) one:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

This applies everything under [`migrations/`](migrations/):

| Migration | Adds |
|---|---|
| `0001_initial.sql` | Core schema — `countries`, `notification_channels`, `requests` |
| `0002_better_auth.sql` | Auth tables (sessions, accounts) for the dashboard login |
| `0003_editor_rank.sql` | `requests.editor_rank` — the submitter's WME editor rank |
| `0004_channel_custom_prefix.sql` | `notification_channels.custom_prefix` — the templated prefix feature |
| `0005_channel_email.sql` | `email`/`webhook` notification platforms + `notification_channels.email_to` |
| `0006_user_country_access.sql` | `user.is_global` + `user_countries` — per-user country scoping |
| `0007_discord_forum_thread.sql` | `notification_channels.discord_forum` |
| `0008_google_sheets_channel.sql` | `google_sheets` platform + `spreadsheet_id`/`sheet_name` |
| `0009_request_screenshot.sql` | `requests.screenshot_key` |
| `0010_channel_google_credentials.sql` | (superseded by `0012`/`0013` below) |
| `0011_regions.sql` | `regions` — country-scoped states/provinces |
| `0012_credentials.sql` | `credentials` — the shared Google service-account pool + per-user BYOK email credentials |
| `0013_channel_credential_refs.sql` | `notification_channels.google_credential_id`/`email_credential_id`, replacing the old per-channel embedded credential |
| `0014_google_chat_channel.sql` | `google_chat` notification platform |
| `0015_push_subscriptions.sql` | `push_subscriptions` — self-service browser Web Push, independent of the channels above |
| `0016_ntfy_gotify_channels.sql` | `ntfy` and `gotify` notification platforms |
| `0022_passkey.sql` | `passkey` — WebAuthn credentials for **Sign in with passkey** (managed from the Account page) |
| `0023_two_factor.sql` | `user.twoFactorEnabled`, `twoFactor` and `securityKey` — two-factor authentication (email codes, authenticator app, security keys, backup codes) |
| `0024_security_events.sql` | `security_events` — per-user security log (sign-ins, failed sign-ins, sign-in method and 2FA changes) shown on the Account page |
| `0025_central_auth.sql` | `user_access` (who may use this app, `is_global`, `feed_token`), copied from `user` — sign-in moved to the WMEKit account service, and Better Auth's tables (0002, 0022–0024) are no longer used |
| `0026_superadmin.sql` | `user_access.is_superadmin` — the only level allowed to edit (name, code) or delete countries; set in the database only (see step 12) |
| `0028_discord_bot_channel.sql` | `discord_bot` notification platform + `notification_channels.discord_guild_id`/`discord_channel_id`, and `discord_guilds` — the Discord servers each country has added the bot to (see step 8) |
| `0029_discord_bot_threaded.sql` | `notification_channels.discord_threaded` — the Discord (Bot) "thread requests from the same submitter" option |

You'll re-run `db:migrate:remote` any time you pull a future update that adds a new migration file — `wrangler d1 migrations apply` only applies migrations that haven't run yet, so it's always safe to re-run.

## 5 — Configure CORS (optional)

`wrangler.jsonc`'s `vars.ALLOWED_ORIGINS` restricts which cross-origin callers can hit the public `POST /api/requests` endpoint (the one the userscript calls from waze.com). It defaults to Waze's own domains:

```jsonc
"vars": {
  "ALLOWED_ORIGINS": "https://waze.com,https://www.waze.com,https://beta.waze.com"
}
```

Leave this as-is unless you're doing something unusual — it doesn't need to include your own dashboard's domain (same-origin requests aren't subject to CORS in the first place).

## 6 — Sign-in: the WMEKit account service

Accounts live in the WMEKit account service ([wmeAuth](../wmeAuth), https://auth.wmekit.com),
shared with WME Sync: password, passkeys, Discord, two-factor, Turnstile, auth emails and the
security log are all there. Deploy it first (its DEPLOYMENT.md). This app only decides who gets
in (`user_access`) and which countries they see (`user_countries`).

This Worker reaches the account service over a **service binding** named `AUTH` (`services` in
`wrangler.jsonc`, bound to the Worker `wmeauth`): sessions are checked with
`AUTH.fetch(".../api/auth/get-session")`, and adding users / sending reset links are RPC calls.
Worker-to-worker, so there's no shared secret.

1. In `wrangler.jsonc`, `vars.APP_URL` is this app's origin and `vars.AUTH_URL` the account
   service's. For local dev, add `APP_URL=http://localhost:3000` and
   `AUTH_URL=http://localhost:3001` to `.dev.vars`.
2. This app's origin must be in wmeAuth's `APP_ORIGINS`, or it won't redirect back here after
   sign-in.
3. Both must be on the same parent domain: the session cookie is set for `.wmekit.com`.

### Moving an existing deployment over

Existing users keep their accounts: wmeAuth's `scripts/import-users.mjs` copies this database's
users (same ids, password hashes, Discord links and re-encrypted 2FA) into the account service,
and migration `0025` gives each of them exactly the access they had. Passkeys and security keys
can't move (they're bound to this hostname), so those users see a one-time "add your passkey
again" banner on their WMEKit account page. The order matters — see wmeAuth's DEPLOYMENT.md.

## 7 — (removed) Email Sending

Auth emails (invites, password resets, 2FA codes, security alerts) are sent by the account
service now, so this app has no `EMAIL` binding. Notification-channel emails still go through
the BYOK credentials from step 9.

## 8 — Configure the Discord bot (optional)

The **Discord (Bot)** notification platform posts through this app's own Discord bot: a server
admin adds the bot with one click and picks a channel from a dropdown, with no webhook to create.
It's plain REST from the Worker with the bot token — no gateway connection, no privileged
intents, nothing else to host. The webhook-based **Discord** platform keeps working without any
of this. ("Sign in with Discord" is separate and lives on the account service.)

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an
   application, then under **Bot** reset/copy its token. Leave **Public Bot** on (other server
   admins need to be able to add it). No privileged gateway intents are needed.
2. Under **OAuth2 → Redirects**, add `https://<your APP_URL>/api/discord/callback` — and, for
   local dev, `http://localhost:3000/api/discord/callback` (or use a separate test application).
3. Set the application's **Client ID** as `vars.DISCORD_APPLICATION_ID` in `wrangler.jsonc`, and
   its bot token and **Client Secret** (OAuth2 page) as secrets:

   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put DISCORD_CLIENT_SECRET
   ```

   For local dev, put all three in `.dev.vars` (`DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`,
   `DISCORD_CLIENT_SECRET`) — `.dev.vars` overrides the `wrangler.jsonc` var.
4. Run `npm run cf-typegen`.
5. (Optional, for the buttons on threaded channels' messages.) Set the application's **Public
   Key** (General Information page) as `vars.DISCORD_PUBLIC_KEY` in `wrangler.jsonc` and deploy,
   then set **Interactions Endpoint URL** on that same page to
   `https://<your APP_URL>/api/discord/interactions` — Discord checks the URL when you save, so
   deploy first. Channels with "Thread requests from the same submitter" ticked then get
   **Complete**, **Reject** and **Close thread** buttons on each request; anyone with Manage
   Threads in the channel can use them. Complete/Reject set the request's status here; Close
   thread archives the thread and makes that submitter's next request start a new one.

How servers get linked: **Add bot** in the channel form opens Discord's
"Add to server" page (an OAuth2 code-grant install). Discord redirects back to
`/api/discord/callback`, which checks the encrypted `state` (country, user, 10-minute expiry —
encrypted with `CHANNEL_CREDENTIALS_KEY`, so set that from step 9 too) and records the server
Discord reports in `discord_guilds` for that country. Channels can only be picked from servers
linked to their own country, since one bot is shared by every country. The bot asks for View
Channel, Send Messages, Embed Links, Send Messages in Threads (for forum posts), Create Public
Threads (for threaded channels) and Mention Everyone (so `@here`/role mentions in a channel's
prefix ping); the admin adding it can untick any of these. Servers added before Create Public
Threads was requested need it granted to the bot's role (or the bot re-added) for threading in
text channels — until then those notifications post as separate messages.

## 9 — Configure the Credentials Manager (optional)

**Admin → Credentials** holds two kinds of reusable, encrypted-at-rest credential that
notification channels reference instead of embedding a secret directly:

- **Google Service Accounts** — a shared pool. Add one and reuse it across as many
  `google_sheets` channels as you like; only global users can add or remove them.
- **Email Credentials** — BYOK. Each user adds their own Postmark, Mailgun, or SMTP
  credential, and picks it when configuring an `email` notification channel. A non-global user
  only sees their own; global users see everyone's.

Skip this step if you're not using the `google_sheets` or `email` notification platforms.

1. Set `CHANNEL_CREDENTIALS_KEY`, a random 256-bit key used to encrypt every credential in D1:

   ```bash
   # Local development — appended to .dev.vars (already gitignored)
   echo "CHANNEL_CREDENTIALS_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .dev.vars

   # Production — stored as an encrypted Worker secret, not a plain var
   wrangler secret put CHANNEL_CREDENTIALS_KEY
   ```

   Regenerate the Worker's env types after adding it:

   ```bash
   npm run cf-typegen
   ```

2. **For Google Sheets:** in the [Google Cloud Console](https://console.cloud.google.com/),
   create a service account and download its JSON key file, with the **Google Sheets API**
   enabled for that project. Share the target spreadsheet with the service account's
   `client_email` (Editor access) — otherwise appends will fail with a permission error. In
   **Admin → Credentials**, add a **Google Service Account** credential and paste the full
   contents of the downloaded JSON key file — it's encrypted before being stored and isn't
   shown again after saving. Then, when adding/editing a `google_sheets` channel, pick it from
   the **Google Service Account** dropdown (and paste the spreadsheet ID from the sheet's URL,
   the segment between `/d/` and `/edit`).
3. **For email:** in **Admin → Credentials**, add an **Email Credential** with whichever
   provider you use — a Postmark server token, a Mailgun API key + sending domain, or SMTP
   host/port/username/password. Then, when adding/editing an `email` channel, pick it from the
   **Email Credential** dropdown. SMTP sends over a raw TCP connection (via
   [`worker-mailer`](https://www.npmjs.com/package/worker-mailer)) on port 587 or 465 — port 25
   isn't reachable from Workers.

## 10 — Configure Web Push notifications (optional)

Unlike the channels above, Web Push isn't admin-configured — any signed-in user can click
**Notify me** on the dashboard to subscribe their own browser to a country (optionally scoped to
a region and request type). Skip this step if you don't need browser push notifications.

1. Generate a VAPID key pair with the bundled CLI from
   [`@pushforge/builder`](https://www.npmjs.com/package/@pushforge/builder) (already a project
   dependency — no separate install needed):

   ```bash
   npx @pushforge/builder vapid
   ```

   This prints a public key and a private key in JWK format.

2. Set the private key as a secret (never in `wrangler.jsonc`):

   ```bash
   # Local development — appended to .dev.vars (already gitignored) as the raw JSON string
   echo 'WEB_PUSH_VAPID_PRIVATE_JWK={"alg":"ES256",...}' >> .dev.vars

   # Production
   wrangler secret put WEB_PUSH_VAPID_PRIVATE_JWK
   ```

3. Set the public key and a contact address as plain vars in `wrangler.jsonc` (the public key is
   safe to expose — it's sent to the browser as `applicationServerKey`):

   ```jsonc
   "vars": {
     "WEB_PUSH_VAPID_PUBLIC_KEY": "your-public-key-here",
     "WEB_PUSH_CONTACT": "mailto:you@example.com"
   }
   ```

4. Regenerate the Worker's env types and re-migrate for `push_subscriptions`:

   ```bash
   npm run cf-typegen
   npm run db:migrate:local
   npm run db:migrate:remote
   ```

## 11 — (removed) Cloudflare Turnstile

The sign-in forms, and their Turnstile widget, are on the account service.

## 12 — Give the first admin access

Sign up (or sign in) on the account service and open this app once — you'll see "Ask an admin
for access", which also creates your local user row. Then grant yourself global access:

```bash
wrangler d1 execute wme-requests --remote --command "INSERT INTO user_access (user_id, is_global) SELECT id, 1 FROM \"user\" WHERE email = 'you@example.com'"
```

Changing a country's name or code, or deleting it (which also deletes its channels and
requests), needs **superadmin**. The app
never sets or clears it, and won't let anyone remove a superadmin's access from Admin → Users;
grant it (or revoke it with `is_superadmin = 0`) in the database:

```bash
wrangler d1 execute wme-requests --remote --command "UPDATE user_access SET is_superadmin = 1 WHERE user_id = (SELECT id FROM \"user\" WHERE email = 'you@example.com')"
```

Everyone after that is managed from **/admin → Users** by a global user: **Add user** finds the
WMEKit account by email (or has the account service create one and email a link to set a
password), **Edit Access** changes their countries, **Reset Password** emails them a reset
link, and **Remove** takes away their access (their WMEKit account stays).

## 13 — Try it locally

```bash
(cd ../wmeAuth && npm run dev)   # the account service, on :3001
npm run dev
```

**Careful:** the D1 binding has `"remote": true`, so `npm run dev` reads and writes the
**production** database. To try changes against a local database instead, build and run the
Worker with a copy of `dist/server/wrangler.json` that drops `"remote": true`:
`npx wrangler dev -c <that copy> --persist-to .wrangler/state`.

Open `http://localhost:3000` — `/requests`, `/admin` and `/reports` hand off to the account
service's sign-in page on :3001 (cookies ignore the port, so the session comes back). Sign in
with the account from step 12, then set
up at least one country and notification channel from the `/admin` page before moving on (see
[README § Notification Channels](README.md#notification-channels) for the channel body fields
and `custom_prefix` variables).

## 14 — Deploy

```bash
npm run deploy
```

This builds and pushes the Worker to Cloudflare. Your app is now live at `https://<project>.<your-subdomain>.workers.dev` (or a custom domain if you've attached one in the Cloudflare dashboard).

Production is `requests.wmekit.com`. Keep `requests.wazetools.com` (the pre-move host) attached as
well: `src/server-entry.ts` 301s its pages to `APP_URL` but keeps serving `/api/*` there for copies
of the userscript that haven't updated yet.

If this is your very first deploy and you haven't run step 4's `db:migrate:remote` yet, do that now — the deployed Worker needs the schema in place before it can serve any API requests.

## 15 — Point the userscript at your deployment

Open [`userscript/wme-requests.user.js`](userscript/wme-requests.user.js) — the built script Tampermonkey actually installs — and update:

```js
const DEFAULT_API_BASE = 'https://YOUR-PROJECT.YOUR-SUBDOMAIN.workers.dev';
```

Then install the script in Tampermonkey (or Greasemonkey). If you'd rather not edit the file, you can also leave the default as a placeholder and set the real URL later from inside WME: open the **WME Requests** panel → **Settings** → paste your Workers URL into **API Base URL** → **Save**. That value is stored per-browser via `GM_setValue`, so it persists across script updates without touching the file.

The script's source is TypeScript, at [`userscript/src/main.user.ts`](userscript/src/main.user.ts) — see [`userscript/README.md`](userscript/README.md) for the build. If you've set that up and plan to keep rebuilding, edit `DEFAULT_API_BASE` there instead: `npm run build` regenerates `userscript/wme-requests.user.js` and would overwrite an edit made directly in the built file.

## 16 — Updating later

```bash
git pull
npm install
npm run db:migrate:local   # picks up any new migration files
npm run db:migrate:remote  # same, against production
npm run deploy
```

Since `wrangler d1 migrations apply` only runs migrations it hasn't seen before, this sequence is safe to repeat every time you pull updates, even if nothing changed.

---

## Troubleshooting

- **Userscript panel never appears / actions silently do nothing**: open the browser console and look for lines prefixed `[WME Requests]` — the script logs diagnostic info whenever it can't find something it expects from WME's own SDK (selection getter, country lookup, user info, etc.), rather than failing silently.
- **Signed in, but every page says "Ask an admin for access"**: that WMEKit account has no
  `user_access` row. A global user adds it from **Admin → Users → Add user** (by email).
- **Signing in loops back to the account service, or the API answers 401**: the session check
  over the `AUTH` binding failed. Look for "get-session over AUTH binding failed" in the Worker
  logs, check the `wmeauth` Worker is deployed, and that this app is on a `*.wmekit.com`
  origin (the cookie isn't sent anywhere else).
- **"Internal server error" on submit**: almost always a pending D1 migration — re-run `npm run db:migrate:remote`.
- **CORS errors in the browser console** (only relevant if you're calling the public endpoint from somewhere other than the userscript): check `ALLOWED_ORIGINS` in `wrangler.jsonc` includes the exact origin making the request, then redeploy — this var only takes effect on the next `wrangler deploy`.
