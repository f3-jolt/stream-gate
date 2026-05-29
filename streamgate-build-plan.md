# StreamGate Discord Bot: Build Plan

> A phased build guide for Claude Code. Each phase is self-contained and deployable before moving to the next. Complete phases in order.

---

## Project Overview

**StreamGate** is a Discord bot that monitors stream activity across Twitch and YouTube Live, validates user registration and league membership, parses stream titles for league routing signals, and posts stream links to the correct league PPV channels automatically.

### Core Behavior
- A registered user goes live on Twitch or YouTube with a title containing `GOI [abbr]`
- Bot parses the title, resolves the league abbreviation, and posts the stream to that league's PPV channel
- If the abbreviation is unknown or missing, bot DMs the user to pick a league from their registrations
- If the user is only in one league, it routes automatically with no DM needed
- Unregistered users are silently ignored
- Admins can register or unregister any user on any platform for any league
- Self-registration is restricted to leagues the user has Discord category permission for

### Stream Title Routing Rules

| Title Contains | Behavior |
|---|---|
| `GOI ALPHA` | Routes to League ALPHA's PPV channel |
| `GOI BETA` | Routes to League BETA's PPV channel |
| `GOI` (no abbr or unknown abbr) + user in multiple leagues | DM user: "Which league should this stream post to?" with buttons |
| `GOI` (no abbr or unknown abbr) + user in one league only | Auto-routes to their single league, no DM |
| No `GOI` in title | Ignored entirely, no action taken |

### Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 | discord.js requirement |
| Bot library | discord.js v14 | Full API coverage, maintained |
| Database | SQLite via better-sqlite3 | Zero infrastructure, file-based, right for this scale |
| Twitch detection | Twitch EventSub webhooks | Push-based, no polling |
| YouTube detection | YouTube WebSub (PubSubHubbub) | Push-based, no polling, free |
| Hosting | Fly.io Free Tier | Genuinely free, built-in HTTPS, persistent volume for SQLite |
| Deploy | GitHub Actions + flyctl | Automated on push to main |

---

## Repo Structure

```
streamgate/
├── .github/
│   └── workflows/
│       └── deploy.yml
├── src/
│   ├── index.js                    # Entry point
│   ├── bot/
│   │   ├── client.js               # discord.js client setup
│   │   ├── commands/
│   │   │   ├── register.js         # /register (self, permission-gated)
│   │   │   ├── status.js           # /status
│   │   │   ├── admin.js            # /admin subcommand group
│   │   │   └── deploy.js           # Command registration utility
│   │   └── events/
│   │       ├── ready.js
│   │       └── interactionCreate.js
│   ├── db/
│   │   ├── database.js             # SQLite connection + schema init
│   │   └── queries.js              # All DB query functions
│   ├── platforms/
│   │   ├── twitch/
│   │   │   ├── eventsub.js         # Twitch webhook listener
│   │   │   └── api.js              # Twitch API helpers
│   │   └── youtube/
│   │       ├── websub.js           # YouTube WebSub listener
│   │       └── api.js              # YouTube Data API helpers
│   └── utils/
│       ├── titleParser.js          # GOI [abbr] extraction logic
│       ├── channelRouter.js        # Routing + DM disambiguation logic
│       └── logger.js
├── data/
│   └── streamgate.db               # SQLite file (gitignored)
├── .env                            # Gitignored
├── .env.example                    # Committed, no secrets
├── .gitignore
├── package.json
└── ecosystem.config.js             # PM2 config
```

---

## Environment Variables

```bash
# .env.example

# Discord
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
GUILD_ID=
ADMIN_ROLE_ID=

# Twitch
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_WEBHOOK_SECRET=

# YouTube
YOUTUBE_API_KEY=
YOUTUBE_WEBSUB_SECRET=

# Server
PORT=3000
PUBLIC_URL=https://yourdomain.com   # Must be HTTPS for both Twitch EventSub and YouTube WebSub
```

