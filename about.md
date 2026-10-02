# StreamGate — About & Deployment Guide

StreamGate is a Discord bot plus a small web admin portal for college-football dynasty leagues. It:

- Watches registered members' **Twitch** and **YouTube** channels and, when someone goes live with the server's trigger keyword in the title (default `GOI`, e.g. `GOI OPEN Week 3`), posts the stream to that league's PPV channel. If the league can't be determined, it DMs the streamer to pick one.
- Picks up stream links pasted into configured league channels.
- Tracks dynasty schedules and results (`/results`), team assignments, week advancement, and roster/settings posts.
- Serves a web admin portal at `/admin`, with Discord login, for managing users, leagues, teams, schedules and results.

Everything runs as **one Node.js process**: the Discord bot, an Express web server (webhooks, admin API and admin UI), and a daily maintenance job. Data lives in a single **SQLite** file.

---

## 1. Architecture at a glance

```
          Twitch EventSub ──POST /webhooks/twitch──┐
     YouTube WebSub hub ──GET/POST /webhooks/youtube┤
                                                    ▼
  Browser ──/admin, /auth, /api──►  Express (port 3000)  ──┐
                                                            │  same Node process
  Discord Gateway ◄──────────────►  discord.js bot  ────────┤
                                                            ▼
                                    SQLite: data/streamgate.db (WAL mode)
                                    Logs:   data/logs/YYYY-MM-DD.log
```

| Piece | Where it lives in the repo |
|---|---|
| Entry point | `src/index.js` |
| Bot client, slash commands, events | `src/bot/` |
| Slash-command registration script | `src/bot/commands/deploy.js` (`npm run deploy-commands`) |
| Twitch / YouTube integrations | `src/platforms/twitch/`, `src/platforms/youtube/` |
| Database schema + queries | `src/db/database.js`, `src/db/queries.js` |
| Web admin (OAuth, API, static UI) | `src/web/` |
| Container + hosting config | `Dockerfile`, `fly.toml`, `.dockerignore` |
| CI/CD | `.github/workflows/deploy.yml` |

Public HTTP endpoints:

| Path | Purpose |
|---|---|
| `GET /health` | Liveness check: `{"status":"ok","uptime":…}` |
| `POST /webhooks/twitch` | Twitch EventSub callbacks (HMAC-verified) |
| `GET/POST /webhooks/youtube` | YouTube WebSub verification and notifications (HMAC-verified) |
| `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me` | Discord OAuth for the admin portal |
| `/api/...` | Admin portal JSON API (session-authenticated) |
| `/admin` | Admin portal UI |

---

## 2. Platforms you need

| Platform | Required? | What it's used for | Cost |
|---|---|---|---|
| **Discord Developer Portal** | Yes | Bot account, slash commands, OAuth login for the admin portal | Free |
| **Fly.io** | Yes (current host) | Runs the container 24/7, gives you HTTPS, and stores SQLite on a persistent volume | A small shared VM plus a 1 GB volume. Fly bills by usage and needs a card on file. |
| **GitHub** | Yes (for auto-deploy) | Hosts the repo. A GitHub Action deploys to Fly on every push to `main` | Free |
| **Twitch Developer Console** | For Twitch streams | App credentials for the Helix API and EventSub webhooks | Free |
| **Google Cloud Console** (YouTube Data API v3) | For YouTube streams | API key for checking whether a video is live and resolving channel handles | Free (10,000 units/day; each check costs 1 unit) |
| **Google Sheets** | Optional | A league's week schedule can be read from a sheet published as CSV (`schedule_url` on `/admin addleague` / `editleague`) | Free |
| **Node.js 20 + npm** | For local development | Running the bot locally, tests, registering commands | Free |
| **flyctl** (Fly CLI) | Yes | First-time setup, secrets, SSH, logs, volume snapshots | Free |

Twitch and YouTube are each optional. If `TWITCH_CLIENT_ID` or `YOUTUBE_API_KEY` is unset, that platform's subscription sync is skipped. Both webhooks require a public **HTTPS** URL, which Fly provides at `https://<app>.fly.dev`.

---

## 3. Environment variables

