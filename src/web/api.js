'use strict';

const express = require('express');
const axios = require('axios');
const { ChannelType } = require('discord.js');
const { db } = require('../db/database');
const {
  getAllLeagues,
  getLeagueById,
  getLeagueByAbbr,
  addLeague,
  updateLeague,
  setLeagueActive,
  getHealthStats,
  getOrCreateUser,
  addUserPlatform,
  removeUserPlatform,
  getUserPlatforms,
  updateUserPlatformUsername,
  addUserToLeague,
  ensureUserInLeague,
  removeUserFromLeague,
  getUsersInLeague,
  setLeagueAdvanceTemplate,
  getLeagueSettings,
  setLeagueSettings,
  getSettingsPost,
  getRosterPost,
  // Dynasty
  createSeason,
  cloneSeasonData,
  getSeasonsByLeague,
  getSeasonById,
  getCurrentSeason,
  setCurrentSeason,
  getConferences,
  upsertConference,
  getSeasonTeams,
  getSeasonTeam,
  upsertSeasonTeam,
  removeSeasonTeam,
  getCoachesByLeague,
  getOrCreateCoach,
  getSeasonAssignments,
  assignCoachTeam,
  getGamesByWeek,
  getScheduledGames,
  bulkInsertGames,
  getTeamSchedule,
  bulkSetTeamSchedule,
  deleteGame,
  getGameById,
  recordGameResult,
  getSeasonSummary,
  getCoachHistory,
  getCoachById,
  getCoachSeasonBreakdown,
  getAllTeams,
  getTeamRow,
  addCustomTeam,
  updateTeam,
  setTeamActive,
} = require('../db/queries');
const { requireAuth, requireGuildAccess } = require('./middleware');
const { parseScheduleCell, parseMatchups, WEEK_LABELS, applyDateOverride } = require('../utils/schedule');
const { buildDbAdvanceMessage } = require('../utils/advance');
const { searchTeams, getTeamByAbbrev } = require('../utils/teams');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/guilds ───────────────────────────────────────────────────────────

router.get('/guilds', (req, res) => {
  res.json(req.session.user.authorizedGuilds);
});

// ── Guild-scoped routes ───────────────────────────────────────────────────────

router.get('/guilds/:guildId/leagues', requireGuildAccess, (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  res.json(getAllLeagues(req.params.guildId, { includeInactive }));
});

// ── League CRUD ───────────────────────────────────────────────────────────────

// Discord snowflakes arrive as strings from the portal's text inputs. Empty
// means "not set", which is a null column rather than an empty string.
function snowflake(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (!/^\d{5,25}$/.test(trimmed)) throw new Error(`"${trimmed}" is not a valid Discord ID`);
  return trimmed;
}

router.post('/guilds/:guildId/leagues', requireGuildAccess, (req, res) => {
  const { guildId } = req.params;
  const name = String(req.body.name ?? '').trim();
  const abbr = String(req.body.abbr ?? '').trim().toUpperCase();

  if (!name || !abbr) {
    return res.status(400).json({ error: 'Name and keyword are required' });
  }
  if (!/^[A-Z0-9]{1,16}$/.test(abbr)) {
    return res.status(400).json({ error: 'Keyword must be 1-16 letters or digits' });
  }

  // A keyword only needs to be unique among ACTIVE leagues. A deactivated
  // league sharing the keyword is fine — the new active one takes over routing.
  const existingActive = getLeagueByAbbr(guildId, abbr);
  if (existingActive) {
    return res.status(409).json({ error: `A league with keyword ${abbr} already exists.` });
  }

  let ids;
  try {
    ids = {
      ppvChannelId: snowflake(req.body.ppvChannelId),
      categoryId: snowflake(req.body.categoryId),
      pingRoleId: snowflake(req.body.pingRoleId),
      advanceChannelId: snowflake(req.body.advanceChannelId),
      userChannelId: snowflake(req.body.userChannelId),
      staffRoleId: snowflake(req.body.staffRoleId),
      settingsChannelId: snowflake(req.body.settingsChannelId),
      rosterChannelId: snowflake(req.body.rosterChannelId),
    };
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!ids.ppvChannelId) {
    return res.status(400).json({ error: 'PPV channel ID is required' });
  }

  const scheduleUrl = String(req.body.scheduleUrl ?? '').trim() || null;

  try {
    const result = addLeague(
      guildId, name, abbr, ids.ppvChannelId, ids.categoryId, ids.pingRoleId,
      ids.advanceChannelId, ids.userChannelId, scheduleUrl, ids.staffRoleId,
    );
    // These aren't in addLeague's positional signature — set them after.
    if (ids.settingsChannelId || ids.rosterChannelId) {
      updateLeague(Number(result.lastInsertRowid), {
        settingsChannelId: ids.settingsChannelId,
        rosterChannelId: ids.rosterChannelId,
      });
    }
    logger.info('Web portal created league', { adminId: req.session.user.id, guildId, name, abbr });
    res.json({ ok: true, league: getLeagueById(Number(result.lastInsertRowid)) });
  } catch (err) {
    logger.error('Web portal create league failed', { error: err.message, guildId, abbr });
    res.status(500).json({ error: err.message });
  }
});