---

## Phase 1: Project Scaffold + Bot Online

**Goal:** Repo is set up, bot connects to Discord, slash commands are registered, and PM2 keeps it alive.

### Tasks

1. Init the repo and install dependencies
```bash
npm init -y
npm install discord.js dotenv better-sqlite3 express axios xml2js
npm install -D nodemon
```

2. Create `src/bot/client.js`
```javascript
const { Client, GatewayIntentBits, Collection } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ]
});

client.commands = new Collection();
module.exports = client;
```

3. Create `src/index.js` as the entry point wiring client, commands, events, and the Express webhook server

4. Create `ecosystem.config.js` for PM2
```javascript
module.exports = {
  apps: [{
    name: 'streamgate',
    script: 'src/index.js',
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
};
```

### Acceptance Criteria
- [ ] `node src/index.js` starts without errors
- [ ] Bot appears online in Discord server
- [ ] `pm2 start ecosystem.config.js` runs and survives a `pm2 kill` + restart
- [ ] `/ping` placeholder command responds in Discord

---

## Phase 2: Database Schema + User Registration

**Goal:** Full schema is live with multi-platform support and category-based league permissions. Users can self-register for leagues they have access to. Admins can register anyone on any platform for any league.

### Schema

```sql
-- Leagues: each has an abbreviation used in GOI titles and a PPV channel
CREATE TABLE IF NOT EXISTS leagues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  abbr        TEXT UNIQUE NOT NULL,         -- e.g. "ALPHA", "BETA" -- matches GOI title tag
  ppv_channel_id   TEXT NOT NULL,           -- Discord channel ID to post streams to
  category_id TEXT,                         -- Discord category ID that gates self-registration
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users: one row per Discord user
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id       TEXT UNIQUE NOT NULL,
  discord_username TEXT NOT NULL,
  registered_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  active           INTEGER DEFAULT 1
);

-- Platform accounts: one user can have multiple platforms
-- A user can have one Twitch account AND one YouTube channel
CREATE TABLE IF NOT EXISTS user_platforms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  platform        TEXT NOT NULL CHECK(platform IN ('twitch', 'youtube')),
  platform_username   TEXT NOT NULL,        -- Twitch login or YouTube channel handle
  platform_user_id    TEXT,                 -- Twitch user ID or YouTube channel ID (resolved on register)
  subscription_id     TEXT,                 -- EventSub / WebSub subscription ID
  UNIQUE(platform, platform_username)
);

-- League memberships: one user can be in multiple leagues
CREATE TABLE IF NOT EXISTS user_leagues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  league_id  INTEGER NOT NULL REFERENCES leagues(id),
  added_by   TEXT NOT NULL,                 -- 'self' or discord_id of admin who registered them
  added_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, league_id)
);

-- Deduplication: prevent double-posting the same stream
CREATE TABLE IF NOT EXISTS stream_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT NOT NULL,
  platform_stream_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  league_id       INTEGER NOT NULL,
  posted_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_stream_id)
);

-- Pending routing decisions: user was DMed, waiting on their response
CREATE TABLE IF NOT EXISTS pending_routes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL,
  platform        TEXT NOT NULL,
  platform_stream_id TEXT NOT NULL,
  stream_url      TEXT NOT NULL,
  stream_title    TEXT NOT NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME NOT NULL         -- Auto-expire after 10 minutes
);
```

### Category Permission Logic

When a user runs `/register`, the bot checks whether they can see the Discord category associated with the league. If they can see it, they can register. If not, they get a "you don't have access to this league" reply.

```javascript
// In register.js
async function userCanAccessLeague(member, league) {
  if (!league.category_id) return true; // No restriction set, open league
  const category = await member.guild.channels.fetch(league.category_id);
  if (!category) return false;
  return category.permissionsFor(member).has('ViewChannel');
}
```

### Query Functions to Build in `src/db/queries.js`