Copy `.env.example` to `.env` for local work. In production, every value is set as a **Fly secret**. Never commit `.env`, `.env.local` or `.env.production`; they're already in `.gitignore`.

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Bot token (Developer Portal → your app → **Bot** → Reset Token). If it's missing, the web server still starts but the bot doesn't connect. |
| `DISCORD_CLIENT_ID` | Yes | Application ID (Developer Portal → **General Information**). |
| `DISCORD_CLIENT_SECRET` | Yes (admin portal) | OAuth2 client secret (Developer Portal → **OAuth2**). Used by `/auth/callback`. |
| `SESSION_SECRET` | Yes | A long random string that signs admin-portal session cookies. It falls back to an insecure dev value if unset, so **always set it in prod**. |
| `PUBLIC_URL` | Yes | The public HTTPS base URL with no trailing slash, e.g. `https://stream-gate.fly.dev`. It's used to build the Twitch/YouTube callback URLs and the Discord OAuth redirect. |
| `PORT` | No | Defaults to `3000`. It must match `internal_port` in `fly.toml`. |
| `GUILD_ID` | No | Only read by the command-registration script. If set, commands go to that one server instantly (useful for dev). If blank, they're registered globally, which takes up to about 1 hour. |
| `TWITCH_CLIENT_ID` | Twitch | Twitch app client ID. |
| `TWITCH_CLIENT_SECRET` | Twitch | Twitch app client secret (used for app access tokens). |
| `TWITCH_WEBHOOK_SECRET` | Twitch | A random string you choose, 10–100 characters. Twitch signs EventSub payloads with it. |
| `YOUTUBE_API_KEY` | YouTube | YouTube Data API v3 key. |
| `YOUTUBE_WEBSUB_SECRET` | YouTube | A random string you choose. The WebSub hub signs notifications with it. |
| `WEB_ORIGIN` | No (advanced) | Comma-separated origins for hosting the admin UI somewhere else (e.g. Firebase Hosting). It turns on CORS, `SameSite=None` cookies, and sends OAuth redirects back to the first origin. **Leave this unset** to use the bundled `/admin` UI. The bundled UI calls the API with relative paths, so a separately hosted copy needs its API base URL changed first. |

Generate random secrets with:

```bash
openssl rand -hex 32
```

> **Local env loading:** `src/index.js` loads `.env`, then `.env.local` with `override: true`. A *blank* `KEY=` line in `.env.local` wipes the value from `.env`, so comment out lines instead of leaving them empty. The command-registration script (`deploy.js`) reads only `.env`.

---

## 4. Platform setup, step by step

### 4.1 Discord

1. Go to <https://discord.com/developers/applications> → **New Application**. Name it (e.g. StreamGate).
2. **General Information**: copy the **Application ID**. That's `DISCORD_CLIENT_ID`.
3. **Bot** tab:
   - **Reset Token**, then copy it into `DISCORD_TOKEN`. Keep it secret; anyone with it controls the bot.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent**. The bot reads messages to detect pasted stream links. Without it, link detection silently gets empty messages.
4. **OAuth2** tab (for the admin portal):
   - Copy the **Client Secret**. That's `DISCORD_CLIENT_SECRET`.
   - Under **Redirects**, add `https://<your-app>.fly.dev/auth/callback` (exactly `PUBLIC_URL` + `/auth/callback`). For local testing, also add `http://localhost:3000/auth/callback`.
5. **Invite the bot**: OAuth2 → **URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, **Manage Messages** (the bot deletes and pins messages), **Mention @everyone/@here/All Roles** (for league ping roles)
   - Open the generated URL and add the bot to your server.
6. Make sure the bot's role can see and post in every league's PPV, advance and user channels. Channel permission overrides can block it.

### 4.2 Twitch

1. Go to <https://dev.twitch.tv/console/apps> → **Register Your Application**.
   - OAuth Redirect URL: `https://localhost` works. StreamGate only uses an app access token (client credentials), so this URL is never actually called.
   - Category: *Chat Bot* or *Application Integration*.
2. Copy the **Client ID** into `TWITCH_CLIENT_ID`. Generate a **New Secret** and put it in `TWITCH_CLIENT_SECRET`.
3. Choose a random string for `TWITCH_WEBHOOK_SECRET`.

How it works: on startup, and whenever a Twitch user is registered, the bot creates a `stream.online` EventSub subscription pointing at `PUBLIC_URL/webhooks/twitch`. Twitch sends a verification challenge to that URL, so **the app must be deployed and reachable before subscriptions can succeed**. When a stream starts, the bot polls Helix `/streams` for up to about 3 minutes until a title appears, then routes it.

### 4.3 YouTube (Google Cloud)

1. Go to <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → Credentials → Create Credentials → API key**. Restrict it to *YouTube Data API v3*. Put it in `YOUTUBE_API_KEY`.
4. Choose a random string for `YOUTUBE_WEBSUB_SECRET`.

How it works: the bot subscribes each registered channel at Google's PubSubHubbub hub (`pubsubhubbub.appspot.com`) with a 10-day lease. The callback is `PUBLIC_URL/webhooks/youtube`. Leases are renewed on startup and daily at 03:00 (server time, UTC on Fly). When a notification arrives, the bot checks whether the video is live, retrying for up to 5 minutes.

### 4.4 GitHub