router.put('/guilds/:guildId/leagues/:leagueId', requireGuildAccess, (req, res) => {
  const { guildId, leagueId } = req.params;
  const league = leagueInGuild(leagueId, guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });

  const name = String(req.body.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  let updates;
  try {
    updates = {
      name,
      ppvChannelId: snowflake(req.body.ppvChannelId),
      categoryId: snowflake(req.body.categoryId),
      pingRoleId: snowflake(req.body.pingRoleId),
      advanceChannelId: snowflake(req.body.advanceChannelId),
      userChannelId: snowflake(req.body.userChannelId),
      staffRoleId: snowflake(req.body.staffRoleId),
      settingsChannelId: snowflake(req.body.settingsChannelId),
      rosterChannelId: snowflake(req.body.rosterChannelId),
      scheduleUrl: String(req.body.scheduleUrl ?? '').trim() || null,
    };
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!updates.ppvChannelId) {
    return res.status(400).json({ error: 'PPV channel ID is required' });
  }

  try {
    updateLeague(league.id, updates);
    logger.info('Web portal updated league', { adminId: req.session.user.id, guildId, leagueId: league.id });
    res.json({ ok: true, league: getLeagueById(league.id) });
  } catch (err) {
    logger.error('Web portal update league failed', { error: err.message, guildId, leagueId });
    res.status(500).json({ error: err.message });
  }
});

// Soft delete — flips active to 0. Nothing is removed from the database.
router.delete('/guilds/:guildId/leagues/:leagueId', requireGuildAccess, (req, res) => {
  const { guildId, leagueId } = req.params;
  const league = leagueInGuild(leagueId, guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });

  setLeagueActive(league.id, false);
  logger.info('Web portal deactivated league', {
    adminId: req.session.user.id, guildId, leagueId: league.id, abbr: league.abbr,
  });
  res.json({ ok: true });
});

router.post('/guilds/:guildId/leagues/:leagueId/restore', requireGuildAccess, (req, res) => {
  const { guildId, leagueId } = req.params;
  const league = leagueInGuild(leagueId, guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });

  // A keyword can be reused by a new active league once the old one was
  // deactivated, so reactivating would collide. Block it with a clear message.
  const clash = getLeagueByAbbr(guildId, league.abbr);
  if (clash && clash.id !== league.id) {
    return res.status(409).json({
      error: `Can't reactivate "${league.name}" — keyword ${league.abbr} is now used by the active league "${clash.name}". Deactivate that one first.`,
    });
  }

  setLeagueActive(league.id, true);
  logger.info('Web portal reactivated league', {
    adminId: req.session.user.id, guildId, leagueId: league.id, abbr: league.abbr,
  });
  res.json({ ok: true });
});

router.get('/guilds/:guildId/health', requireGuildAccess, (req, res) => {
  res.json(getHealthStats(req.params.guildId));
});

router.get('/guilds/:guildId/users', requireGuildAccess, (req, res) => {
  const rows = db.prepare(`
    SELECT u.discord_id, u.discord_username, u.active,
           ul.team_name, ul.team_abbrev,
           l.name AS league_name, l.abbr AS league_abbr, l.id AS league_id,
           up.platform, up.platform_username, up.subscription_id
    FROM users u
    JOIN user_leagues ul ON ul.user_id = u.id
    JOIN leagues l ON l.id = ul.league_id
    LEFT JOIN user_platforms up ON up.user_id = u.id
    WHERE l.guild_id = ? AND u.active = 1 AND l.active = 1
    ORDER BY u.discord_username
  `).all(req.params.guildId);

  // Group platforms per user+league membership
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.discord_id}:${row.league_id}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        discord_id: row.discord_id,
        discord_username: row.discord_username,
        league_id: row.league_id,
        league_name: row.league_name,
        league_abbr: row.league_abbr,
        team_name: row.team_name,
        team_abbrev: row.team_abbrev,
        platforms: [],
      });
    }
    if (row.platform) {
      byKey.get(key).platforms.push({
        platform: row.platform,
        platform_username: row.platform_username,
        subscription_id: row.subscription_id,
      });
    }
  }

  // Also surface users who have stream details but no active league membership
  // in this guild. Platform accounts are global, so an unassigned user has no
  // guild link — we key them by discord_id alone with null league fields.
  const unassigned = db.prepare(`
    SELECT u.discord_id, u.discord_username,
           up.platform, up.platform_username, up.subscription_id
    FROM users u
    JOIN user_platforms up ON up.user_id = u.id
    WHERE u.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM user_leagues ul
        JOIN leagues l ON l.id = ul.league_id
        WHERE ul.user_id = u.id AND l.guild_id = ? AND l.active = 1
      )
    ORDER BY u.discord_username
  `).all(req.params.guildId);

  const byUser = new Map();
  for (const row of unassigned) {
    if (!byUser.has(row.discord_id)) {
      byUser.set(row.discord_id, {
        discord_id: row.discord_id,
        discord_username: row.discord_username,
        league_id: null,
        league_name: null,
        league_abbr: null,
        team_name: null,
        team_abbrev: null,
        platforms: [],
      });
    }
    byUser.get(row.discord_id).platforms.push({
      platform: row.platform,
      platform_username: row.platform_username,
      subscription_id: row.subscription_id,
    });
  }

  res.json([...byKey.values(), ...byUser.values()]);
});

router.get('/guilds/:guildId/streams', requireGuildAccess, (req, res) => {
  const rows = db.prepare(`
    SELECT sp.id, sp.platform, sp.platform_stream_id, sp.discord_user_id,
           sp.stream_title, sp.posted_at,
           u.discord_username,
           l.id AS league_id, l.name AS league_name, l.abbr AS league_abbr
    FROM stream_posts sp
    JOIN leagues l ON l.id = sp.league_id
    LEFT JOIN users u ON u.discord_id = sp.discord_user_id
    WHERE l.guild_id = ?
    ORDER BY sp.posted_at DESC
    LIMIT 200
  `).all(req.params.guildId);

  res.json(rows);
});

// ── POST /api/guilds/:guildId/register ────────────────────────────────────────