- `getOrCreateUser(discordId, discordUsername)`
- `getUserLeagues(discordId)` - returns all leagues a user is enrolled in
- `addUserToLeague(discordId, leagueId, addedBy)`
- `removeUserFromLeague(discordId, leagueId)`
- `addUserPlatform(discordId, platform, platformUsername, platformUserId)`
- `removeUserPlatform(discordId, platform)`
- `getUserByPlatform(platform, platformUsername)`
- `getAllLeagues()`
- `getLeagueByAbbr(abbr)`
- `savePendingRoute(discordUserId, platform, streamId, streamUrl, streamTitle)`
- `getPendingRoute(discordUserId)`
- `clearPendingRoute(discordUserId)`

### `/register` Slash Command (Self-Service)

Options:
- `platform`: choice of `twitch` or `youtube`
- `username`: their Twitch login or YouTube handle
- `league`: autocomplete dropdown populated from leagues

Behavior:
1. Check category permission for the selected league
2. If no permission: ephemeral reply "You don't have access to this league"
3. Resolve the platform username to a platform user ID via API
4. Insert into `users`, `user_platforms`, and `user_leagues`
5. Subscribe to stream events for that platform account (if not already subscribed)
6. Confirm with ephemeral reply

### `/status` Slash Command

Shows the calling user's full registration: all platforms linked, all leagues enrolled in.

### Acceptance Criteria
- [ ] Schema creates cleanly on first startup with no errors
- [ ] `/register platform:twitch username:shroud league:ALPHA` saves to DB
- [ ] A user without category access gets rejected from registering for that league
- [ ] A user can register for multiple leagues with multiple platform accounts
- [ ] `/status` lists all linked platforms and leagues correctly
- [ ] Database persists across bot restarts

---

## Phase 3: Stream Title Parser

**Goal:** A utility that extracts the league abbreviation from a stream title, used by both Twitch and YouTube stream handlers.

### Logic

```javascript
// src/utils/titleParser.js

const GOI_PATTERN = /\bGOI\b\s*([A-Z0-9]+)?/i;

function parseStreamTitle(title) {
  const match = title.match(GOI_PATTERN);

  if (!match) {
    return { isGOI: false, abbr: null };
  }

  const abbr = match[1] ? match[1].toUpperCase().trim() : null;
  return { isGOI: true, abbr };
}

module.exports = { parseStreamTitle };
```

### Behavior

| Title | isGOI | abbr |
|---|---|---|
| `GOI ALPHA Championship Week 3` | true | `ALPHA` |
| `GOI - Beta League Finals` | true | `BETA` |
| `GOI` | true | null |
| `GOI xyz123` | true | `XYZ123` (resolved later against DB) |
| `College Football Week 7` | false | null |

### Acceptance Criteria
- [ ] `parseStreamTitle('GOI ALPHA Week 3')` returns `{ isGOI: true, abbr: 'ALPHA' }`
- [ ] `parseStreamTitle('GOI')` returns `{ isGOI: true, abbr: null }`
- [ ] `parseStreamTitle('just a regular stream')` returns `{ isGOI: false, abbr: null }`
- [ ] Parsing is case-insensitive (`goi alpha` works the same as `GOI ALPHA`)
- [ ] Unit tests pass for all cases above

---

## Phase 4: Channel Router + DM Disambiguation

**Goal:** Core routing logic that takes a stream event, resolves the correct league channel, and handles the DM flow when the league is ambiguous.

### Routing Logic (`src/utils/channelRouter.js`)

