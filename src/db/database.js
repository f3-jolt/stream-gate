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
      active           INTEGER NOT NULL DEFAULT 1,
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

    -- Legacy custom-teams store (kept as a backup; seeded into the teams table below).
    CREATE TABLE IF NOT EXISTS custom_teams (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      abbrev     TEXT UNIQUE NOT NULL,
      mascot     TEXT,
      colors     TEXT NOT NULL DEFAULT '[]',
      logo       BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Unified team catalog (all teams, NCAA + custom) so team data lives on the
    -- persistent volume and is editable at runtime. Seeded once from the bundled
    -- JSON + the legacy custom_teams table by seedTeamsIfEmpty().
    CREATE TABLE IF NOT EXISTS teams (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      abbrev     TEXT NOT NULL,
      conference TEXT,
      mascot     TEXT,
      colors     TEXT NOT NULL DEFAULT '[]',
      pic        TEXT,                       -- bundled logo file path (NCAA teams)
      logo       BLOB,                       -- overrides pic when present
      is_custom  INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(abbrev)
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
  migrateLeaguesActiveUnique();
  seedTeamsIfEmpty();
  runDataMigrations();
  logger.info('Database schema initialised', { path: dbPath });
}

// One-time data migrations, tracked via PRAGMA user_version so they never re-run
// (important where a re-run would undo intentional user actions).
function runDataMigrations() {
  let version = db.pragma('user_version', { simple: true });

  // v1: existing dynasty coaches predate coach-add registering league
  // membership. Backfill a user_leagues row for each coach that has a linked
  // user, without disturbing any team already recorded. One-time only, so a
  // later "remove from league" is not resurrected on the next boot.
  if (version < 1) {
    const r = db.prepare(`
      INSERT INTO user_leagues (user_id, league_id, added_by, team_name, team_abbrev)
      SELECT co.user_id, co.league_id, 'dynasty-coach', NULL, NULL
      FROM coaches co
      WHERE co.user_id IS NOT NULL
      ON CONFLICT(user_id, league_id) DO NOTHING
    `).run();
    logger.info('Data migration v1: backfilled coach league memberships', { added: r.changes });
    db.pragma('user_version = 1');
    version = 1;
  }
}

const TEAMS_JSON_PATH = path.join(process.cwd(), 'src/db/teams/ncca-teams.json');

// One-time population of the unified `teams` table from the bundled NCAA JSON
// plus the legacy custom_teams rows. Runs only while the table is empty, so it
// never clobbers runtime edits. NCAA logos stay as `pic` file paths (they ship
// in the image); custom/edited logos live in the `logo` BLOB on the volume.
function seedTeamsIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM teams').get();
  if (c > 0) return;

  let json = {};
  try {
    json = JSON.parse(fs.readFileSync(TEAMS_JSON_PATH, 'utf8'));
  } catch (err) {
    logger.error('Team seed: could not read teams JSON', { error: err.message });
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO teams (name, abbrev, conference, mascot, colors, pic, logo, is_custom, active)
    VALUES (@name, @abbrev, @conference, @mascot, @colors, @pic, @logo, @is_custom, 1)
  `);

  const seed = db.transaction(() => {
    for (const [name, info] of Object.entries(json)) {
      insert.run({
        name,
        abbrev: String(info.abbrev).toUpperCase(),
        conference: info.conference || null,
        mascot: info.mascot || null,
        colors: JSON.stringify(info.colors || []),
        pic: info.pic || null,
        logo: null,
        is_custom: 0,
      });
    }
    let customRows = [];
    try { customRows = db.prepare('SELECT * FROM custom_teams').all(); } catch { /* table may not exist */ }
    for (const t of customRows) {
      insert.run({
        name: t.name,
        abbrev: String(t.abbrev).toUpperCase(),
        conference: 'Custom',
        mascot: t.mascot || null,
        colors: t.colors || '[]',
        pic: null,
        logo: t.logo || null,
        is_custom: 1,
      });
    }
  });
  seed();

  const total = db.prepare('SELECT COUNT(*) AS c FROM teams').get().c;
  let legacyCustom = 0;
  try { legacyCustom = db.prepare('SELECT COUNT(*) AS c FROM custom_teams').get().c; } catch { /* no table */ }
  const expected = Object.keys(json).length + legacyCustom;
  if (total < expected) {
    // INSERT OR IGNORE dropped rows — almost always a duplicate abbrev in the source.
    logger.error('Team seed dropped rows (duplicate abbrev?)', { seeded: total, expected });
  }
  logger.info('Seeded teams table', { total, fromJson: Object.keys(json).length, legacyCustom });
}

// The leagues table historically enforced UNIQUE(guild_id, abbr) across ALL
// rows, so a deactivated league permanently reserved its keyword. We want a
// keyword to be unique only among ACTIVE leagues: a deactivated league may
// share its keyword with a new active one. SQLite can't drop a table-level
// constraint, so rebuild the table without it and add a partial unique index.
function migrateLeaguesActiveUnique() {
  // Idempotent: the partial index is the marker that this migration ran.
  const alreadyDone = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_leagues_active_abbr'"
  ).get();
  if (alreadyDone) return;

  const tbl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leagues'"
  ).get();
  if (!tbl) return; // table created fresh below by a future run — nothing to migrate

  const hasTableUnique = /UNIQUE\s*\(\s*guild_id\s*,\s*abbr\s*\)/i.test(tbl.sql);

  // A referenced table can't be dropped while FK enforcement is on. The pragma
  // is a no-op inside a transaction, so toggle it around the transaction.
  const fkWasOn = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (hasTableUnique) {
        // Reuse the live CREATE (so every ALTER-added column is preserved),
        // just stripped of the table-level UNIQUE clause.
        const newSql = tbl.sql
          .replace(/CREATE TABLE\s+(?:"leagues"|`leagues`|\[leagues\]|leagues)/i, 'CREATE TABLE leagues_new')
          .replace(/\s*,\s*UNIQUE\s*\(\s*guild_id\s*,\s*abbr\s*\)/i, '');
        db.exec(newSql);
        db.exec('INSERT INTO leagues_new SELECT * FROM leagues');
        db.exec('DROP TABLE leagues');
        db.exec('ALTER TABLE leagues_new RENAME TO leagues');
      }
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_leagues_active_abbr ON leagues(guild_id, abbr) WHERE active = 1'
      );
    })();

    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
      logger.error('Leagues rebuild left foreign-key violations', { violations });
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
  logger.info('Migrated leagues to active-only unique keyword');
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
    `ALTER TABLE leagues ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
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