router.post('/guilds/:guildId/register', requireGuildAccess, async (req, res) => {
  const { guildId } = req.params;
  const { discordId, discordUsername, platform, platformUsername, leagueId, teamName, teamAbbrev } = req.body;

  if (!discordId || !platform || !platformUsername || !leagueId) {
    return res.status(400).json({ error: 'discordId, platform, platformUsername, and leagueId are required' });
  }

  const league = getLeagueById(Number(leagueId));
  if (!league || league.guild_id !== guildId) {
    return res.status(404).json({ error: 'League not found' });
  }
  if (!league.active) {
    return res.status(400).json({ error: `League "${league.name}" is deactivated.` });
  }

  try {
    const username = platformUsername.replace(/^@/, '').toLowerCase();
    getOrCreateUser(discordId, discordUsername || discordId);
    addUserPlatform(discordId, platform, username, null);
    addUserToLeague(discordId, league.id, req.session.user.id, teamName || null, teamAbbrev || null);

    const { ensureSubscription } = require('../platforms/subscribe');
    await ensureSubscription(platform, username);

    logger.info('Web portal registered user', {
      adminId: req.session.user.id,
      discordId,
      guildId,
      platform,
      username,
      leagueId,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('Web portal register error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/guilds/:guildId/users/:discordId/league/:leagueId ─────────────

router.delete('/guilds/:guildId/users/:discordId/league/:leagueId', requireGuildAccess, (req, res) => {
  const { guildId, discordId, leagueId } = req.params;
  const league = getLeagueById(Number(leagueId));
  if (!league || league.guild_id !== guildId) {
    return res.status(404).json({ error: 'League not found' });
  }

  removeUserFromLeague(discordId, Number(leagueId));
  logger.info('Web portal removed user from league', {
    adminId: req.session.user.id,
    discordId,
    guildId,
    leagueId,
  });
  res.json({ ok: true });
});

// ── PUT /api/guilds/:guildId/users/:discordId/platforms ───────────────────────
// Edit a user's stream details (their Twitch / YouTube usernames). Platform
// accounts are global, so this reconciles both platforms in one call: a blank
// value removes that platform, a changed value updates (or adds) it.

router.put('/guilds/:guildId/users/:discordId/platforms', requireGuildAccess, async (req, res) => {
  const { guildId, discordId } = req.params;

  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const current = {};
  for (const p of getUserPlatforms(discordId)) current[p.platform] = p.platform_username;

  const changes = [];
  for (const platform of ['twitch', 'youtube']) {
    if (!(platform in req.body)) continue; // only touch platforms the client sent
    const next = String(req.body[platform] || '').trim().replace(/^@/, '').toLowerCase();
    const existing = current[platform] || '';
    if (next === existing) continue;

    if (!next) {
      changes.push({ platform, action: 'removed' });
    } else if (existing) {
      changes.push({ platform, action: 'updated', username: next });
    } else {
      changes.push({ platform, action: 'added', username: next });
    }
  }

  if (!changes.length) return res.json({ ok: true, changes: [] });

  try {
    for (const change of changes) {
      if (change.action === 'removed') {
        removeUserPlatform(discordId, change.platform);
        continue;
      }

      if (change.action === 'updated') {
        updateUserPlatformUsername(discordId, change.platform, change.username);
      } else {
        addUserPlatform(discordId, change.platform, change.username, null);
      }

      const { ensureSubscription } = require('../platforms/subscribe');
      await ensureSubscription(change.platform, change.username);
    }

    logger.info('Web portal updated user stream details', {
      adminId: req.session.user.id, discordId, guildId, changes,
    });
    res.json({ ok: true, changes });
  } catch (err) {
    logger.error('Web portal update stream details failed', { error: err.message, discordId, guildId });
    // A UNIQUE(platform, platform_username) clash means that handle is taken.
    const taken = /UNIQUE/i.test(err.message);
    res.status(taken ? 409 : 500).json({
      error: taken ? 'That platform username is already registered to another user.' : err.message,
    });
  }
});

// Resolve the advancement message for a week. Precedence: DB games → CSV schedule
// sheet → (only when allowEmpty) an explicit empty-week placeholder. Returns
// { message, source } on success, or { code } when it can't build one:
//   'no-season' — league has no current season (nothing to build against)
//   'no-games'  — a season exists but the week is empty and no sheet supplied it;
//                 the caller may re-request with allowEmpty to force a placeholder.
async function resolveAdvanceMessage(league, week, { dateOverride = null, allowEmpty = false } = {}) {
  const w = Number(week);

  const dbMessage = buildDbAdvanceMessage(league, w, { dateOverride });
  if (dbMessage) return { message: dbMessage, source: 'database' };

  // No DB message — distinguish "no season at all" from "season, but empty week".
  if (!getCurrentSeason(league.id)) return { code: 'no-season' };

  // Empty week: try the CSV schedule sheet before giving up.
  if (league.schedule_url) {
    const decodedUrl = league.schedule_url.replace(/&amp;/g, '&');
    const response = await axios.get(decodedUrl, { responseType: 'text' });
    const csvRaw = parseScheduleCell(response.data, 5, w);
    if (csvRaw) return { message: applyDateOverride(csvRaw, dateOverride), source: 'sheet' };
  }

  // Nothing scheduled anywhere. Only build a placeholder if the caller confirmed.
  if (!allowEmpty) return { code: 'no-games' };
  return { message: buildDbAdvanceMessage(league, w, { dateOverride, allowEmpty: true }), source: 'empty' };
}

// ── GET /api/guilds/:guildId/advance/preview ──────────────────────────────────

router.get('/guilds/:guildId/advance/preview', requireGuildAccess, async (req, res) => {
  const { guildId } = req.params;
  const { leagueAbbr, week, dateOverride } = req.query;

  if (!leagueAbbr || week === undefined) {
    return res.status(400).json({ error: 'leagueAbbr and week are required' });
  }

  const league = getLeagueByAbbr(guildId, leagueAbbr.toUpperCase());
  if (!league) return res.status(404).json({ error: 'League not found' });

  try {
    const allowEmpty = req.query.allowEmpty === '1' || req.query.allowEmpty === 'true';
    const resolved = await resolveAdvanceMessage(league, week, { dateOverride: dateOverride || null, allowEmpty });
    if (resolved.code === 'no-season') {
      return res.status(400).json({ error: 'No current season is set for this league' });
    }
    if (resolved.code === 'no-games') {
      // Empty week — signal the client to confirm, then re-request with allowEmpty.
      return res.status(409).json({ error: 'No games are scheduled for this week', code: 'no-games' });
    }
    res.json({ ok: true, message: resolved.message, source: resolved.source });
  } catch (err) {
    logger.error('Web portal advance preview error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/guilds/:guildId/advance ─────────────────────────────────────────

router.post('/guilds/:guildId/advance', requireGuildAccess, async (req, res) => {
  const { guildId } = req.params;
  const { leagueAbbr, week, dateOverride } = req.body;

  if (!leagueAbbr || week === undefined) {
    return res.status(400).json({ error: 'leagueAbbr and week are required' });
  }

  const league = getLeagueByAbbr(guildId, leagueAbbr.toUpperCase());
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (!league.advance_channel_id) return res.status(400).json({ error: 'No advance channel configured for this league' });

  try {
    const allowEmpty = req.body.allowEmpty === true;
    const resolved = await resolveAdvanceMessage(league, week, { dateOverride: dateOverride || null, allowEmpty });
    if (resolved.code === 'no-season') {
      return res.status(400).json({ error: 'No current season is set for this league' });
    }
    if (resolved.code === 'no-games') {
      // Empty week — signal the client to confirm, then re-post with allowEmpty.
      return res.status(409).json({ error: 'No games are scheduled for this week', code: 'no-games' });
    }
    const message = resolved.message;

    const client = require('../bot/client');
    const channel = await client.channels.fetch(league.advance_channel_id);
    await channel.send(message);

    let threadCount = 0;
    if (league.user_channel_id) {
      const userChannel = await client.channels.fetch(league.user_channel_id);

      // Archive the previous week's active threads before creating this week's
      try {
        const active = await userChannel.threads.fetchActive();
        for (const thread of active.threads.values()) {
          await thread.setArchived(true).catch(() => {});
        }
        logger.info('Archived previous threads on advance', { league: leagueAbbr, count: active.threads.size });
      } catch (err) {
        logger.warn('Failed to archive previous threads on advance', { league: leagueAbbr, error: err.message });
      }

      const matchups = parseMatchups(message);
      if (matchups.length > 0) {
        const leagueUsers = getUsersInLeague(league.id);
        const teamMap = new Map(leagueUsers.map(u => [u.discord_id, u.team_name || u.discord_username]));
        const weekLabel = WEEK_LABELS[Number(week)] ?? `Week ${week}`;

        for (const [id1, id2] of matchups) {
          const team1 = teamMap.get(id1) ?? `<@${id1}>`;
          const team2 = teamMap.get(id2) ?? `<@${id2}>`;
          const thread = await userChannel.threads.create({
            name: `${weekLabel} : ${team1} vs ${team2}`,
            autoArchiveDuration: 10080,
          });
          const staffMention = league.staff_role_id ? `<@&${league.staff_role_id}>` : 'Staff';
          await thread.send(
            `It's game time!  Time to get sweaty and get those sticks ready!\n\n<@${id1}> versus <@${id2}>\n\nMake sure to schedule your game in this thread.  You have 24 hours to make initial contact with each other before risking being put on Auto Pilot!\n\n~ ${staffMention}`
          );
          threadCount++;
        }
      }
    }

    logger.info('Web portal advance posted', {
      adminId: req.session.user.id,
      guildId,
      league: leagueAbbr,
      week,
      threadCount,
    });

    res.json({ ok: true, threadCount });
  } catch (err) {
    logger.error('Web portal advance error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Dynasty: seasons, teams, coaches, schedule, results, summaries
// ══════════════════════════════════════════════════════════════════════════════

function leagueInGuild(leagueId, guildId) {
  const league = getLeagueById(Number(leagueId));
  if (!league || league.guild_id !== guildId) return null;
  return league;
}

function seasonInGuild(seasonId, guildId) {
  const season = getSeasonById(Number(seasonId));
  if (!season) return null;
  const league = getLeagueById(season.league_id);
  if (!league || league.guild_id !== guildId) return null;
  return { season, league };
}

function teamName(abbrev) {
  return getTeamByAbbrev(abbrev)?.name || abbrev;
}

function teamColors(abbrev) {
  return getTeamByAbbrev(abbrev)?.colors || [];
}

function enrichGame(g) {
  return {
    ...g,
    home_name: teamName(g.home_abbrev), away_name: teamName(g.away_abbrev),
    home_colors: teamColors(g.home_abbrev), away_colors: teamColors(g.away_abbrev),
  };
}

// ── Team catalog (for dropdowns) ──────────────────────────────────────────────

router.get('/guilds/:guildId/team-search', requireGuildAccess, (req, res) => {
  res.json(searchTeams(req.query.q || ''));
});

// Team colors/name for the schedule visuals.
router.get('/guilds/:guildId/team-meta/:abbrev', requireGuildAccess, (req, res) => {
  const team = getTeamByAbbrev(req.params.abbrev);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json({ name: team.name, abbrev: team.abbrev, colors: team.colors || [] });
});

// Serve a team's logo (custom-team BLOB or the bundled PNG by `pic` path).
router.get('/guilds/:guildId/team-logo/:abbrev', requireGuildAccess, (req, res) => {
  const team = getTeamByAbbrev(req.params.abbrev);
  if (!team) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  if (team.logoBuffer) { res.type('png'); return res.send(team.logoBuffer); }
  if (team.pic) {
    const p = path.resolve(process.cwd(), team.pic.replace(/^\.\//, ''));
    if (!fs.existsSync(p)) return res.status(404).end();
    return res.sendFile(p);
  }
  return res.status(404).end();
});

// ── Team management (unified NCAA + custom catalog) ───────────────────────────

function normalizeColors(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  for (const c of arr) {
    const s = String(c).trim();
    if (!s) continue;
    if (!/^#?[0-9A-Fa-f]{6}$/.test(s)) throw new Error(`Invalid color "${s}" — use hex like #500000`);
    out.push(s.startsWith('#') ? s : `#${s}`);
  }
  return out;
}

// A logo can arrive as a base64 data URL (file upload) or a URL to download.
// Returns a Buffer, or undefined when neither was supplied (i.e. leave as-is).
async function resolveLogoBuffer({ logoData, logoUrl }) {
  if (logoData) {
    const b64 = String(logoData).replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('uploaded image was empty');
    return buf;
  }
  if (logoUrl) {
    const resp = await axios.get(String(logoUrl).trim(), {
      responseType: 'arraybuffer', timeout: 10000, maxContentLength: 8 * 1024 * 1024,
    });
    return Buffer.from(resp.data);
  }
  return undefined;
}

router.get('/guilds/:guildId/teams', requireGuildAccess, (req, res) => {
  res.json(getAllTeams().map(t => ({
    name: t.name,
    abbrev: t.abbrev,
    conference: t.conference,
    mascot: t.mascot,
    colors: JSON.parse(t.colors || '[]'),
    is_custom: t.is_custom,
    active: t.active,
    has_logo: Boolean(t.logo || t.pic),
  })));
});

router.post('/guilds/:guildId/teams', requireGuildAccess, async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const abbrev = String(req.body.abbrev ?? '').trim().toUpperCase();
  const mascot = String(req.body.mascot ?? '').trim() || null;
  const conference = String(req.body.conference ?? '').trim() || 'Custom';

  if (!name || !abbrev) return res.status(400).json({ error: 'Name and abbreviation are required' });
  if (!/^[A-Z0-9]{1,16}$/.test(abbrev)) return res.status(400).json({ error: 'Abbreviation must be 1-16 letters or digits' });
  if (getTeamRow(abbrev)) return res.status(409).json({ error: `A team with abbreviation ${abbrev} already exists.` });

  let colors, logo;
  try { colors = normalizeColors(req.body.colors); } catch (err) { return res.status(400).json({ error: err.message }); }
  try { logo = await resolveLogoBuffer(req.body); } catch (err) { return res.status(400).json({ error: `Logo: ${err.message}` }); }

  try {
    addCustomTeam(name, abbrev, mascot, colors, logo || null);
    if (conference && conference !== 'Custom') updateTeam(abbrev, { conference });
    logger.info('Web portal created team', { adminId: req.session.user.id, abbrev });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Web portal create team failed', { error: err.message, abbrev });
    res.status(500).json({ error: err.message });
  }
});

router.put('/guilds/:guildId/teams/:abbrev', requireGuildAccess, async (req, res) => {
  const current = getTeamRow(req.params.abbrev);
  if (!current) return res.status(404).json({ error: 'Team not found' });

  const updates = {};
  if (req.body.name !== undefined) {
    const n = String(req.body.name).trim();
    if (!n) return res.status(400).json({ error: 'Name cannot be empty' });
    updates.name = n;
  }
  if (req.body.mascot !== undefined) updates.mascot = String(req.body.mascot).trim() || null;
  if (req.body.conference !== undefined) updates.conference = String(req.body.conference).trim() || null;
  if (req.body.colors !== undefined) {
    try { updates.colors = normalizeColors(req.body.colors); } catch (err) { return res.status(400).json({ error: err.message }); }
  }
  // abbrev is the routing key and is intentionally not editable here.

  try {
    const logo = await resolveLogoBuffer(req.body);
    if (logo !== undefined) updates.logo = logo;
  } catch (err) {
    return res.status(400).json({ error: `Logo: ${err.message}` });
  }

  try {
    updateTeam(current.abbrev, updates);
    logger.info('Web portal updated team', { adminId: req.session.user.id, abbrev: current.abbrev });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Web portal update team failed', { error: err.message, abbrev: current.abbrev });
    res.status(500).json({ error: err.message });
  }
});

router.post('/guilds/:guildId/teams/:abbrev/deactivate', requireGuildAccess, (req, res) => {
  const t = getTeamRow(req.params.abbrev);
  if (!t) return res.status(404).json({ error: 'Team not found' });
  setTeamActive(t.abbrev, false);
  logger.info('Web portal deactivated team', { adminId: req.session.user.id, abbrev: t.abbrev });
  res.json({ ok: true });
});

router.post('/guilds/:guildId/teams/:abbrev/restore', requireGuildAccess, (req, res) => {
  const t = getTeamRow(req.params.abbrev);
  if (!t) return res.status(404).json({ error: 'Team not found' });
  setTeamActive(t.abbrev, true);
  logger.info('Web portal restored team', { adminId: req.session.user.id, abbrev: t.abbrev });
  res.json({ ok: true });
});

// Channel + role picker data for the league form. The Guilds intent keeps these
// cached, so this is a local read in the common case.
router.get('/guilds/:guildId/discord/channels-roles', requireGuildAccess, async (req, res) => {
  try {
    const client = require('../bot/client');
    const guild = client.guilds.cache.get(req.params.guildId)
      || await client.guilds.fetch(req.params.guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: 'Bot is not in this server' });

    const channels = [...(await guild.channels.fetch()).values()].filter(Boolean);
    const byPosition = (a, b) => a.rawPosition - b.rawPosition;

    // Streams and advance messages can only be posted to text-like channels.
    const postable = channels
      .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .sort(byPosition)
      .map(c => ({ id: c.id, name: c.name, category: c.parent?.name ?? null }));

    const categories = channels
      .filter(c => c.type === ChannelType.GuildCategory)
      .sort(byPosition)
      .map(c => ({ id: c.id, name: c.name }));

    const roles = [...(await guild.roles.fetch()).values()]
      .filter(r => r.id !== guild.id) // @everyone
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name }));

    res.json({ channels: postable, categories, roles });
  } catch (err) {
    logger.error('channels-roles fetch error', { error: err.message, guildId: req.params.guildId });
    res.status(500).json({ error: err.message });
  }
});

// Discord member lookup (username/nickname prefix). Uses the REST member search —
// no privileged GuildMembers intent required.
router.get('/guilds/:guildId/discord-members', requireGuildAccess, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const client = require('../bot/client');
    const guild = client.guilds.cache.get(req.params.guildId)
      || await client.guilds.fetch(req.params.guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: 'Bot is not in this server' });
    const members = await guild.members.search({ query: q, limit: 10 });
    res.json([...members.values()].map(m => ({
      id: m.id,
      username: m.user.username,
      display: m.displayName,
    })));
  } catch (err) {
    logger.error('discord-members search error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Seasons ───────────────────────────────────────────────────────────────────

router.get('/guilds/:guildId/leagues/:leagueId/seasons', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  res.json(getSeasonsByLeague(league.id));
});

router.post('/guilds/:guildId/leagues/:leagueId/seasons', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const { year, label, clone } = req.body;
  if (!year) return res.status(400).json({ error: 'year is required' });
  try {
    const season = createSeason(league.id, Number(year), label || null);

    // Optionally seed the new season from the current one (roster + conferences
    // + coach assignments). Skip if the new season IS the current one (first
    // season for the league) — there's nothing prior to copy.
    let cloned = null;
    if (clone) {
      const source = getCurrentSeason(league.id);
      if (source && source.id !== season.id) {
        cloned = cloneSeasonData(source.id, season.id);
        logger.info('Season cloned', { adminId: req.session.user.id, fromSeason: source.id, toSeason: season.id, ...cloned });
      }
    }

    logger.info('Season created', { adminId: req.session.user.id, leagueId: league.id, year });
    res.json({ ...season, cloned });
  } catch (err) {
    const msg = err.message?.includes('UNIQUE') ? `Season ${year} already exists for this league` : err.message;
    res.status(400).json({ error: msg });
  }
});

router.put('/guilds/:guildId/leagues/:leagueId/current-season', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const { seasonId } = req.body;
  const info = seasonInGuild(seasonId, req.params.guildId);
  if (!info || info.league.id !== league.id) return res.status(404).json({ error: 'Season not found' });
  setCurrentSeason(league.id, Number(seasonId));
  res.json({ ok: true });
});

// ── Conferences ───────────────────────────────────────────────────────────────

router.get('/guilds/:guildId/seasons/:seasonId/conferences', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  res.json(getConferences(info.league.id));
});

router.post('/guilds/:guildId/seasons/:seasonId/conferences', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const { name, abbrev } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(upsertConference(info.league.id, name, abbrev || null));
});

// ── Season teams ──────────────────────────────────────────────────────────────

router.get('/guilds/:guildId/seasons/:seasonId/teams', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const teams = getSeasonTeams(info.season.id).map(t => ({
    ...t,
    team_name: teamName(t.team_abbrev),
    colors: teamColors(t.team_abbrev),
    is_user_team: t.coach_id != null,
  }));
  res.json(teams);
});

router.post('/guilds/:guildId/seasons/:seasonId/teams', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const { teamAbbrev, conferenceName } = req.body;
  if (!teamAbbrev) return res.status(400).json({ error: 'teamAbbrev is required' });
  if (!getTeamByAbbrev(teamAbbrev)) return res.status(400).json({ error: `Team ${teamAbbrev} not found` });
  // Conferences come from a fixed dropdown by name; resolve (or create) the
  // per-league conference row and store its id on the season team.
  const conf = conferenceName ? upsertConference(info.league.id, String(conferenceName).trim()) : null;
  upsertSeasonTeam(info.season.id, teamAbbrev, conf ? conf.id : null);
  res.json({ ok: true });
});

router.delete('/guilds/:guildId/seasons/:seasonId/teams/:abbrev', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  removeSeasonTeam(info.season.id, req.params.abbrev);
  res.json({ ok: true });
});

// ── Coaches (league-scoped) ───────────────────────────────────────────────────

router.get('/guilds/:guildId/leagues/:leagueId/coaches', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  res.json(getCoachesByLeague(league.id));
});

router.post('/guilds/:guildId/leagues/:leagueId/coaches', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const { discordId, discordUsername, displayName } = req.body;
  let userId = null;
  if (discordId) {
    userId = getOrCreateUser(discordId, discordUsername || discordId).id;
    // A coach is a league participant — register them so they appear on the
    // Users page even before a team is assigned (doesn't touch any team).
    ensureUserInLeague(discordId, league.id, 'dynasty-coach');
  }
  const name = (displayName || discordUsername || discordId || '').trim();
  if (!name) return res.status(400).json({ error: 'displayName or discordId is required' });
  res.json(getOrCreateCoach(league.id, userId, name));
});

// ── Assignments ───────────────────────────────────────────────────────────────

router.get('/guilds/:guildId/seasons/:seasonId/assignments', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  res.json(getSeasonAssignments(info.season.id));
});

router.post('/guilds/:guildId/seasons/:seasonId/assignments', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const { coachId, teamAbbrev, conferenceName } = req.body;
  if (!coachId || !teamAbbrev) return res.status(400).json({ error: 'coachId and teamAbbrev are required' });
  const coach = getCoachById(Number(coachId));
  if (!coach || coach.league_id !== info.league.id) return res.status(404).json({ error: 'Coach not found' });
  if (!getTeamByAbbrev(teamAbbrev)) return res.status(400).json({ error: `Team ${teamAbbrev} not found` });

  // Assigning a coach also puts the team on the season roster. Set its
  // conference from the dropdown when given, otherwise keep whatever it has.
  let conferenceId = null;
  if (conferenceName) {
    conferenceId = upsertConference(info.league.id, String(conferenceName).trim()).id;
  } else {
    conferenceId = getSeasonTeam(info.season.id, teamAbbrev)?.conference_id ?? null;
  }
  upsertSeasonTeam(info.season.id, teamAbbrev, conferenceId);
  assignCoachTeam(info.season.id, Number(coachId), teamAbbrev, teamName(teamAbbrev));

  logger.info('Coach assigned', { adminId: req.session.user.id, seasonId: info.season.id, coachId, team: teamAbbrev, conference: conferenceName || null });
  res.json({ ok: true });
});

// ── Games (schedule + results) ────────────────────────────────────────────────

router.get('/guilds/:guildId/seasons/:seasonId/games', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const week = req.query.week !== undefined ? Number(req.query.week) : null;
  const rows = week !== null ? getGamesByWeek(info.season.id, week) : getScheduledGames(info.season.id);
  res.json(rows.map(enrichGame));
});