```javascript
async function routeStream(platform, platformUsername, streamData) {
  // 1. Parse title
  const { isGOI, abbr } = parseStreamTitle(streamData.title);
  if (!isGOI) return; // Not a GOI stream, ignore

  // 2. Look up user
  const user = await getUserByPlatform(platform, platformUsername);
  if (!user) return; // Not registered, ignore silently

  const userLeagues = await getUserLeagues(user.discord_id);
  if (!userLeagues.length) return; // Registered user but no leagues

  // 3. Resolve target league
  let targetLeague = null;

  if (abbr) {
    targetLeague = userLeagues.find(l => l.abbr === abbr);
    // abbr present but not one of their leagues: fall through to disambiguation
  }

  if (!targetLeague && userLeagues.length === 1) {
    targetLeague = userLeagues[0]; // Single league, auto-route
  }

  if (!targetLeague) {
    // Multiple leagues, no valid abbr: DM the user
    await sendDisambiguationDM(user.discord_id, userLeagues, streamData);
    return;
  }

  // 4. Dedup check
  const alreadyPosted = checkStreamPost(platform, streamData.id);
  if (alreadyPosted) return;

  // 5. Post to PPV channel
  await postStreamToChannel(targetLeague, user, platform, streamData);
}
```

### Disambiguation DM Flow

When the bot cannot determine the league, it DMs the user with Discord buttons:

```javascript
async function sendDisambiguationDM(discordUserId, userLeagues, streamData) {
  // Save to pending_routes with 10-minute expiry
  await savePendingRoute(discordUserId, streamData);

  const row = new ActionRowBuilder().addComponents(
    ...userLeagues.map(league =>
      new ButtonBuilder()
        .setCustomId(`route_${league.id}_${streamData.id}`)
        .setLabel(league.name)
        .setStyle(ButtonStyle.Primary)
    )
  );

  const user = await client.users.fetch(discordUserId);
  await user.send({
    content: `Your stream **"${streamData.title}"** is live! Which league should this be posted to?`,
    components: [row]
  });
}
```

Handle the button click in `interactionCreate.js`:
- Verify the `pending_routes` record still exists and hasn't expired
- Route to the selected league channel
- Clear the pending record
- Edit the DM to confirm: "Posted to #league-alpha-ppv"

### Discord Embed for PPV Channel Posts

```javascript
function buildStreamEmbed(user, league, platform, streamData) {
  const streamUrl = platform === 'twitch'
    ? `https://twitch.tv/${streamData.user_login}`
    : `https://youtube.com/watch?v=${streamData.videoId}`;

  const platformColor = platform === 'twitch' ? 0x6441a5 : 0xFF0000;
  const platformLabel = platform === 'twitch' ? 'Twitch' : 'YouTube';

  return new EmbedBuilder()
    .setTitle(`${streamData.user_name} is LIVE on ${platformLabel}`)
    .setURL(streamUrl)
    .setDescription(streamData.title)
    .addFields(
      { name: 'League', value: league.name, inline: true },
      { name: 'Platform', value: platformLabel, inline: true }
    )
    .setColor(platformColor)
    .setTimestamp();
}
```

### Acceptance Criteria
- [ ] `GOI ALPHA` in title posts to ALPHA league PPV channel
- [ ] `GOI` with a user in one league auto-posts to that league
- [ ] `GOI` with a user in two leagues sends a DM with buttons
- [ ] Clicking a button in the DM posts to the correct channel and confirms
- [ ] Expired pending routes (10+ minutes old) are rejected with a polite DM reply
- [ ] Duplicate stream IDs do not post twice
- [ ] Non-GOI titles are silently ignored
- [ ] Unknown abbreviation with single-league user auto-routes correctly

---

## Phase 5: Twitch EventSub Integration

**Goal:** Bot receives push notifications from Twitch when registered users go live. No polling.

### How It Works
Twitch sends a signed POST to your HTTPS endpoint when a subscribed event fires. You verify the HMAC signature and emit the event internally.

### Tasks

1. Create `src/platforms/twitch/eventsub.js`:
   - `POST /webhooks/twitch` handler on the shared Express server
   - Verify Twitch HMAC signature on every request (reject failures with 403)
   - Handle message types: `webhook_callback_verification`, `notification`, `revocation`
   - On `stream.online` notification: call `routeStream('twitch', username, streamData)`

2. Create `src/platforms/twitch/api.js`:
   - `getAppAccessToken()`
   - `getTwitchUserByUsername(username)` - resolves to Twitch user ID
   - `subscribeToStreamOnline(twitchUserId)`
   - `deleteSubscription(subscriptionId)`
   - `syncSubscriptions()` - called on startup, ensures all registered Twitch users have active subs

3. On bot startup: call `syncSubscriptions()` before the bot reports ready

### HTTPS Requirement
Both Twitch EventSub and YouTube WebSub require valid HTTPS. Set this up before writing webhook code.

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
# Point a domain at your Oracle IP first, then:
sudo certbot --nginx -d yourdomain.com
```

