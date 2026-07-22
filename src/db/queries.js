const { db } = require('./database');

// ── Guild settings ────────────────────────────────────────────────────────────

function getGuildSettings(guildId) {
  return db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
}

function setGuildAdminRole(guildId, adminRoleId) {
  return db.prepare(`
    INSERT INTO guild_settings (guild_id, admin_role_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET admin_role_id = excluded.admin_role_id
  `).run(guildId, adminRoleId);
}

function setGuildTriggerKeyword(guildId, keyword) {
  return db.prepare(`
    INSERT INTO guild_settings (guild_id, trigger_keyword) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET trigger_keyword = excluded.trigger_keyword
  `).run(guildId, keyword.toUpperCase());
}

// ── Users ─────────────────────────────────────────────────────────────────────

function getOrCreateUser(discordId, discordUsername) {
  const existing = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
  if (existing) return existing;

  const result = db.prepare(
    'INSERT INTO users (discord_id, discord_username) VALUES (?, ?)'
  ).run(discordId, discordUsername);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function getUserLeagues(discordId, guildId) {
  return db.prepare(`
    SELECT l.*, ul.team_name, ul.team_abbrev
    FROM leagues l
    JOIN user_leagues ul ON ul.league_id = l.id
    JOIN users u ON u.id = ul.user_id
    WHERE u.discord_id = ? AND l.guild_id = ? AND l.active = 1
  `).all(discordId, guildId);
}

// Returns [{ guildId, guildName, leagues: [...] }] — used by the router to route per-guild
function getUserLeaguesByGuild(discordId) {
  const rows = db.prepare(`
    SELECT l.*, ul.team_name, ul.team_abbrev
    FROM leagues l
    JOIN user_leagues ul ON ul.league_id = l.id
    JOIN users u ON u.id = ul.user_id
    WHERE u.discord_id = ? AND l.active = 1
  `).all(discordId);

  const byGuild = new Map();
  for (const league of rows) {
    if (!byGuild.has(league.guild_id)) byGuild.set(league.guild_id, []);
    byGuild.get(league.guild_id).push(league);
  }

  return Array.from(byGuild.entries()).map(([guildId, leagues]) => ({ guildId, leagues }));
}

function addUserToLeague(discordId, leagueId, addedBy, teamName = null, teamAbbrev = null) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) throw new Error(`User ${discordId} not found`);

  return db.prepare(`
    INSERT INTO user_leagues (user_id, league_id, added_by, team_name, team_abbrev)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, league_id) DO UPDATE SET
      team_name = excluded.team_name,
      team_abbrev = excluded.team_abbrev
  `).run(user.id, leagueId, addedBy, teamName, teamAbbrev);
}

// Register a user into a league without touching an existing team assignment —
// used when a coach is added so they show up as a league member even before a
// team is picked.
function ensureUserInLeague(discordId, leagueId, addedBy) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) return;
  return db.prepare(`
    INSERT INTO user_leagues (user_id, league_id, added_by)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, league_id) DO NOTHING
  `).run(user.id, leagueId, addedBy);
}

function removeUserFromLeague(discordId, leagueId) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) return;

  return db.prepare(
    'DELETE FROM user_leagues WHERE user_id = ? AND league_id = ?'
  ).run(user.id, leagueId);
}

// ── Platforms ─────────────────────────────────────────────────────────────────

function addUserPlatform(discordId, platform, platformUsername, platformUserId) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) throw new Error(`User ${discordId} not found`);

  return db.prepare(`
    INSERT INTO user_platforms (user_id, platform, platform_username, platform_user_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(platform, platform_username) DO UPDATE SET
      user_id = excluded.user_id,
      platform_user_id = excluded.platform_user_id
  `).run(user.id, platform, platformUsername.toLowerCase(), platformUserId);
}

function removeUserPlatform(discordId, platform) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) return;

  return db.prepare(
    'DELETE FROM user_platforms WHERE user_id = ? AND platform = ?'
  ).run(user.id, platform);
}

function getUserByPlatform(platform, platformUsername) {
  return db.prepare(`
    SELECT u.*, up.platform_username, up.platform_user_id, up.subscription_id
    FROM users u
    JOIN user_platforms up ON up.user_id = u.id
    WHERE up.platform = ? AND up.platform_username = ? AND u.active = 1
  `).get(platform, platformUsername.toLowerCase());
}

function getUserPlatforms(discordId) {
  return db.prepare(`
    SELECT up.*
    FROM user_platforms up
    JOIN users u ON u.id = up.user_id
    WHERE u.discord_id = ?
  `).all(discordId);
}

function updateSubscriptionId(platform, platformUsername, subscriptionId) {
  return db.prepare(
    'UPDATE user_platforms SET subscription_id = ? WHERE platform = ? AND platform_username = ?'
  ).run(subscriptionId, platform, platformUsername.toLowerCase());
}

function updatePlatformUserId(platform, platformUsername, platformUserId) {
  return db.prepare(
    'UPDATE user_platforms SET platform_user_id = ? WHERE platform = ? AND platform_username = ?'
  ).run(platformUserId, platform, platformUsername.toLowerCase());
}

function getAllPlatformUsers(platform) {
  return db.prepare(`
    SELECT u.discord_id, u.discord_username, up.platform_username, up.platform_user_id, up.subscription_id
    FROM user_platforms up
    JOIN users u ON u.id = up.user_id
    WHERE up.platform = ? AND u.active = 1
  `).all(platform);
}

// ── Leagues ───────────────────────────────────────────────────────────────────

// Deactivated leagues are hidden from every consumer by default. Pass
// includeInactive only from admin surfaces that need to reactivate them.
function getAllLeagues(guildId, { includeInactive = false } = {}) {
  const activeClause = includeInactive ? '' : 'AND active = 1';
  return db.prepare(
    `SELECT * FROM leagues WHERE guild_id = ? ${activeClause} ORDER BY active DESC, name`
  ).all(guildId);
}

function getLeagueByAbbr(guildId, abbr, { includeInactive = false } = {}) {
  const activeClause = includeInactive ? '' : 'AND active = 1';
  return db.prepare(
    `SELECT * FROM leagues WHERE guild_id = ? AND abbr = ? ${activeClause}`
  ).get(guildId, abbr.toUpperCase());
}

