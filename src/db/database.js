const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'streamgate.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    -- Per-guild bot configuration (admin role, etc.)
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id         TEXT PRIMARY KEY,
      admin_role_id    TEXT,
      trigger_keyword  TEXT NOT NULL DEFAULT 'GOI',
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Leagues are scoped to a guild
    CREATE TABLE IF NOT EXISTS leagues (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id         TEXT NOT NULL,
      name             TEXT NOT NULL,
      abbr             TEXT NOT NULL,
      ppv_channel_id   TEXT NOT NULL,
      category_id      TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, abbr)
    );

    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id       TEXT UNIQUE NOT NULL,
      discord_username TEXT NOT NULL,
      registered_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      active           INTEGER DEFAULT 1
    );

    -- Platform accounts are global (a Twitch login belongs to one person regardless of guild)
    CREATE TABLE IF NOT EXISTS user_platforms (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id),
      platform            TEXT NOT NULL CHECK(platform IN ('twitch', 'youtube')),
      platform_username   TEXT NOT NULL,
      platform_user_id    TEXT,
      subscription_id     TEXT,
      UNIQUE(platform, platform_username)
    );

    -- League memberships are per-guild (user can be in ALPHA in Server A and ALPHA in Server B)
    CREATE TABLE IF NOT EXISTS user_leagues (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      league_id   INTEGER NOT NULL REFERENCES leagues(id),
      added_by    TEXT NOT NULL,
      team_name   TEXT,
      team_abbrev TEXT,
      added_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, league_id)
    );

    -- Dedup per (platform, stream, league) — same stream can post to multiple guilds
    CREATE TABLE IF NOT EXISTS stream_posts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      platform           TEXT NOT NULL,
      platform_stream_id TEXT NOT NULL,
      discord_user_id    TEXT NOT NULL,
      league_id          INTEGER NOT NULL,
      posted_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, platform_stream_id, league_id)
    );

    -- Custom teams (survive deploys; logos stored as BLOBs)
    CREATE TABLE IF NOT EXISTS custom_teams (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      abbrev     TEXT UNIQUE NOT NULL,
      mascot     TEXT,
      colors     TEXT NOT NULL DEFAULT '[]',
      logo       BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One pending disambiguation record per (user, guild)
    CREATE TABLE IF NOT EXISTS pending_routes (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id    TEXT NOT NULL,
      guild_id           TEXT NOT NULL,
      platform           TEXT NOT NULL,
      platform_stream_id TEXT NOT NULL,
      stream_url         TEXT NOT NULL,
      stream_title       TEXT NOT NULL,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at         DATETIME NOT NULL,
      UNIQUE(discord_user_id, guild_id)
    );

    -- ── Dynasty tracking (schedule + results + summaries) ─────────────────────
    -- A league runs multiple seasons (in-game year). One season is "current".
    CREATE TABLE IF NOT EXISTS seasons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id   INTEGER NOT NULL REFERENCES leagues(id),
      year        INTEGER NOT NULL,
      label       TEXT,
      is_current  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(league_id, year)
    );

    -- Conference alignment is league-scoped (teams realign per season).
    CREATE TABLE IF NOT EXISTS conferences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id   INTEGER NOT NULL REFERENCES leagues(id),
      name        TEXT NOT NULL,
      abbrev      TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(league_id, name)
    );

    -- Which teams are in the league this season + their conference. Teams are
    -- referenced by abbrev (resolved via utils/teams.js), not a FK.
    CREATE TABLE IF NOT EXISTS season_teams (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id     INTEGER NOT NULL REFERENCES seasons(id),
      team_abbrev   TEXT NOT NULL,
      conference_id INTEGER REFERENCES conferences(id),
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(season_id, team_abbrev)
    );

    -- A coach is the primary entity. Usually a Discord user (user_id), but may
    -- be a bare display name. League-scoped; persists across seasons.
    CREATE TABLE IF NOT EXISTS coaches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id    INTEGER NOT NULL REFERENCES leagues(id),
      user_id      INTEGER REFERENCES users(id),
      display_name TEXT NOT NULL,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(league_id, user_id)
    );

    -- The CURRENT controller of each team this season (editable). Mid-season
    -- handover = update coach_id; per-game coach snapshots preserve history.
    CREATE TABLE IF NOT EXISTS coach_team_assignments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id   INTEGER NOT NULL REFERENCES seasons(id),
      coach_id    INTEGER NOT NULL REFERENCES coaches(id),
      team_abbrev TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(season_id, team_abbrev)
    );

    -- Schedule rows inserted upfront; result columns filled later. W/L is never
    -- stored — derived from result_type/winner_side or score comparison.
    CREATE TABLE IF NOT EXISTS games (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id      INTEGER NOT NULL REFERENCES seasons(id),
      week           INTEGER NOT NULL,
      home_abbrev    TEXT NOT NULL,
      away_abbrev    TEXT NOT NULL,
      is_user_game   INTEGER NOT NULL DEFAULT 0,
      is_postseason  INTEGER NOT NULL DEFAULT 0,
      home_coach_id  INTEGER REFERENCES coaches(id),
      away_coach_id  INTEGER REFERENCES coaches(id),
      home_score     INTEGER,
      away_score     INTEGER,
      attempts_taken INTEGER,
      result_type    TEXT NOT NULL DEFAULT 'normal',
      winner_side    TEXT,
      played_at      DATETIME,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(season_id, week, home_abbrev, away_abbrev)
    );
  `);

  runMigrations();
  logger.info('Database schema initialised', { path: dbPath });
}

// Safe column additions for existing databases
function runMigrations() {
  const migrations = [
    `ALTER TABLE leagues ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE pending_routes ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE guild_settings ADD COLUMN trigger_keyword TEXT NOT NULL DEFAULT 'GOI'`,
    `ALTER TABLE stream_posts ADD COLUMN stream_title TEXT`,
    `ALTER TABLE user_leagues ADD COLUMN team_name TEXT`,
    `ALTER TABLE user_leagues ADD COLUMN team_abbrev TEXT`,
    `ALTER TABLE leagues ADD COLUMN ping_role_id TEXT`,
    `ALTER TABLE pending_routes ADD COLUMN user_name TEXT`,
    `UPDATE leagues SET abbr = UPPER(abbr) WHERE abbr != UPPER(abbr)`,
    `ALTER TABLE leagues ADD COLUMN advance_channel_id TEXT`,
    `ALTER TABLE leagues ADD COLUMN user_channel_id TEXT`,
    `ALTER TABLE leagues ADD COLUMN schedule_url TEXT`,
    `ALTER TABLE leagues ADD COLUMN staff_role_id TEXT`,
    `ALTER TABLE stream_posts ADD COLUMN discord_message_id TEXT`,
    `ALTER TABLE stream_posts ADD COLUMN discord_channel_id TEXT`,
    `ALTER TABLE leagues ADD COLUMN advance_template TEXT`,
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

module.exports = { db, initSchema };