Configure Nginx to proxy to your Express app:
```nginx
location /webhooks/ {
  proxy_pass http://localhost:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

### Acceptance Criteria
- [ ] Twitch webhook verification challenge returns correct response
- [ ] HMAC signature failures return 403 and are logged
- [ ] Going live on Twitch fires `stream.online` and calls `routeStream`
- [ ] All registered Twitch users have active subscriptions on startup
- [ ] Revoked subscriptions are logged and re-subscribed on next startup

---

## Phase 6: YouTube Live WebSub Integration

**Goal:** Bot receives push notifications from YouTube when registered users go live. No polling, no quota burn.

### How YouTube WebSub Works
YouTube supports the WebSub (PubSubHubbub) protocol. You subscribe to a channel's Atom feed at `https://www.youtube.com/xml/feeds/videos.xml?channel_id=CHANNEL_ID`. YouTube sends a POST to your endpoint when that channel publishes or goes live.

**Important caveat:** YouTube WebSub fires on new video uploads AND on live stream starts. You must call the YouTube Data API to check if the video is actually a live stream before routing.

### Tasks

1. Create `src/platforms/youtube/websub.js`:
   - `POST /webhooks/youtube` handler
   - Handle the initial `GET` subscription verification challenge (hub.challenge)
   - Verify the WebSub HMAC signature (`X-Hub-Signature` header)
   - Parse the Atom XML payload using `xml2js`
   - Extract the video ID from the feed entry
   - Call `checkIfLiveStream(videoId)` before routing (filters out regular uploads)
   - On confirmed live stream: call `routeStream('youtube', channelHandle, streamData)`

2. Create `src/platforms/youtube/api.js`:
   - `getChannelIdByHandle(handle)` - resolves `@handle` to channel ID
   - `subscribeToChannel(channelId)` - POSTs to YouTube's WebSub hub
   - `renewSubscriptions()` - WebSub subscriptions expire after ~10 days, renew on startup
   - `checkIfLiveStream(videoId)` - calls YouTube Data API to confirm `liveBroadcastContent === 'live'`
   - `getLiveStreamDetails(videoId)` - fetches title and stream URL

3. WebSub subscription request:
```javascript
async function subscribeToChannel(channelId) {
  const params = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
    'hub.callback': `${process.env.PUBLIC_URL}/webhooks/youtube`,
    'hub.secret': process.env.YOUTUBE_WEBSUB_SECRET,
    'hub.lease_seconds': 864000  // 10 days
  });
  await axios.post('https://pubsubhubbub.appspot.com/subscribe', params);
}
```

4. On bot startup: call `renewSubscriptions()` for all registered YouTube users

### YouTube API Quota Note
WebSub itself is free and has no quota. The `checkIfLiveStream` call uses the YouTube Data API v3 which has a free daily quota of 10,000 units. Each `videos.list` call costs 1 unit. At this scale you will not hit the quota ceiling.

### Acceptance Criteria
- [ ] YouTube WebSub verification challenge responds correctly
- [ ] HMAC signature check rejects unsigned requests
- [ ] Regular video uploads are correctly identified and ignored
- [ ] Going live on YouTube triggers `routeStream` with correct stream data
- [ ] All registered YouTube users have active WebSub subscriptions on startup
- [ ] Subscriptions are renewed on startup before they expire