router.post('/guilds/:guildId/seasons/:seasonId/games', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const { week, isPostseason, matchups } = req.body;
  if (week === undefined || !Array.isArray(matchups) || !matchups.length) {
    return res.status(400).json({ error: 'week and a non-empty matchups array are required' });
  }
  for (const m of matchups) {
    if (!m.homeAbbrev || !m.awayAbbrev) return res.status(400).json({ error: 'each matchup needs homeAbbrev and awayAbbrev' });
  }
  const rows = matchups.map(m => ({
    week: Number(week), homeAbbrev: m.homeAbbrev, awayAbbrev: m.awayAbbrev, isPostseason: isPostseason ? 1 : 0,
  }));
  bulkInsertGames(info.season.id, rows);
  logger.info('Schedule saved', { adminId: req.session.user.id, seasonId: info.season.id, week, count: rows.length });
  res.json({ ok: true, count: rows.length });
});

// Team-centric schedule (the full-week grid)
router.get('/guilds/:guildId/seasons/:seasonId/team-schedule', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const team = (req.query.team || '').toUpperCase();
  if (!team) return res.status(400).json({ error: 'team is required' });
  const rows = getTeamSchedule(info.season.id, team).map(g => ({
    ...g,
    opponent_name: g.opponent_abbrev ? teamName(g.opponent_abbrev) : null,
    opponent_colors: g.opponent_abbrev ? teamColors(g.opponent_abbrev) : [],
  }));
  res.json(rows);
});