The repo's workflow (`.github/workflows/deploy.yml`) runs `flyctl deploy --remote-only` on every push to `main`. It needs one repository secret:

| Secret | Value |
|---|---|
| `FLY_API_TOKEN` | Output of `fly tokens create deploy --app stream-gate` |

Add it under **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**.

---

## 5. First-time deployment to Fly.io

The current config (`fly.toml`) runs app **`stream-gate`** in region **`dfw`** on one shared-CPU 256 MB machine that never auto-stops. The `streamgate_data` volume is mounted at `/app/data`, where the database and logs live.

**1. Install and log in to flyctl**

```bash
brew install flyctl
```

```bash
fly auth login
```

**2. Create the app.** If the name `stream-gate` is taken, choose another and update `app =` in `fly.toml`.

```bash
fly apps create stream-gate
```

**3. Create the persistent volume.** Use the same region as `primary_region` in `fly.toml`.

```bash
fly volumes create streamgate_data --size 1 --region dfw --app stream-gate
```

> Keep exactly **one** machine. SQLite on a Fly volume is single-writer and volumes aren't shared between machines, so don't `fly scale count` above 1.

**4. Set secrets.** Fill in your values. `PUBLIC_URL` is `https://<app-name>.fly.dev`.

```bash
fly secrets set --app stream-gate DISCORD_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... SESSION_SECRET=... PUBLIC_URL=https://stream-gate.fly.dev TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... TWITCH_WEBHOOK_SECRET=... YOUTUBE_API_KEY=... YOUTUBE_WEBSUB_SECRET=...
```

**5. Deploy.** Fly builds the `Dockerfile` (Node 20 Alpine, production dependencies only, native build tools for `better-sqlite3`).

```bash
fly deploy --app stream-gate
```

**6. Check that it's up**

```bash
curl https://stream-gate.fly.dev/health
```

```bash
fly logs --app stream-gate
```

You should see `Webhook server listening on port 3000`, and the bot should show as online in Discord.

**7. Register slash commands with Discord.** Run this once now, and again whenever a command's name, options or description changes. Leave `GUILD_ID` unset in prod for global commands.

```bash
fly ssh console --app stream-gate -C "node src/bot/commands/deploy.js"
```

**8. Turn on auto-deploy.** Create the deploy token and add it to GitHub as `FLY_API_TOKEN` (§4.4).

```bash
fly tokens create deploy --app stream-gate
```

From then on, **pushing to `main` deploys automatically**.

---

## 6. Day-to-day operations

### Deploying changes

- Merge or push to `main`. The GitHub Action deploys, and you can watch it in the repo's **Actions** tab.
- If you added or changed slash commands, re-run step 7 after the deploy finishes.
- Schema changes are applied at startup by `initSchema()` (`CREATE TABLE IF NOT EXISTS` plus in-code migrations). There's no separate migration step.
- Admin-portal sessions are kept in memory, so **every deploy or restart logs admins out**. That's expected.

### Changing configuration

Setting a secret triggers a rolling restart of the machine:

```bash
fly secrets set --app stream-gate SOME_KEY=new-value
```

```bash
fly secrets list --app stream-gate
```

### Logs

```bash
fly logs --app stream-gate
```

Logs also persist on the volume at `/app/data/logs/YYYY-MM-DD.log`. The admin portal's Streams view shows why a stream was or wasn't routed (it keeps about 30 days of history).

### Shell access and the database

The production DB is `/app/data/streamgate.db` in **WAL mode**. The `sqlite3` CLI isn't installed in the container, but `better-sqlite3` is, so run ad-hoc DB work as a Node script:

```bash
fly ssh console --app stream-gate
```

To copy files to or from the machine (`get` / `put` inside the shell):

```bash
fly ssh sftp shell --app stream-gate
```

> **When pulling a copy of the DB, grab all three files:** `streamgate.db`, `streamgate.db-wal` and `streamgate.db-shm`. Recent writes live in the `-wal` file, so the bare `.db` can be days out of date.

### Backups

Fly takes automatic daily volume snapshots and keeps them for 5 days:

```bash
fly volumes list --app stream-gate
```

```bash
fly volumes snapshots list <volume-id>
```

For anything you can't afford to lose, also pull a copy (all three DB files) before risky operations such as bulk imports or deletions.

### Scheduled maintenance (automatic)

Every day at 03:00 the app renews YouTube WebSub leases, clears expired pending-route DMs, and prunes stream-event history older than 30 days. Twitch EventSub subscriptions are re-synced on every startup.

---