---

## Phase 7: Admin Commands

**Goal:** Admins can manage any user registration on any platform for any league without touching the database.

### `/admin` Subcommand Group

All subcommands require the `ADMIN_ROLE_ID` role. Fail silently with an ephemeral "Not authorized" reply for non-admins.

```javascript
// Guard applied in interactionCreate.js before executing any admin subcommand
if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
  return interaction.reply({ content: 'Not authorized.', ephemeral: true });
}
```

### Subcommands

| Command | Options | Behavior |
|---|---|---|
| `/admin register` | `@user platform username league` | Registers any user on any platform for any league. Bypasses category permission check. |
| `/admin unregister` | `@user platform` | Removes a user's platform account and cancels its subscription |
| `/admin removeLeague` | `@user league` | Removes a user from a specific league only |
| `/admin status` | `@user` | Shows full registration details for any user |
| `/admin leagues` | (none) | Lists all leagues, abbreviations, and PPV channel mappings |
| `/admin addleague` | `name abbr channel category` | Adds a new league |
| `/admin users` | `league` | Lists all registered users in a league |
| `/admin sync` | `platform` (optional) | Re-syncs EventSub/WebSub subscriptions for all users on a platform |
| `/admin announce` | `league url title` | Manually posts a stream link to a league PPV channel |

### `/admin register` Detail

```javascript
// Registers @user on platform with username for league
// Does NOT check category permissions (admin override)
// Resolves platform username to platform user ID
// Creates user record if first registration
// Adds platform account if not already linked
// Adds league membership
// Subscribes to stream events for that platform account
```

### Acceptance Criteria
- [ ] Non-admins get ephemeral "Not authorized" for all `/admin` commands
- [ ] Admin can register a user on Twitch for any league regardless of their Discord roles
- [ ] Admin can register the same user on YouTube for a different league
- [ ] Admin can remove a user from one league without affecting their other leagues
- [ ] `/admin sync` re-creates missing subscriptions without duplicating existing ones
- [ ] `/admin announce` posts correctly formatted embed to the target league's PPV channel

---

## Phase 8: Deploy to Fly.io

**Goal:** Every push to `main` automatically deploys to Fly.io. Bot stays running 24/7 on the free tier with a persistent volume for SQLite.

### Why Fly.io
- Free tier: 3 shared VMs + 3GB persistent volume
- Built-in HTTPS on `appname.fly.dev` — no domain or cert setup needed
- Twitch EventSub and YouTube WebSub work against the fly.dev URL out of the box

### Files added to the repo
- `Dockerfile` — Node 20 Alpine image, production deps only
- `fly.toml` — app config: 256MB RAM, no auto-stop, volume mounted at `/app/data`
- `.dockerignore` — excludes node_modules, .env, data/, logs/
- `.github/workflows/deploy.yml` — runs `flyctl deploy` on push to main

### One-Time Setup

**1. Install flyctl (Mac)**
```bash
brew install flyctl
```

**2. Create a Fly.io account**
```bash
fly auth signup
```
Fly.io requires a credit card for identity verification but does not charge on the free tier.

**3. Create the app**
```bash
fly apps create stream-gate
```
If `stream-gate` is taken, pick any unique name and update the `app =` line in `fly.toml`.

**4. Create the persistent volume** (stores SQLite DB + logs)
```bash
fly volumes create streamgate_data --size 1 --app stream-gate
```
Pick the same region you chose during signup.

**5. Set all environment variables as secrets**
```bash
fly secrets set \
  DISCORD_TOKEN=your_token \
  DISCORD_CLIENT_ID=your_client_id \
  TWITCH_CLIENT_ID=your_client_id \
  TWITCH_CLIENT_SECRET=your_secret \
  TWITCH_WEBHOOK_SECRET=any_random_string \
  YOUTUBE_API_KEY=your_key \
  YOUTUBE_WEBSUB_SECRET=any_random_string \
  PUBLIC_URL=https://stream-gate.fly.dev \
  PORT=3000 \
  --app stream-gate
```