router.post('/guilds/:guildId/seasons/:seasonId/team-schedule', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const { team, weeks } = req.body;
  if (!team || !Array.isArray(weeks)) return res.status(400).json({ error: 'team and a weeks array are required' });

  const roster = new Set(getSeasonTeams(info.season.id).map(t => t.team_abbrev));
  if (!roster.has(team.toUpperCase())) return res.status(400).json({ error: `${team} is not on this season's roster` });

  for (const w of weeks) {
    if (w.week === undefined) return res.status(400).json({ error: 'each week needs a week number' });
    if (w.opponent) {
      if (!getTeamByAbbrev(w.opponent)) return res.status(400).json({ error: `Opponent ${w.opponent} not found` });
      if (w.opponent.toUpperCase() === team.toUpperCase()) return res.status(400).json({ error: 'A team cannot play itself' });
    }
  }

  try {
    bulkSetTeamSchedule(info.season.id, team, weeks);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  logger.info('Team schedule saved', { adminId: req.session.user.id, seasonId: info.season.id, team, weeks: weeks.length });
  res.json({ ok: true });
});

router.delete('/guilds/:guildId/seasons/:seasonId/games/:gameId', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const game = getGameById(Number(req.params.gameId));
  if (!game || game.season_id !== info.season.id) return res.status(404).json({ error: 'Game not found' });
  deleteGame(game.id);
  res.json({ ok: true });
});

