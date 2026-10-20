# WME Requests

A full-stack tool for Waze Map Editor (WME) that lets editors send **downlock** and **imagery** requests for road segments. Requests are stored in **Cloudflare D1** (SQLite), delivered to **Slack**, **Discord**, and **Telegram**, and visualised in a built-in dashboard hosted on **Cloudflare Workers**.

---

## Architecture

| Layer | Technology |
|---|---|
| Userscript | Tampermonkey / Greasemonkey (runs inside WME) |
| App | TanStack Start (React, SSR, Vite) deployed as a Cloudflare Worker |
| API | TanStack Start server routes (`src/routes/api/**`), folded into the same Worker |
| Database | Cloudflare D1 (SQLite-compatible managed DB) |
| Dashboard | Mantine UI components rendered by TanStack Start (`src/routes/`, `src/components/`) |
| Auth | The shared WMEKit account service ([wmeAuth](../wmeAuth), auth.wmekit.com), reached over a Cloudflare service binding. This app keeps only who has access (`user_access`, `user_countries`) |
| Notifications | Outbound `fetch()` to Slack, Discord and Telegram webhooks/bots |

---

## Features

- **Two request types** — 🔒 Downlock and 🖼️ Imagery
- **Lock level inferred** automatically from the selected WME segment; editor can adjust before submitting
- **Multi-channel notifications** — each country can have:
  - A *global* channel (fires on every request)
  - Per-event-type channels (fires only for downlocks *or* only for imagery)
  - Unlimited channels per event type