**6. Deploy**
```bash
fly deploy --app stream-gate
```

**7. Register Discord slash commands**
```bash
fly ssh console --app stream-gate -C "node src/bot/commands/deploy.js"
```

**8. Add GitHub secret for auto-deploy**

Get a deploy token:
```bash
fly tokens create deploy --app stream-gate
```
Go to **github.com/f3-jolt/stream-gate → Settings → Secrets → Actions** and add:

| Secret | Value |
|---|---|
| `FLY_API_TOKEN` | Output of the token command above |

### Acceptance Criteria
- [ ] `fly deploy` succeeds and bot comes online in Discord
- [ ] `https://stream-gate.fly.dev/health` returns `{"status":"ok"}`
- [ ] Push to `main` triggers GitHub Action and redeploys
- [ ] Bot stays online after deploy (no auto-stop)
- [ ] SQLite database persists across redeploys (`fly volumes list` shows the volume)

---

## Phase 9: Operational Polish

**Goal:** Logging, error handling, and subscription health monitoring so the bot runs unattended.

### Tasks

1. Daily log files to `logs/YYYY-MM-DD.log`:
   - Stream detected (platform, user, title)
   - Stream routed (league, channel)
   - DM sent (disambiguation)
   - Registration added/removed
   - Subscription created/renewed/failed
   - Errors with stack traces

2. Wrap all webhook handlers and Discord event handlers in try/catch so a single failure never crashes the process

3. Add a `/admin health` command that reports:
   - Total registered users
   - Active Twitch subscriptions vs expected
   - Active YouTube subscriptions vs expected
   - Pending routes older than 5 minutes (stuck disambiguations)

4. Scheduled task (daily via `node-cron`): renew YouTube WebSub subscriptions before they expire, clean up expired `pending_routes` rows

```javascript
const cron = require('node-cron');
cron.schedule('0 3 * * *', async () => {
  await renewYouTubeSubscriptions();
  await clearExpiredPendingRoutes();
  logger.info('Daily maintenance complete');
});
```

### Acceptance Criteria
- [ ] Log files write to `logs/YYYY-MM-DD.log` and rotate daily
- [ ] A webhook error logs and returns a 500 without crashing PM2
- [ ] `/admin health` shows accurate subscription counts
- [ ] YouTube subscriptions are renewed automatically before expiry
- [ ] Pending routes older than 10 minutes are cleaned up daily

---

## Build Order Summary

| Phase | Focus | Deliverable |
|---|---|---|
| 1 | Scaffold | Bot is online in Discord |
| 2 | Database + Registration | Multi-platform schema, self-register with permission gates, admin register |
| 3 | Title Parser | GOI [abbr] extraction utility with unit tests |
| 4 | Channel Router | Routing logic + DM disambiguation buttons |
| 5 | Twitch EventSub | Push notifications when Twitch users go live |
| 6 | YouTube WebSub | Push notifications when YouTube users go live |
| 7 | Admin Commands | Full admin tooling for all registration management |
| 8 | CI/CD | Auto-deploy on push to main |
| 9 | Polish | Logging, error handling, subscription health |

### Critical Path Notes

- **Fly.io provides HTTPS automatically.** Your `appname.fly.dev` URL is HTTPS from day one — no domain, Nginx, or Certbot setup needed. Set `PUBLIC_URL=https://your-app.fly.dev` in your secrets before registering Twitch/YouTube subscriptions.
- **Phase 3 (title parser) is a dependency for Phase 4.** Build and test it in isolation first with unit tests before wiring it into routing.
- **YouTube WebSub fires on uploads too**, not just live streams. The `checkIfLiveStream` call in Phase 6 is not optional.
- **WebSub subscriptions expire.** The renewal cron in Phase 9 is not optional either. Without it, YouTube routing silently stops working after 10 days.