function getLeagueById(id) {
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

function addLeague(guildId, name, abbr, ppvChannelId, categoryId = null, pingRoleId = null, advanceChannelId = null, userChannelId = null, scheduleUrl = null, staffRoleId = null) {
  return db.prepare(
    'INSERT INTO leagues (guild_id, name, abbr, ppv_channel_id, category_id, ping_role_id, advance_channel_id, user_channel_id, schedule_url, staff_role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(guildId, name, abbr.toUpperCase(), ppvChannelId, categoryId, pingRoleId, advanceChannelId, userChannelId, scheduleUrl, staffRoleId);
}

function updateLeague(leagueId, { pingRoleId, ppvChannelId, name, categoryId, advanceChannelId, userChannelId, scheduleUrl, staffRoleId, settingsChannelId, rosterChannelId } = {}) {
  if (pingRoleId !== undefined) {
    db.prepare('UPDATE leagues SET ping_role_id = ? WHERE id = ?').run(pingRoleId, leagueId);
  }
  if (ppvChannelId !== undefined) {
    db.prepare('UPDATE leagues SET ppv_channel_id = ? WHERE id = ?').run(ppvChannelId, leagueId);
  }
  if (name !== undefined) {
    db.prepare('UPDATE leagues SET name = ? WHERE id = ?').run(name, leagueId);
  }
  if (categoryId !== undefined) {
    db.prepare('UPDATE leagues SET category_id = ? WHERE id = ?').run(categoryId, leagueId);
  }
  if (advanceChannelId !== undefined) {
    db.prepare('UPDATE leagues SET advance_channel_id = ? WHERE id = ?').run(advanceChannelId, leagueId);
  }
  if (userChannelId !== undefined) {
    db.prepare('UPDATE leagues SET user_channel_id = ? WHERE id = ?').run(userChannelId, leagueId);
  }
  if (scheduleUrl !== undefined) {
    db.prepare('UPDATE leagues SET schedule_url = ? WHERE id = ?').run(scheduleUrl, leagueId);
  }
  if (staffRoleId !== undefined) {
    db.prepare('UPDATE leagues SET staff_role_id = ? WHERE id = ?').run(staffRoleId, leagueId);
  }
  if (settingsChannelId !== undefined) {
    db.prepare('UPDATE leagues SET settings_channel_id = ? WHERE id = ?').run(settingsChannelId, leagueId);
  }
  if (rosterChannelId !== undefined) {
    db.prepare('UPDATE leagues SET roster_channel_id = ? WHERE id = ?').run(rosterChannelId, leagueId);
  }
}

// Soft delete: membership, seasons, and stream history are all preserved so the
// league can be brought back intact.
function setLeagueActive(leagueId, active) {
  return db.prepare('UPDATE leagues SET active = ? WHERE id = ?').run(active ? 1 : 0, leagueId);
}

function setLeagueAdvanceTemplate(leagueId, template) {
  return db.prepare('UPDATE leagues SET advance_template = ? WHERE id = ?').run(template, leagueId);
}

// Gameplay settings overrides, stored as a JSON blob (see utils/leagueSettings).
// Returns the parsed override object ({} when unset or corrupt).
function getLeagueSettings(leagueId) {
  const row = db.prepare('SELECT settings FROM leagues WHERE id = ?').get(leagueId);
  if (!row || !row.settings) return {};
  try {
    const parsed = JSON.parse(row.settings);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function setLeagueSettings(leagueId, settings) {
  const json = settings && Object.keys(settings).length ? JSON.stringify(settings) : null;
  return db.prepare('UPDATE leagues SET settings = ? WHERE id = ?').run(json, leagueId);
}

// ── Settings post tracking (the canonical embed we edit in place) ──────────────

// Returns { league_id, channel_id, message_id, posted_settings (parsed), updated_at }
// or null when the league has never published.
function getSettingsPost(leagueId) {
  const row = db.prepare('SELECT * FROM league_settings_post WHERE league_id = ?').get(leagueId);
  if (!row) return null;
  let posted = {};
  try { posted = row.posted_settings ? JSON.parse(row.posted_settings) : {}; } catch { posted = {}; }
  return { ...row, posted_settings: posted };
}

// Insert or replace the canonical-message pointer + the snapshot it now shows.
function upsertSettingsPost(leagueId, channelId, messageId, postedSettings) {
  return db.prepare(`
    INSERT INTO league_settings_post (league_id, channel_id, message_id, posted_settings, updated_at)
    VALUES (@league_id, @channel_id, @message_id, @posted_settings, CURRENT_TIMESTAMP)
    ON CONFLICT(league_id) DO UPDATE SET
      channel_id      = excluded.channel_id,
      message_id      = excluded.message_id,
      posted_settings = excluded.posted_settings,
      updated_at      = CURRENT_TIMESTAMP
  `).run({
    league_id: leagueId,
    channel_id: channelId,
    message_id: messageId,
    posted_settings: postedSettings ? JSON.stringify(postedSettings) : null,
  });
}

function deleteSettingsPost(leagueId) {
  return db.prepare('DELETE FROM league_settings_post WHERE league_id = ?').run(leagueId);
}

// ── Season roster post tracking (one canonical embed per SEASON) ───────────────

// Returns { season_id, channel_id, message_ids (parsed array), posted_roster
// (parsed), updated_at } or null when this season has never been published.
// A null row is what makes a new season publish a new message instead of
// editing the previous season's.
function getRosterPost(seasonId) {
  const row = db.prepare('SELECT * FROM season_roster_post WHERE season_id = ?').get(seasonId);
  if (!row) return null;
  let posted = {};
  try { posted = row.posted_roster ? JSON.parse(row.posted_roster) : {}; } catch { posted = {}; }
  let ids = [];
  try { ids = row.message_ids ? JSON.parse(row.message_ids) : []; } catch { ids = []; }
  return { ...row, message_ids: Array.isArray(ids) ? ids : [], posted_roster: posted };
}

function upsertRosterPost(seasonId, channelId, messageIds, postedRoster) {
  return db.prepare(`
    INSERT INTO season_roster_post (season_id, channel_id, message_ids, posted_roster, updated_at)
    VALUES (@season_id, @channel_id, @message_ids, @posted_roster, CURRENT_TIMESTAMP)
    ON CONFLICT(season_id) DO UPDATE SET
      channel_id    = excluded.channel_id,
      message_ids   = excluded.message_ids,
      posted_roster = excluded.posted_roster,
      updated_at    = CURRENT_TIMESTAMP
  `).run({
    season_id: seasonId,
    channel_id: channelId,
    message_ids: JSON.stringify(messageIds),
    posted_roster: postedRoster ? JSON.stringify(postedRoster) : null,
  });
}

function deleteRosterPost(seasonId) {
  return db.prepare('DELETE FROM season_roster_post WHERE season_id = ?').run(seasonId);
}

// Drop pointers for seasons that no longer exist. SQLite reuses rowids after
// the highest row is deleted, so without this a newly created season could
// inherit a dead season's pointer and edit ITS post instead of publishing a
// fresh one — silently overwriting the older season's permanent record.
function pruneOrphanedRosterPosts() {
  return db.prepare(
    'DELETE FROM season_roster_post WHERE season_id NOT IN (SELECT id FROM seasons)'
  ).run();
}

function getUsersInLeague(leagueId) {
  return db.prepare(`
    SELECT u.discord_id, u.discord_username, ul.team_name, ul.team_abbrev,
           up.platform, up.platform_username
    FROM users u
    JOIN user_leagues ul ON ul.user_id = u.id
    LEFT JOIN user_platforms up ON up.user_id = u.id
    WHERE ul.league_id = ? AND u.active = 1
    ORDER BY u.discord_username
  `).all(leagueId);
}

// ── Stream dedup ──────────────────────────────────────────────────────────────

function checkStreamPost(platform, platformStreamId, leagueId) {
  return db.prepare(
    'SELECT id FROM stream_posts WHERE platform = ? AND platform_stream_id = ? AND league_id = ?'
  ).get(platform, platformStreamId, leagueId);
}

function checkRecentStreamPostByTitle(leagueId, title) {
  return db.prepare(`
    SELECT id FROM stream_posts
    WHERE league_id = ? AND stream_title = ? AND posted_at >= datetime('now', '-1 hour')
  `).get(leagueId, title);
}

function saveStreamPost(platform, platformStreamId, discordUserId, leagueId, streamTitle = null, discordMessageId = null, discordChannelId = null) {
  return db.prepare(
    'INSERT OR IGNORE INTO stream_posts (platform, platform_stream_id, discord_user_id, league_id, stream_title, discord_message_id, discord_channel_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(platform, platformStreamId, discordUserId, leagueId, streamTitle, discordMessageId, discordChannelId);
}

function getStreamPostMessageIds(leagueId) {
  return db.prepare(
    'SELECT discord_message_id, discord_channel_id FROM stream_posts WHERE league_id = ? AND discord_message_id IS NOT NULL'
  ).all(leagueId);
}

// ── Pending routes ────────────────────────────────────────────────────────────

function savePendingRoute(discordUserId, guildId, platform, platformStreamId, streamUrl, streamTitle, userName = null) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM pending_routes WHERE discord_user_id = ? AND guild_id = ?').run(discordUserId, guildId);
  return db.prepare(`
    INSERT INTO pending_routes (discord_user_id, guild_id, platform, platform_stream_id, stream_url, stream_title, user_name, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(discordUserId, guildId, platform, platformStreamId, streamUrl, streamTitle, userName, expiresAt);
}

function getPendingRoute(discordUserId, guildId) {
  return db.prepare(
    "SELECT * FROM pending_routes WHERE discord_user_id = ? AND guild_id = ? AND expires_at > datetime('now')"
  ).get(discordUserId, guildId);
}

function clearPendingRoute(discordUserId, guildId) {
  return db.prepare('DELETE FROM pending_routes WHERE discord_user_id = ? AND guild_id = ?').run(discordUserId, guildId);
}

function clearExpiredPendingRoutes() {
  return db.prepare("DELETE FROM pending_routes WHERE expires_at <= datetime('now')").run();
}

function updateUserPlatformUsername(discordId, platform, newUsername) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) throw new Error(`User ${discordId} not found`);
  return db.prepare(
    'UPDATE user_platforms SET platform_username = ?, platform_user_id = NULL, subscription_id = NULL WHERE user_id = ? AND platform = ?'
  ).run(newUsername.toLowerCase(), user.id, platform);
}

function getLastStreams(discordId, limit = 3) {
  return db.prepare(`
    SELECT sp.platform, sp.platform_stream_id, sp.stream_title, sp.posted_at,
           l.name AS league_name, l.abbr AS league_abbr
    FROM stream_posts sp
    JOIN leagues l ON l.id = sp.league_id
    WHERE sp.discord_user_id = ?
    ORDER BY sp.posted_at DESC
    LIMIT ?
  `).all(discordId, limit);
}

function getUserByDiscordUsername(username) {
  return db.prepare("SELECT * FROM users WHERE discord_username LIKE ?").get(`%${username}%`);
}

// ── Teams (unified NCAA + custom catalog) ─────────────────────────────────────

// Every team, active first-class flag included; custom teams surfaced first.
function getAllTeams() {
  return db.prepare('SELECT * FROM teams ORDER BY is_custom DESC, name').all();
}

function getTeamRow(abbrev) {
  return db.prepare('SELECT * FROM teams WHERE abbrev = ? COLLATE NOCASE').get(abbrev);
}

function addCustomTeam(name, abbrev, mascot, colors, logoBuffer) {
  return db.prepare(`
    INSERT INTO teams (name, abbrev, conference, mascot, colors, logo, is_custom, active)
    VALUES (?, ?, 'Custom', ?, ?, ?, 1, 1)
  `).run(name, abbrev.toUpperCase(), mascot || null, JSON.stringify(colors), logoBuffer || null);
}

// Generic team update, keyed by the team's current abbrev. Any subset of fields
// may be supplied; `colors` is an array, `logo` a Buffer (or null to clear).
function updateTeam(currentAbbrev, { name, abbrev, conference, mascot, colors, pic, logo, active } = {}) {
  const sets = [];
  const vals = [];
  if (name !== undefined)       { sets.push('name = ?');       vals.push(name); }
  if (abbrev !== undefined)     { sets.push('abbrev = ?');     vals.push(abbrev.toUpperCase()); }
  if (conference !== undefined) { sets.push('conference = ?'); vals.push(conference); }
  if (mascot !== undefined)     { sets.push('mascot = ?');     vals.push(mascot); }
  if (colors !== undefined)     { sets.push('colors = ?');     vals.push(JSON.stringify(colors)); }
  if (pic !== undefined)        { sets.push('pic = ?');        vals.push(pic); }
  if (logo !== undefined)       { sets.push('logo = ?');       vals.push(logo); }
  if (active !== undefined)     { sets.push('active = ?');     vals.push(active ? 1 : 0); }
  if (!sets.length) return;
  vals.push(currentAbbrev.toUpperCase());
  return db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE abbrev = ? COLLATE NOCASE`).run(...vals);
}

// Backwards-compatible alias for existing bot callers.
function updateCustomTeam(currentAbbrev, fields = {}) {
  return updateTeam(currentAbbrev, fields);
}

function setTeamActive(abbrev, active) {
  return db.prepare('UPDATE teams SET active = ? WHERE abbrev = ? COLLATE NOCASE').run(active ? 1 : 0, abbrev.toUpperCase());
}

// ── League channel lookups ────────────────────────────────────────────────────

function getLeagueByUserChannel(guildId, channelId) {
  return db.prepare(
    'SELECT * FROM leagues WHERE guild_id = ? AND user_channel_id = ? AND active = 1'
  ).get(guildId, channelId);
}

function getLeagueByPpvChannel(guildId, channelId) {
  return db.prepare(
    'SELECT * FROM leagues WHERE guild_id = ? AND ppv_channel_id = ? AND active = 1'
  ).get(guildId, channelId) || null;
}

function getAllLeaguesWithUserChannel() {
  return db.prepare(
    "SELECT * FROM leagues WHERE user_channel_id IS NOT NULL AND user_channel_id != '' AND active = 1"
  ).all();
}

function getAllLeaguesWithPpvChannel() {
  return db.prepare(
    "SELECT * FROM leagues WHERE ppv_channel_id IS NOT NULL AND ppv_channel_id != '' AND active = 1"
  ).all();
}

// ── Health stats (per-guild) ──────────────────────────────────────────────────

function getHealthStats(guildId) {
  // Users registered in this guild (have at least one league here)
  const totalUsers = db.prepare(`
    SELECT COUNT(DISTINCT u.id) as count
    FROM users u
    JOIN user_leagues ul ON ul.user_id = u.id
    JOIN leagues l ON l.id = ul.league_id
    WHERE l.guild_id = ? AND u.active = 1 AND l.active = 1
  `).get(guildId).count;

  const twitchSubs = db.prepare("SELECT COUNT(*) as count FROM user_platforms WHERE platform = 'twitch' AND subscription_id IS NOT NULL").get().count;
  const twitchTotal = db.prepare("SELECT COUNT(*) as count FROM user_platforms WHERE platform = 'twitch'").get().count;
  const youtubeSubs = db.prepare("SELECT COUNT(*) as count FROM user_platforms WHERE platform = 'youtube' AND subscription_id IS NOT NULL").get().count;
  const youtubeTotal = db.prepare("SELECT COUNT(*) as count FROM user_platforms WHERE platform = 'youtube'").get().count;

  const stuckRoutes = db.prepare(`
    SELECT COUNT(*) as count FROM pending_routes
    WHERE guild_id = ? AND created_at <= datetime('now', '-5 minutes') AND expires_at > datetime('now')
  `).get(guildId).count;

  return { totalUsers, twitchSubs, twitchTotal, youtubeSubs, youtubeTotal, stuckRoutes };
}

// ── Dynasty: seasons ──────────────────────────────────────────────────────────

function createSeason(leagueId, year, label = null) {
  // Clear dead pointers before we mint an id, so a reused rowid can't inherit a
  // deleted season's Discord roster post. See pruneOrphanedRosterPosts.
  pruneOrphanedRosterPosts();
  const result = db.prepare(
    'INSERT INTO seasons (league_id, year, label) VALUES (?, ?, ?)'
  ).run(leagueId, year, label);
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(result.lastInsertRowid);
  // First season for a league becomes the current one automatically.
  const count = db.prepare('SELECT COUNT(*) AS c FROM seasons WHERE league_id = ?').get(leagueId).c;
  if (count === 1) db.prepare('UPDATE seasons SET is_current = 1 WHERE id = ?').run(season.id);
  return db.prepare('SELECT * FROM seasons WHERE id = ?').get(season.id);
}

function getSeasonsByLeague(leagueId) {
  return db.prepare('SELECT * FROM seasons WHERE league_id = ? ORDER BY year DESC').all(leagueId);
}

// Copy a season's setup (team roster + conferences and coach assignments) into
// another season. Schedule and results (games) are intentionally NOT copied —
// the new season starts fresh. Returns how many rows of each were carried over.
const cloneSeasonData = db.transaction((fromSeasonId, toSeasonId) => {
  const teams = db.prepare(`
    INSERT OR IGNORE INTO season_teams (season_id, team_abbrev, conference_id)
    SELECT ?, team_abbrev, conference_id FROM season_teams WHERE season_id = ?
  `).run(toSeasonId, fromSeasonId);
  const assignments = db.prepare(`
    INSERT OR IGNORE INTO coach_team_assignments (season_id, coach_id, team_abbrev)
    SELECT ?, coach_id, team_abbrev FROM coach_team_assignments WHERE season_id = ?
  `).run(toSeasonId, fromSeasonId);
  return { teams: teams.changes, assignments: assignments.changes };
});

function getSeasonById(seasonId) {
  return db.prepare('SELECT * FROM seasons WHERE id = ?').get(seasonId);
}

function getCurrentSeason(leagueId) {
  return db.prepare('SELECT * FROM seasons WHERE league_id = ? AND is_current = 1').get(leagueId);
}

function getSeasonByYear(leagueId, year) {
  return db.prepare('SELECT * FROM seasons WHERE league_id = ? AND year = ?').get(leagueId, year);
}

const setCurrentSeason = db.transaction((leagueId, seasonId) => {
  db.prepare('UPDATE seasons SET is_current = 0 WHERE league_id = ?').run(leagueId);
  db.prepare('UPDATE seasons SET is_current = 1 WHERE id = ? AND league_id = ?').run(seasonId, leagueId);
});

// ── Dynasty: conferences ──────────────────────────────────────────────────────

function upsertConference(leagueId, name, abbrev = null) {
  db.prepare(`
    INSERT INTO conferences (league_id, name, abbrev) VALUES (?, ?, ?)
    ON CONFLICT(league_id, name) DO UPDATE SET abbrev = excluded.abbrev
  `).run(leagueId, name, abbrev);
  return db.prepare('SELECT * FROM conferences WHERE league_id = ? AND name = ?').get(leagueId, name);
}

function getConferences(leagueId) {
  return db.prepare('SELECT * FROM conferences WHERE league_id = ? ORDER BY name').all(leagueId);
}

// ── Dynasty: season teams ─────────────────────────────────────────────────────

function upsertSeasonTeam(seasonId, teamAbbrev, conferenceId = null) {
  return db.prepare(`
    INSERT INTO season_teams (season_id, team_abbrev, conference_id) VALUES (?, ?, ?)
    ON CONFLICT(season_id, team_abbrev) DO UPDATE SET conference_id = excluded.conference_id
  `).run(seasonId, teamAbbrev.toUpperCase(), conferenceId);
}

function getSeasonTeams(seasonId) {
  return db.prepare(`
    SELECT st.team_abbrev, st.conference_id, c.name AS conference_name,
           cta.coach_id, co.display_name AS coach_name, u.discord_id AS coach_discord_id
    FROM season_teams st
    LEFT JOIN conferences c ON c.id = st.conference_id
    LEFT JOIN coach_team_assignments cta ON cta.season_id = st.season_id AND cta.team_abbrev = st.team_abbrev
    LEFT JOIN coaches co ON co.id = cta.coach_id
    LEFT JOIN users u ON u.id = co.user_id
    WHERE st.season_id = ?
    ORDER BY st.team_abbrev
  `).all(seasonId);
}

function getSeasonTeam(seasonId, teamAbbrev) {
  return db.prepare(
    'SELECT * FROM season_teams WHERE season_id = ? AND team_abbrev = ?'
  ).get(seasonId, teamAbbrev.toUpperCase());
}

function removeSeasonTeam(seasonId, teamAbbrev) {
  return db.prepare(
    'DELETE FROM season_teams WHERE season_id = ? AND team_abbrev = ?'
  ).run(seasonId, teamAbbrev.toUpperCase());
}

// ── Dynasty: coaches ──────────────────────────────────────────────────────────

function getOrCreateCoach(leagueId, userId, displayName) {
  if (userId != null) {
    const existing = db.prepare('SELECT * FROM coaches WHERE league_id = ? AND user_id = ?').get(leagueId, userId);
    if (existing) return existing;
  } else {
    const existing = db.prepare(
      'SELECT * FROM coaches WHERE league_id = ? AND user_id IS NULL AND display_name = ?'
    ).get(leagueId, displayName);
    if (existing) return existing;
  }
  const result = db.prepare(
    'INSERT INTO coaches (league_id, user_id, display_name) VALUES (?, ?, ?)'
  ).run(leagueId, userId, displayName);
  return db.prepare('SELECT * FROM coaches WHERE id = ?').get(result.lastInsertRowid);
}

function getCoachesByLeague(leagueId) {
  return db.prepare(`
    SELECT co.*, u.discord_id, u.discord_username,
           (SELECT COUNT(*) FROM user_platforms up WHERE up.user_id = co.user_id) AS platform_count,
           (SELECT GROUP_CONCAT(up.platform || ': ' || up.platform_username, ', ')
              FROM user_platforms up WHERE up.user_id = co.user_id) AS platforms
    FROM coaches co
    LEFT JOIN users u ON u.id = co.user_id
    WHERE co.league_id = ?
    ORDER BY co.display_name
  `).all(leagueId);
}

function getCoachById(coachId) {
  return db.prepare(`
    SELECT co.*, u.discord_id, u.discord_username
    FROM coaches co LEFT JOIN users u ON u.id = co.user_id
    WHERE co.id = ?
  `).get(coachId);
}

function getCoachByUser(leagueId, userId) {
  return db.prepare('SELECT * FROM coaches WHERE league_id = ? AND user_id = ?').get(leagueId, userId);
}

// ── Dynasty: assignments (coach ↔ team ↔ season) ──────────────────────────────

function getAssignmentCoachId(seasonId, teamAbbrev) {
  const row = db.prepare(
    'SELECT coach_id FROM coach_team_assignments WHERE season_id = ? AND team_abbrev = ?'
  ).get(seasonId, teamAbbrev.toUpperCase());
  return row ? row.coach_id : null;
}

// Assign (or hand over) a team to a coach for a season. Re-snapshots the coach
// onto that team's UNPLAYED games (played games keep their prior coach), and —
// only on this explicit action — syncs the coach's stream-registration team.
const assignCoachTeam = db.transaction((seasonId, coachId, teamAbbrev, teamName = null) => {
  const abbr = teamAbbrev.toUpperCase();

  // A coach holds at most one team per season. Clear any prior assignment to a
  // different team so "change team" moves the coach instead of leaving a stale
  // duplicate (which made the old team keep showing). Detach the coach from the
  // vacated team's unplayed games so its is_user flags recompute.
  const prior = db.prepare(
    'SELECT team_abbrev FROM coach_team_assignments WHERE season_id = ? AND coach_id = ? AND team_abbrev != ?'
  ).all(seasonId, coachId, abbr);
  for (const { team_abbrev: old } of prior) {
    db.prepare('DELETE FROM coach_team_assignments WHERE season_id = ? AND coach_id = ? AND team_abbrev = ?')
      .run(seasonId, coachId, old);
    db.prepare('UPDATE games SET home_coach_id = NULL WHERE season_id = ? AND home_abbrev = ? AND home_coach_id = ? AND played_at IS NULL')
      .run(seasonId, old, coachId);
    db.prepare('UPDATE games SET away_coach_id = NULL WHERE season_id = ? AND away_abbrev = ? AND away_coach_id = ? AND played_at IS NULL')
      .run(seasonId, old, coachId);
    db.prepare(`
      UPDATE games SET is_user_game = (home_coach_id IS NOT NULL AND away_coach_id IS NOT NULL)
      WHERE season_id = ? AND played_at IS NULL AND (home_abbrev = ? OR away_abbrev = ?)
    `).run(seasonId, old, old);
  }

  db.prepare(`
    INSERT INTO coach_team_assignments (season_id, coach_id, team_abbrev) VALUES (?, ?, ?)
    ON CONFLICT(season_id, team_abbrev) DO UPDATE SET coach_id = excluded.coach_id
  `).run(seasonId, coachId, abbr);

  // Re-snapshot unplayed games for this team, then recompute is_user_game.
  db.prepare('UPDATE games SET home_coach_id = ? WHERE season_id = ? AND home_abbrev = ? AND played_at IS NULL')
    .run(coachId, seasonId, abbr);
  db.prepare('UPDATE games SET away_coach_id = ? WHERE season_id = ? AND away_abbrev = ? AND played_at IS NULL')
    .run(coachId, seasonId, abbr);
  db.prepare(`
    UPDATE games SET is_user_game = (home_coach_id IS NOT NULL AND away_coach_id IS NOT NULL)
    WHERE season_id = ? AND played_at IS NULL AND (home_abbrev = ? OR away_abbrev = ?)
  `).run(seasonId, abbr, abbr);

  // Explicit-assign sync to stream registration (user_leagues).
  const coach = db.prepare('SELECT co.user_id, u.discord_id FROM coaches co LEFT JOIN users u ON u.id = co.user_id WHERE co.id = ?').get(coachId);
  const season = db.prepare('SELECT league_id FROM seasons WHERE id = ?').get(seasonId);
  if (coach && coach.user_id && coach.discord_id && season) {
    db.prepare(`
      INSERT INTO user_leagues (user_id, league_id, added_by, team_name, team_abbrev)
      VALUES (?, ?, 'dynasty-assign', ?, ?)
      ON CONFLICT(user_id, league_id) DO UPDATE SET
        team_name = excluded.team_name,
        team_abbrev = excluded.team_abbrev
    `).run(coach.user_id, season.league_id, teamName, abbr);
  }
});

function getSeasonAssignments(seasonId) {
  return db.prepare(`
    SELECT cta.team_abbrev, cta.coach_id, co.display_name AS coach_name, u.discord_id AS coach_discord_id
    FROM coach_team_assignments cta
    JOIN coaches co ON co.id = cta.coach_id
    LEFT JOIN users u ON u.id = co.user_id
    WHERE cta.season_id = ?
  `).all(seasonId);
}

function getCoachAssignment(seasonId, coachId) {
  return db.prepare(
    'SELECT * FROM coach_team_assignments WHERE season_id = ? AND coach_id = ?'
  ).all(seasonId, coachId);
}

// ── Dynasty: games (schedule + results) ───────────────────────────────────────

// isUserGame: pass null to auto-derive (both teams currently coached); pass a
// boolean/0/1 to set it explicitly (manual toggle from the schedule builder).
function insertGame(seasonId, week, homeAbbrev, awayAbbrev, isPostseason = 0, isUserGame = null) {
  const home = homeAbbrev.toUpperCase();
  const away = awayAbbrev.toUpperCase();
  const homeCoach = getAssignmentCoachId(seasonId, home);
  const awayCoach = getAssignmentCoachId(seasonId, away);
  const userGame = isUserGame == null
    ? (homeCoach != null && awayCoach != null ? 1 : 0)
    : (isUserGame ? 1 : 0);
  return db.prepare(`
    INSERT INTO games (season_id, week, home_abbrev, away_abbrev, is_user_game, is_postseason, home_coach_id, away_coach_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season_id, week, home_abbrev, away_abbrev) DO NOTHING
  `).run(seasonId, week, home, away, userGame, isPostseason ? 1 : 0, homeCoach, awayCoach);
}

// Team-centric schedule: one row per regular-season week for a team, showing the
// opponent (from the single shared game row) and whether the team is home.
function getTeamSchedule(seasonId, teamAbbrev) {
  const t = teamAbbrev.toUpperCase();
  return db.prepare(`
    SELECT g.id, g.week, g.is_user_game, g.is_postseason, g.played_at, g.result_type,
           g.home_score, g.away_score,
           CASE WHEN g.home_abbrev = @t THEN 1 ELSE 0 END AS is_home,
           CASE WHEN g.home_abbrev = @t THEN g.away_abbrev ELSE g.home_abbrev END AS opponent_abbrev
    FROM games g
    WHERE g.season_id = @seasonId AND (g.home_abbrev = @t OR g.away_abbrev = @t)
    ORDER BY g.week
  `).all({ seasonId, t });
}

// ── Scheduling-rule helpers ──
function _deleteTeamWeek(seasonId, week, abbrev) {
  db.prepare('DELETE FROM games WHERE season_id = ? AND week = ? AND (home_abbrev = ? OR away_abbrev = ?)')
    .run(seasonId, week, abbrev, abbrev);
}
function _isWeekBusy(seasonId, week, abbrev) {
  return !!db.prepare('SELECT 1 FROM games WHERE season_id = ? AND week = ? AND (home_abbrev = ? OR away_abbrev = ?)')
    .get(seasonId, week, abbrev, abbrev);
}

// "FCS" is a generic non-user placeholder opponent that many teams schedule, so
// it's the one team exempt from the double-booking rule — it may appear in
// multiple games in the same week.
const GENERIC_OPPONENT = 'FCS';

// Enforces the hard scheduling rules (after clearing the subject's own game that
// week): 1) a team can't play itself, and 2) an opponent can't already be booked
// in another game that same week (the generic opponent is exempt). Regular-season
// rematches (the same two teams scheduled twice) are NOT blocked here — they're
// allowed but surfaced as a warning in the schedule builder so a deliberate
// double-up can be saved without slipping through unnoticed.
function _placeGame(seasonId, week, T, opponentAbbrev, isHome, isUserGame) {
  if (!opponentAbbrev) return; // BYE
  const opp = opponentAbbrev.toUpperCase();
  if (opp === T) throw new Error('A team cannot play itself.');
  if (opp !== GENERIC_OPPONENT && _isWeekBusy(seasonId, week, opp)) {
    throw new Error(`${opp} is already scheduled in week ${week}.`);
  }
  const home = isHome ? T : opp;
  const away = isHome ? opp : T;
  insertGame(seasonId, week, home, away, week >= 15 ? 1 : 0, isUserGame);
}

// Set (or clear) a single team's game for one week, enforcing the scheduling rules.
const setTeamWeekGame = db.transaction((seasonId, week, teamAbbrev, { opponentAbbrev, isHome = true, isUserGame = null }) => {
  const T = teamAbbrev.toUpperCase();
  _deleteTeamWeek(seasonId, week, T);
  _placeGame(seasonId, week, T, opponentAbbrev || null, isHome, isUserGame);
});

const bulkSetTeamSchedule = db.transaction((seasonId, teamAbbrev, weeks) => {
  const T = teamAbbrev.toUpperCase();
  // Clear all of T's games for the weeks being saved FIRST, so re-inserting
  // doesn't trip the rematch/busy checks on T's own prior games.
  for (const w of weeks) _deleteTeamWeek(seasonId, w.week, T);
  for (const w of weeks) {
    _placeGame(seasonId, w.week, T, (w.opponent || null), w.isHome, w.isUserGame);
  }
});

const bulkInsertGames = db.transaction((seasonId, rows) => {
  for (const r of rows) {
    insertGame(seasonId, r.week, r.homeAbbrev, r.awayAbbrev, r.isPostseason ? 1 : 0);
  }
});

const GAME_JOINS = `
  LEFT JOIN coaches hc ON hc.id = g.home_coach_id
  LEFT JOIN users hu ON hu.id = hc.user_id
  LEFT JOIN coaches ac ON ac.id = g.away_coach_id
  LEFT JOIN users au ON au.id = ac.user_id
`;
const GAME_COLS = `
  g.*,
  hc.display_name AS home_coach_name, hu.discord_id AS home_discord_id,
  ac.display_name AS away_coach_name, au.discord_id AS away_discord_id
`;

function getGamesByWeek(seasonId, week) {
  return db.prepare(`
    SELECT ${GAME_COLS} FROM games g ${GAME_JOINS}
    WHERE g.season_id = ? AND g.week = ? ORDER BY g.id
  `).all(seasonId, week);
}

function getScheduledGames(seasonId, { week = null, unplayedOnly = false } = {}) {
  const clauses = ['g.season_id = ?'];
  const params = [seasonId];
  if (week != null) { clauses.push('g.week = ?'); params.push(week); }
  if (unplayedOnly) clauses.push("g.played_at IS NULL");
  return db.prepare(`
    SELECT ${GAME_COLS} FROM games g ${GAME_JOINS}
    WHERE ${clauses.join(' AND ')} ORDER BY g.week, g.id
  `).all(...params);
}

function getGameById(gameId) {
  return db.prepare(`SELECT ${GAME_COLS} FROM games g ${GAME_JOINS} WHERE g.id = ?`).get(gameId);
}

function deleteGame(gameId) {
  return db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
}

// Shared by the web portal and the Discord /results command. Re-snapshots the
// current controllers (the coaches who actually played) and marks the game played.
const recordGameResult = db.transaction((gameId, { homeScore = null, awayScore = null, attemptsTaken = null, resultType = 'normal', winnerSide = null }) => {
  const g = db.prepare('SELECT season_id, home_abbrev, away_abbrev FROM games WHERE id = ?').get(gameId);
  if (!g) throw new Error(`Game ${gameId} not found`);
  // Snapshot the coaches who actually played, but leave is_user_game alone — it's
  // a manual flag set in the schedule builder.
  const homeCoach = getAssignmentCoachId(g.season_id, g.home_abbrev);
  const awayCoach = getAssignmentCoachId(g.season_id, g.away_abbrev);
  // Only a forfeit (FR) carries a forced winner. Normal and fair-sim (FS) derive
  // the winner from the score, so winner_side stays null for them.
  const ws = resultType === 'FR' ? winnerSide : null;
  return db.prepare(`
    UPDATE games SET
      home_score = ?, away_score = ?, attempts_taken = ?,
      result_type = ?, winner_side = ?,
      home_coach_id = ?, away_coach_id = ?,
      played_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(homeScore, awayScore, attemptsTaken, resultType, ws, homeCoach, awayCoach, gameId);
});

// ── Dynasty: derived summaries (W/L never stored — computed here) ──────────────
// A game counts once it's resolved: a forfeit/fair-sim with a winner, or a
// normal game with both scores. winner is winner_side for FR/FS, else by score.

// Resolved = a forfeit with a forced winner, or any game with both scores
// (normal and fair-sim are decided by the score).
const PLAYED_FILTER = "((g.result_type = 'FR' AND g.winner_side IS NOT NULL) OR (g.home_score IS NOT NULL AND g.away_score IS NOT NULL))";

// Per-side (one row per team per resolved game). `meSide` is 'home' | 'away'.
// Only FR uses winner_side; normal and FS compare scores.
function sideSelect(meSide) {
  const me = meSide === 'home' ? 'home' : 'away';
  const opp = meSide === 'home' ? 'away' : 'home';
  return `
    SELECT g.season_id AS season_id, g.week AS week,
      g.${me}_abbrev AS team, g.${me}_coach_id AS coach_id,
      COALESCE(g.${me}_score, 0) AS pf, COALESCE(g.${opp}_score, 0) AS pa,
      CASE WHEN g.result_type = 'FR' THEN (CASE WHEN g.winner_side = '${me}' THEN 1 ELSE 0 END)
           WHEN g.${me}_score > g.${opp}_score THEN 1 ELSE 0 END AS won,
      CASE WHEN g.result_type = 'FR' THEN (CASE WHEN g.winner_side = '${opp}' THEN 1 ELSE 0 END)
           WHEN g.${opp}_score > g.${me}_score THEN 1 ELSE 0 END AS lost,
      CASE WHEN g.result_type != 'FR' AND g.${me}_score = g.${opp}_score THEN 1 ELSE 0 END AS tied
    FROM games g WHERE __SCOPE__ AND ${PLAYED_FILTER}
  `;
}

function sidesCTE(scope) {
  return `WITH sides AS (
    ${sideSelect('home').replace('__SCOPE__', scope)}
    UNION ALL
    ${sideSelect('away').replace('__SCOPE__', scope)}
  )`;
}

function getSeasonSummary(seasonId) {
  return db.prepare(`
    ${sidesCTE('g.season_id = @seasonId')}
    SELECT s.team AS team_abbrev,
      SUM(s.won) AS wins, SUM(s.lost) AS losses, SUM(s.tied) AS ties,
      SUM(s.pf) AS points_for, SUM(s.pa) AS points_against,
      SUM(s.pf) - SUM(s.pa) AS point_diff, COUNT(*) AS games_played,
      c.name AS conference_name
    FROM sides s
    LEFT JOIN season_teams st ON st.season_id = @seasonId AND st.team_abbrev = s.team
    LEFT JOIN conferences c ON c.id = st.conference_id
    GROUP BY s.team
    ORDER BY wins DESC, point_diff DESC
  `).all({ seasonId });
}

function getCoachHistory(leagueId) {
  return db.prepare(`
    ${sidesCTE('g.season_id IN (SELECT id FROM seasons WHERE league_id = @leagueId)')}
    SELECT co.id AS coach_id, co.display_name, co.user_id, u.discord_id,
      SUM(s.won) AS wins, SUM(s.lost) AS losses, SUM(s.tied) AS ties,
      SUM(s.pf) AS points_for, SUM(s.pa) AS points_against,
      COUNT(*) AS games_played,
      COUNT(DISTINCT s.season_id) AS seasons_count,
      COUNT(DISTINCT s.team) AS teams_count,
      SUM(CASE WHEN s.week = 19 AND s.won = 1 THEN 1 ELSE 0 END) AS natl_titles,
      SUM(CASE WHEN s.week = 15 AND s.won = 1 THEN 1 ELSE 0 END) AS conf_titles
    FROM sides s
    JOIN coaches co ON co.id = s.coach_id
    LEFT JOIN users u ON u.id = co.user_id
    GROUP BY co.id
    ORDER BY wins DESC
  `).all({ leagueId });
}

function getCoachSeasonBreakdown(coachId) {
  return db.prepare(`
    ${sidesCTE('(g.home_coach_id = @coachId OR g.away_coach_id = @coachId)')}
    SELECT se.id AS season_id, se.year, se.label,
      GROUP_CONCAT(DISTINCT s.team) AS teams,
      SUM(s.won) AS wins, SUM(s.lost) AS losses, SUM(s.tied) AS ties,
      SUM(s.pf) AS points_for, SUM(s.pa) AS points_against
    FROM sides s
    JOIN seasons se ON se.id = s.season_id
    WHERE s.coach_id = @coachId
    GROUP BY se.id
    ORDER BY se.year DESC
  `).all({ coachId });
}

module.exports = {
  getGuildSettings,
  setGuildAdminRole,
  setGuildTriggerKeyword,
  getOrCreateUser,
  getUserLeagues,
  getUserLeaguesByGuild,
  addUserToLeague,
  ensureUserInLeague,
  removeUserFromLeague,
  addUserPlatform,
  removeUserPlatform,
  getUserByPlatform,
  getUserPlatforms,
  updateSubscriptionId,
  updatePlatformUserId,
  getAllPlatformUsers,
  getAllLeagues,
  getLeagueByAbbr,
  getLeagueById,
  addLeague,
  updateLeague,
  setLeagueActive,
  setLeagueAdvanceTemplate,
  getLeagueSettings,
  setLeagueSettings,
  getSettingsPost,
  upsertSettingsPost,
  deleteSettingsPost,
  getRosterPost,
  upsertRosterPost,
  deleteRosterPost,
  pruneOrphanedRosterPosts,
  getUsersInLeague,
  updateUserPlatformUsername,
  getLastStreams,
  getUserByDiscordUsername,
  checkStreamPost,
  checkRecentStreamPostByTitle,
  saveStreamPost,
  getStreamPostMessageIds,
  savePendingRoute,
  getPendingRoute,
  clearPendingRoute,
  clearExpiredPendingRoutes,
  getHealthStats,
  addCustomTeam,
  updateCustomTeam,
  updateTeam,
  getAllTeams,
  getTeamRow,
  setTeamActive,
  getLeagueByUserChannel,
  getLeagueByPpvChannel,
  getAllLeaguesWithUserChannel,
  getAllLeaguesWithPpvChannel,
  // Dynasty: seasons
  createSeason,
  cloneSeasonData,
  getSeasonsByLeague,
  getSeasonById,
  getCurrentSeason,
  getSeasonByYear,
  setCurrentSeason,
  // Dynasty: conferences
  upsertConference,
  getConferences,
  // Dynasty: season teams
  upsertSeasonTeam,
  getSeasonTeams,
  getSeasonTeam,
  removeSeasonTeam,
  // Dynasty: coaches
  getOrCreateCoach,
  getCoachesByLeague,
  getCoachById,
  getCoachByUser,
  // Dynasty: assignments
  getAssignmentCoachId,
  assignCoachTeam,
  getSeasonAssignments,
  getCoachAssignment,
  // Dynasty: games
  insertGame,
  bulkInsertGames,
  getTeamSchedule,
  setTeamWeekGame,
  bulkSetTeamSchedule,
  getGamesByWeek,
  getScheduledGames,
  getGameById,
  deleteGame,
  recordGameResult,
  // Dynasty: derived summaries
  getSeasonSummary,
  getCoachHistory,
  getCoachSeasonBreakdown,
};