- **Platforms**: Slack (Incoming Webhook), Discord (Webhook), Discord (Bot — add the app's bot to a server in one click and pick a channel, no webhook; see [DEPLOYMENT.md § 8](DEPLOYMENT.md#8--configure-the-discord-bot-optional)), Telegram (Bot API), Email (Postmark), generic Webhook (plain JSON POST for custom integrations)
- **Reports** — `/reports` breaks down requests by submitter, with a downlock/imagery split and each user's majority request type
- **Dashboard** — filterable table of all requests per country, inline status updates, and an admin panel to manage countries and notification channels

---

## Quick Start

> For a fuller walkthrough (including CORS config, migration reference, updating later, and troubleshooting), see [`DEPLOYMENT.md`](DEPLOYMENT.md).

### 1 — Prerequisites

```bash
npm install -g wrangler   # Cloudflare CLI
# Then authenticate:
wrangler login
```

### 2 — Clone & install

```bash
git clone https://github.com/michaelrosstarr/wme-requests.git
cd wme-requests
npm install
```

### 3 — Create the D1 database

```bash
npm run db:create
# The command prints a database_id — copy it into wrangler.jsonc:
#   "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Create the screenshots bucket; its lifecycle rule deletes each screenshot 7 days after upload:

```bash
wrangler r2 bucket create wme-requests-screenshots
wrangler r2 bucket lifecycle add wme-requests-screenshots expire-screenshots-7d "" --expire-days 7
```

### 4 — Apply the schema

```bash
# Local development
npm run db:migrate:local

# Production (run once after deploy)
npm run db:migrate:remote
```

This applies every file under [`migrations/`](migrations/) that hasn't run yet — currently the app schema, auth schema, `editor_rank`, and `custom_prefix` migrations. See [`DEPLOYMENT.md`](DEPLOYMENT.md#4--apply-the-schema) for the full list.

### 5 — Sign-in

Sign-in is the WMEKit account service ([wmeAuth](../wmeAuth)), shared with WME Sync. Deploy it
first. `wrangler.jsonc` binds it as `AUTH` (`services`) and sets `APP_URL` / `AUTH_URL`; this
app's origin must be in wmeAuth's `APP_ORIGINS`. There are no auth secrets here.

### 6 — Give the first admin access

Sign up (or sign in) on the account service, open this app once (you'll see "Ask an admin for
access", which also creates your local user row), then grant yourself global access:

```bash
wrangler d1 execute wme-requests --remote --command "INSERT INTO user_access (user_id, is_global) SELECT id, 1 FROM \"user\" WHERE email = 'you@example.com'"
```

Changing a country's name or code, or deleting it (and with it its channels and requests), needs
**superadmin**, which the app never sets or clears. Grant it in the database (`is_superadmin = 0` revokes it):

```bash
wrangler d1 execute wme-requests --remote --command "UPDATE user_access SET is_superadmin = 1 WHERE user_id = (SELECT id FROM \"user\" WHERE email = 'you@example.com')"
```

Global users add everyone else from **Admin → Users → Add user**.

### 7 — Local development

```bash
(cd ../wmeAuth && npm run dev)   # the account service, on :3001
npm run dev                      # http://localhost:3000; /admin etc. hand off to :3001 to sign in
```

Careful: the D1 binding in `wrangler.jsonc` has `"remote": true`, so `npm run dev` uses the
**production** database.

### 8 — Deploy to Cloudflare Workers

```bash
npm run deploy
# After the first deploy, also push the DB migration to production:
npm run db:migrate:remote
```

Your app will be live at `https://<project>.<your-subdomain>.workers.dev`.

---

## Authentication

The dashboard and nearly every API endpoint require a session: the WMEKit account cookie
(scoped to `.wmekit.com`), which `apiRoute` checks with wmeAuth over the `AUTH` service
binding. The exceptions are `POST /api/requests` and `POST /api/screenshots` — the endpoints the
Tampermonkey userscript calls cross-origin from `waze.com`, which has no way to complete an
interactive login. Instead a browser-set `Origin` must be a Waze page (`waze.com`,
`www.waze.com`, `beta.waze.com`), which stops other websites from submitting through a visitor's
browser. Requests from a userscript manager (which sends the extension's `Origin`, or none) are
let through. Set `REQUIRE_PAGE_ORIGIN_HEADER` to `"true"` in `wrangler.jsonc` to also require them
to name a Waze page in an `X-WME-Requests-Origin` header, which the userscript sends from v2.9.0.
Neither stops a non-browser client, which can send any headers it likes.

Anyone can create a WMEKit account, so an account alone gets you nothing here: you also need
a `user_access` row, which global users grant from **Admin → Users → Add user** (that finds the
account by email, or has the account service create one and email a "set your password" link).
Without one, pages show "Ask an admin for access" and the API answers `403` with
`code: "no_access"`.

---

## API Reference

All endpoints are under `/api/`. The dashboard and userscript both talk to this API. Every endpoint below requires a logged-in session **except `POST /api/requests`**, which is public (see [Authentication](#authentication)).

### Countries

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/countries` | List all countries |
| POST | `/api/countries` | Create a country `{ name, code }` |
| GET | `/api/countries/:id` | Get a country |
| PUT | `/api/countries/:id` | Update `{ name?, code? }` (superadmin only) |
| DELETE | `/api/countries/:id` | Delete (cascades to channels & requests; superadmin only) |

### Notification Channels

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/countries/:id/channels` | List channels for a country |
| POST | `/api/countries/:id/channels` | Add a channel (see body below) |
| PUT | `/api/channels/:id` | Update a channel |
| DELETE | `/api/channels/:id` | Delete a channel |
| POST | `/api/channels/:id/test` | Send a test notification to verify the channel is configured correctly |

**Channel body**

```json
{
  "label": "#wme-au-downlocks",
  "platform": "slack",
  "event_type": "downlock",
  "webhook_url": "https://hooks.slack.com/services/…",
  "custom_prefix": "L{lock_level}{country_code}"
}
```

`platform` is one of `slack` | `discord` | `discord_bot` | `telegram` | `email` | `webhook`. `event_type` is one of `global` | `downlock` | `imagery`.

- **Slack / Discord / generic Webhook** — use `webhook_url`.
- **Discord (Bot)** (`discord_bot`) — use `discord_guild_id` + `discord_channel_id` instead of `webhook_url`. The server must first be linked to the country by adding the bot from the channel form (`GET /api/discord/install?country_id=`); list linked servers with `GET /api/countries/:id/discord-guilds` and their channels with `GET /api/countries/:id/discord-guilds/:guildId/channels`; unlink one with `DELETE /api/countries/:id/discord-guilds/:guildId` (refused while a channel still uses it). Forum channels are detected automatically (each notification becomes a new post). Set `discord_threaded: true` to thread consecutive requests from the same submitter on the same UTC day into one thread (in a forum, replies to the first post) instead of separate messages; those messages also get Complete / Reject / Close thread buttons, handled at `POST /api/discord/interactions` (needs `DISCORD_PUBLIC_KEY`, see DEPLOYMENT.md § 8).
- **Telegram** — use `bot_token` + `chat_id` instead of `webhook_url`.
- **Email** — use `email_to` (recipient address) instead of `webhook_url`; sent through an email credential (Postmark, Mailgun or SMTP) added in the Credentials Manager.

The generic `webhook` platform POSTs a plain JSON body (not platform-formatted) to `webhook_url`, for wiring up your own integrations:

```json
{
  "title": "Downlock Request — South Africa",
  "prefix": "L5ZA",
  "permalink": "https://www.waze.com/editor?...",
  "lock_level": 5,
  "notes": "Speed limit needs adjusting",
  "submitted_by": "waze_editor",
  "submitted_by_url": "https://www.waze.com/user/editor/waze_editor",
  "editor_rank": 4
}
```

`prefix`, `lock_level`, `notes`, `submitted_by`, `submitted_by_url`, and `editor_rank` are `null` when not applicable (e.g. `lock_level` for imagery requests).

`custom_prefix` (optional) is text prepended on its own line before the permalink in every message sent through that channel — for Discord it's sent in the message's `content` field (so `@mentions` inside it actually notify people), for Slack/Telegram it's the first line of the message text. It supports these variables, substituted per-request at send time:

| Variable | Resolves to |
|---|---|
| `{lock_level}` | The request's lock level (empty string for imagery requests) |
| `{country_code}` | The channel's country code, e.g. `ZA` |
| `{country_name}` | The channel's country name, e.g. `South Africa` |
| `{editor_rank}` | The submitter's WME editor rank |
| `{type}` | `downlock` or `imagery` |
| `{submitted_by}` | The submitter's Waze username |

Since channels are already split by `event_type`, this covers per-type formatting without conditionals — e.g. a `downlock` channel's prefix `L{lock_level}{country_code}` renders `L5ZA` for a lock-5 South Africa request, while an `imagery` channel can use a fixed prefix like `L5{country_code}` (or the literal `L5ZA`) since imagery requests have no lock level. Test a channel from the dashboard to preview the rendered prefix (sample values: `lock_level=3`, `editor_rank=3`, `submitted_by=TestUser`).

### Requests

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/requests` | List requests (filters: `country_id`, `type`, `status`, `limit`, `offset`) |
| POST | `/api/requests` | Submit a request (see body below) |
| GET | `/api/requests/:id` | Get a request |
| PUT | `/api/requests/:id` | Update `{ status?, notes? }` |
| DELETE | `/api/requests/:id` | Delete a request |

**Request body**

```json
{
  "country_id": 1,
  "type": "downlock",
  "permalink": "https://www.waze.com/editor?…",
  "lock_level": 4,
  "notes": "Residential street locked too high",
  "submitted_by": "waze_username"
}
```

`lock_level` is `1–7` and applies to `downlock` requests only (inferred from the segment inside the userscript).

### Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports/by-user` | Requests grouped by `submitted_by`, with downlock/imagery counts and each user's majority type |

Backs the `/reports` dashboard page.

---

## Userscript Setup

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Greasemonkey) in your browser.
2. Open `userscript/wme-requests.user.js` and install it.
3. In WME, find the **WME Requests** tab in the sidebar.
4. Click **⚙** (settings) and enter your Cloudflare Workers URL, e.g. `https://your-project.your-subdomain.workers.dev`.
5. Select a segment on the map — the lock level is read automatically.
6. Choose a country, then click the button for the request type you want (e.g. **Downlock**).

---

## Notification Examples

**Slack / Discord message**

> 🔒 **Downlock Request — Australia**
> Permalink: https://www.waze.com/editor?…
> Lock Level: 4
> Submitted by: waze_editor

**Telegram** — same content, formatted with MarkdownV2.

---

## Database Schema

```sql
countries            (id, name, code, created_at)
notification_channels(id, country_id, label, platform, event_type,
                      webhook_url, bot_token, chat_id, custom_prefix, email_to, created_at)
requests             (id, country_id, type, permalink, lock_level, editor_rank,
                      status, notes, submitted_by, created_at, updated_at)
```

See [`migrations/`](migrations/) for the full, incremental schema history.

---

## Environment Variables

Set these in `wrangler.jsonc` under `vars`:

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://waze.com,https://www.waze.com,https://beta.waze.com` | Comma-separated CORS allowlist, or `*` for any origin. Only the request's actual `Origin` header is echoed back if it exact-matches an entry — unlisted origins get no `Access-Control-Allow-Origin` header at all, which the browser treats as a CORS failure. This only affects cross-origin `fetch`/`XHR` calls (i.e. the public `POST /api/requests` endpoint called from a web page); it does **not** gate `GM_xmlhttpRequest` calls made by the userscript itself, since those are a browser-extension-privileged request type that bypasses CORS enforcement entirely — the restriction's real value is stopping an arbitrary website's client-side JS from posting fake requests through a visiting user's browser. |
| `APP_URL` | `https://requests.wmekit.com` | This app's own origin, for redirects back from the account service and links in "set your password" emails. |
| `AUTH_URL` | `https://auth.wmekit.com` | The WMEKit account service, where people sign in and manage their account. |

The `AUTH` service binding (`services` in `wrangler.jsonc`) points at the `wmeauth` Worker.

Per-channel notification credentials (Slack/Discord webhook URLs, Telegram bot token + chat ID, email recipient) are stored **in the database**, scoped to each channel; email channels send through a BYOK credential from the Credentials Manager.

---

## License

MIT