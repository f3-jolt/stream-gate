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
    SELECT l.*
    FROM leagues l
    JOIN user_leagues ul ON ul.league_id = l.id
    JOIN users u ON u.id = ul.user_id
    WHERE u.discord_id = ? AND l.guild_id = ?
  `).all(discordId, guildId);
}

// Returns [{ guildId, guildName, leagues: [...] }] — used by the router to route per-guild
function getUserLeaguesByGuild(discordId) {
  const rows = db.prepare(`
    SELECT l.*
    FROM leagues l
    JOIN user_leagues ul ON ul.league_id = l.id
    JOIN users u ON u.id = ul.user_id
    WHERE u.discord_id = ?
  `).all(discordId);

  const byGuild = new Map();
  for (const league of rows) {
    if (!byGuild.has(league.guild_id)) byGuild.set(league.guild_id, []);
    byGuild.get(league.guild_id).push(league);
  }

  return Array.from(byGuild.entries()).map(([guildId, leagues]) => ({ guildId, leagues }));
}

function addUserToLeague(discordId, leagueId, addedBy) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) throw new Error(`User ${discordId} not found`);

  return db.prepare(
    'INSERT OR IGNORE INTO user_leagues (user_id, league_id, added_by) VALUES (?, ?, ?)'
  ).run(user.id, leagueId, addedBy);
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

function getAllPlatformUsers(platform) {
  return db.prepare(`
    SELECT u.discord_id, up.platform_username, up.platform_user_id, up.subscription_id
    FROM user_platforms up
    JOIN users u ON u.id = up.user_id
    WHERE up.platform = ? AND u.active = 1
  `).all(platform);
}

// ── Leagues ───────────────────────────────────────────────────────────────────

function getAllLeagues(guildId) {
  return db.prepare('SELECT * FROM leagues WHERE guild_id = ? ORDER BY name').all(guildId);
}

function getLeagueByAbbr(guildId, abbr) {
  return db.prepare('SELECT * FROM leagues WHERE guild_id = ? AND abbr = ?').get(guildId, abbr.toUpperCase());
}

function getLeagueById(id) {
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

function addLeague(guildId, name, abbr, ppvChannelId, categoryId = null) {
  return db.prepare(
    'INSERT INTO leagues (guild_id, name, abbr, ppv_channel_id, category_id) VALUES (?, ?, ?, ?, ?)'
  ).run(guildId, name, abbr.toUpperCase(), ppvChannelId, categoryId);
}

function getUsersInLeague(leagueId) {
  return db.prepare(`
    SELECT u.discord_id, u.discord_username, up.platform, up.platform_username
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

function saveStreamPost(platform, platformStreamId, discordUserId, leagueId) {
  return db.prepare(
    'INSERT OR IGNORE INTO stream_posts (platform, platform_stream_id, discord_user_id, league_id) VALUES (?, ?, ?, ?)'
  ).run(platform, platformStreamId, discordUserId, leagueId);
}

// ── Pending routes ────────────────────────────────────────────────────────────

function savePendingRoute(discordUserId, guildId, platform, platformStreamId, streamUrl, streamTitle) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM pending_routes WHERE discord_user_id = ? AND guild_id = ?').run(discordUserId, guildId);
  return db.prepare(`
    INSERT INTO pending_routes (discord_user_id, guild_id, platform, platform_stream_id, stream_url, stream_title, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(discordUserId, guildId, platform, platformStreamId, streamUrl, streamTitle, expiresAt);
}

function getPendingRoute(discordUserId, guildId) {
  return db.prepare(
    'SELECT * FROM pending_routes WHERE discord_user_id = ? AND guild_id = ? AND expires_at > datetime("now")'
  ).get(discordUserId, guildId);
}

function clearPendingRoute(discordUserId, guildId) {
  return db.prepare('DELETE FROM pending_routes WHERE discord_user_id = ? AND guild_id = ?').run(discordUserId, guildId);
}

function clearExpiredPendingRoutes() {
  return db.prepare('DELETE FROM pending_routes WHERE expires_at <= datetime("now")').run();
}

// ── Health stats (per-guild) ──────────────────────────────────────────────────

function getHealthStats(guildId) {
  // Users registered in this guild (have at least one league here)
  const totalUsers = db.prepare(`
    SELECT COUNT(DISTINCT u.id) as count
    FROM users u
    JOIN user_leagues ul ON ul.user_id = u.id
    JOIN leagues l ON l.id = ul.league_id
    WHERE l.guild_id = ? AND u.active = 1
  `).get(guildId).count;

  const twitchSubs = db.prepare('SELECT COUNT(*) as count FROM user_platforms WHERE platform = "twitch" AND subscription_id IS NOT NULL').get().count;
  const twitchTotal = db.prepare('SELECT COUNT(*) as count FROM user_platforms WHERE platform = "twitch"').get().count;
  const youtubeSubs = db.prepare('SELECT COUNT(*) as count FROM user_platforms WHERE platform = "youtube" AND subscription_id IS NOT NULL').get().count;
  const youtubeTotal = db.prepare('SELECT COUNT(*) as count FROM user_platforms WHERE platform = "youtube"').get().count;

  const stuckRoutes = db.prepare(`
    SELECT COUNT(*) as count FROM pending_routes
    WHERE guild_id = ? AND created_at <= datetime('now', '-5 minutes') AND expires_at > datetime('now')
  `).get(guildId).count;

  return { totalUsers, twitchSubs, twitchTotal, youtubeSubs, youtubeTotal, stuckRoutes };
}

module.exports = {
  getGuildSettings,
  setGuildAdminRole,
  getOrCreateUser,
  getUserLeagues,
  getUserLeaguesByGuild,
  addUserToLeague,
  removeUserFromLeague,
  addUserPlatform,
  removeUserPlatform,
  getUserByPlatform,
  getUserPlatforms,
  updateSubscriptionId,
  getAllPlatformUsers,
  getAllLeagues,
  getLeagueByAbbr,
  getLeagueById,
  addLeague,
  getUsersInLeague,
  checkStreamPost,
  saveStreamPost,
  savePendingRoute,
  getPendingRoute,
  clearPendingRoute,
  clearExpiredPendingRoutes,
  getHealthStats,
};