## 7. Running locally

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env`. For dev, set `GUILD_ID` to your test server so commands register instantly. Then:

```bash
npm run deploy-commands
```

```bash
npm run dev
```

`npm run dev` uses nodemon to auto-restart on changes. Use `npm start` for a plain run.

```bash
npm test
```

Notes for local development:

- The local DB is `./data/streamgate.db`, created automatically. Use a **separate Discord bot application** for dev, so you don't run two processes against the same bot token.
- Twitch and YouTube can't reach `localhost`. To test live-stream detection locally, expose port 3000 over HTTPS with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000` or ngrok) and set `PUBLIC_URL` to the tunnel URL. Otherwise, leave the Twitch/YouTube keys blank locally and test link-pasting and slash commands only.
- The admin portal runs at `http://localhost:3000/admin`. Add `http://localhost:3000/auth/callback` to your Discord app's OAuth2 redirects and set `PUBLIC_URL=http://localhost:3000`.
- `ecosystem.config.js` is a PM2 config left over from an earlier VM-based setup. It isn't used on Fly, but works if you ever self-host on a plain server (`pm2 start ecosystem.config.js`).

---

## 8. Using StreamGate once it's deployed

### Server admin: initial setup (in Discord)

1. **`/admin setup`**: set the admin role (members with it can use admin commands and the web portal) and the trigger keyword (default `GOI`).
2. **`/admin addleague`**: create each league:
   - `name`, `keyword` (the league abbreviation streamers put after the trigger word, e.g. `OPEN`), and `channel` (the PPV channel streams post to)
   - Optional: `category` (gates self-registration to members who can see that category), `ping_role`, `advance_channel`, `user_channel`, `schedule_url` (a published Google Sheets CSV link), `staff_role`
3. **`/admin leagues`** lists leagues. **`/admin editleague`** changes one.
4. **`/admin health`** shows registered users and Twitch/YouTube subscription health for the server.

### Registering streamers

- **Self-service:** members run **`/register`** with platform (Twitch/YouTube), username (Twitch login or YouTube `@handle`), league and team.
- **By an admin:** **`/admin register`**, **`/admin unregister`**, **`/admin removeleague`**, **`/admin users`**, **`/admin audituser`**, **`/admin auditleague`**.
- Members can check their own registration with **`/audit`** and switch teams with **`/changeteam`**.

Registering subscribes that channel right away, so there's no need to wait for a restart.

### Going live

Streamers include the trigger keyword and league abbreviation in their stream title:

| Title | Result |
|---|---|
| `GOI OPEN Alabama vs Georgia` | Posted to the OPEN league's PPV channel |
| `GOI-OPEN …`, `GOIOPEN …` | Same (joined forms work for known leagues) |
| `GOI …` with no or unknown abbreviation, streamer in one league | Auto-routed to that league |
| `GOI …` with no or unknown abbreviation, streamer in several leagues | Bot DMs the streamer with buttons to pick a league |
| No trigger keyword | Ignored |

Unregistered channels are ignored. Pasting a Twitch/YouTube link into a league's configured channel also gets picked up and routed.

### Dynasty results

- **`/results schedule`** adds a game to the current season.
- **`/results record`** records a result (normal, forced result, fair sim, …) through a score form.
- **`/results show`** shows a week's results.

### Web admin portal

Open `https://<your-app>.fly.dev/admin` → **Log in with Discord**. You'll see every server where you are the owner, have Administrator or Manage Server, or hold the configured admin role. From there you can manage users and registrations, leagues, teams and logos, schedules and results, league settings (including imports, with a changelog), and the stream-event log.

### Sanity check

**`/ping`** confirms the bot is responsive.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Bot offline after deploy | Check `fly logs`. Look for a missing or invalid `DISCORD_TOKEN`, or a crash at startup. |
| Slash commands missing or outdated | Re-run `node src/bot/commands/deploy.js` (§5 step 7). Global registration can take up to an hour. |
| Pasted links never detected | Message Content Intent is off, or the channel isn't configured as a league PPV or user channel. Check the stream log. |
| Twitch streams not posting | `PUBLIC_URL` is wrong or not HTTPS, `TWITCH_WEBHOOK_SECRET` changed after subscriptions were created (restart to re-sync), or the title has no trigger keyword. Check `/admin health`. |
| YouTube streams not posting | Lease expired (renewed daily and on restart), the API key is invalid or over quota, or the channel handle couldn't be resolved. |
| Admin login loops or fails with `error=auth_failed` | The redirect URI in the Discord OAuth2 settings doesn't exactly match `PUBLIC_URL/auth/callback`, or `DISCORD_CLIENT_SECRET` is wrong. |
| "No servers" after login | You don't have Administrator, Manage Server or the admin role there, or the server has no `/admin setup` or leagues yet. |
| Data looks like it went back in time | You read a bare `.db` copy without its `-wal` file (§6). |
| Need to roll back a bad deploy | `fly releases --app stream-gate`, then `fly deploy --image <previous-image>`, or revert the commit on `main`. |
