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