function applyResult(seasonId, gameId, body) {
  const game = getGameById(Number(gameId));
  if (!game || game.season_id !== seasonId) throw new Error('Game not found');
  const resultType = body.resultType || 'normal';
  const winnerSide = body.winnerSide || null;
  const homeScore = body.homeScore != null && body.homeScore !== '' ? Number(body.homeScore) : null;
  const awayScore = body.awayScore != null && body.awayScore !== '' ? Number(body.awayScore) : null;

  // Only a forfeit forces a winner; normal and fair-sim are decided by the score.
  if (resultType === 'FR' && !winnerSide) {
    throw new Error('A winner is required for a forfeit (FR) result');
  }
  if ((resultType === 'normal' || resultType === 'FS') && (homeScore == null || awayScore == null)) {
    throw new Error('Both scores are required for normal and fair-sim (FS) results');
  }

  // Forfeits and fair sims have no play attempts.
  const sim = resultType === 'FR' || resultType === 'FS';
  const attemptsTaken = sim ? 0 : (body.attempts != null && body.attempts !== '' ? Number(body.attempts) : null);

  recordGameResult(game.id, { homeScore, awayScore, attemptsTaken, resultType, winnerSide });
}

router.post('/guilds/:guildId/seasons/:seasonId/games/:gameId/result', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  try {
    applyResult(info.season.id, req.params.gameId, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/guilds/:guildId/seasons/:seasonId/results', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const results = req.body.results;
  if (!Array.isArray(results)) return res.status(400).json({ error: 'results array is required' });
  try {
    let saved = 0;
    for (const r of results) { applyResult(info.season.id, r.gameId, r); saved++; }
    res.json({ ok: true, saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Derived summaries ─────────────────────────────────────────────────────────

router.get('/guilds/:guildId/seasons/:seasonId/summary', requireGuildAccess, (req, res) => {
  const info = seasonInGuild(req.params.seasonId, req.params.guildId);
  if (!info) return res.status(404).json({ error: 'Season not found' });
  const rows = getSeasonSummary(info.season.id).map(r => ({ ...r, team_name: teamName(r.team_abbrev) }));
  res.json(rows);
});

router.get('/guilds/:guildId/leagues/:leagueId/coach-history', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  res.json(getCoachHistory(league.id));
});

router.get('/guilds/:guildId/coaches/:coachId/history', requireGuildAccess, (req, res) => {
  const coach = getCoachById(Number(req.params.coachId));
  if (!coach) return res.status(404).json({ error: 'Coach not found' });
  const league = getLeagueById(coach.league_id);
  if (!league || league.guild_id !== req.params.guildId) return res.status(404).json({ error: 'Coach not found' });
  res.json({ coach, seasons: getCoachSeasonBreakdown(coach.id) });
});

// ── Advancement template ──────────────────────────────────────────────────────

router.get('/guilds/:guildId/leagues/:leagueId/advance-template', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const { DEFAULT_TEMPLATE } = require('../utils/advance');
  res.json({ template: league.advance_template || '', default: DEFAULT_TEMPLATE });
});

router.put('/guilds/:guildId/leagues/:leagueId/advance-template', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  setLeagueAdvanceTemplate(league.id, req.body.template ?? null);
  res.json({ ok: true });
});

// ── League gameplay settings (sliders/toggles) ─────────────────────────────────

router.get('/guilds/:guildId/leagues/:leagueId/settings', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const { SECTIONS, resolveSettings } = require('../utils/leagueSettings');
  res.json({
    sections: SECTIONS,
    values: resolveSettings(getLeagueSettings(league.id)),
    // Publish state drives the Publish/Update button and its enablement.
    channelConfigured: Boolean(league.settings_channel_id),
    published: Boolean(getSettingsPost(league.id)),
  });
});

router.put('/guilds/:guildId/leagues/:leagueId/settings', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const { sanitizeSettings, resolveSettings } = require('../utils/leagueSettings');
  const overrides = sanitizeSettings(req.body.values);
  setLeagueSettings(league.id, overrides);
  // Saving never posts to Discord — publishing is an explicit, separate action.
  res.json({ ok: true, values: resolveSettings(overrides) });
});

// Publish the settings post (or update the existing one + post a changelog).
router.post('/guilds/:guildId/leagues/:leagueId/settings/publish', requireGuildAccess, async (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (!league.settings_channel_id) {
    return res.status(400).json({ error: 'No settings channel is configured for this league. Set one in Configure.' });
  }
  try {
    const { publishOrUpdateSettingsPost } = require('../utils/settingsPost');
    const actorName = req.session.user?.username || 'Staff';
    const result = await publishOrUpdateSettingsPost(league, actorName);
    logger.info('Web portal published settings', {
      adminId: req.session.user.id, guildId: req.params.guildId, leagueId: league.id, action: result.action,
    });
    res.json({ ok: true, ...result, published: true });
  } catch (err) {
    logger.error('Web portal settings publish error', { error: err.message, leagueId: league.id });
    res.status(500).json({ error: err.message });
  }
});

// ── Season roster post (coach assignments per season) ─────────────────────────

// Publish state for the Season screen's button. Keyed by season, so switching
// seasons flips the button back to "Publish" until that season is posted.
router.get('/guilds/:guildId/leagues/:leagueId/seasons/:seasonId/roster-post', requireGuildAccess, (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const season = getSeasonById(Number(req.params.seasonId));
  if (!season || season.league_id !== league.id) return res.status(404).json({ error: 'Season not found' });
  res.json({
    channelConfigured: Boolean(league.roster_channel_id),
    published: Boolean(getRosterPost(season.id)),
  });
});

// Publish this season's roster (or update it + post a changelog of coach moves).
router.post('/guilds/:guildId/leagues/:leagueId/seasons/:seasonId/roster/publish', requireGuildAccess, async (req, res) => {
  const league = leagueInGuild(req.params.leagueId, req.params.guildId);
  if (!league) return res.status(404).json({ error: 'League not found' });
  const season = getSeasonById(Number(req.params.seasonId));
  if (!season || season.league_id !== league.id) return res.status(404).json({ error: 'Season not found' });
  if (!league.roster_channel_id) {
    return res.status(400).json({ error: 'No roster channel is configured for this league. Set one in Configure.' });
  }
  try {
    const { publishOrUpdateRosterPost } = require('../utils/rosterPost');
    const actorName = req.session.user?.username || 'Staff';
    const result = await publishOrUpdateRosterPost(league, season, actorName);
    logger.info('Web portal published season roster', {
      adminId: req.session.user.id, guildId: req.params.guildId, seasonId: season.id, action: result.action,
    });
    res.json({ ok: true, ...result, published: true });
  } catch (err) {
    logger.error('Web portal roster publish error', { error: err.message, seasonId: season.id });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
