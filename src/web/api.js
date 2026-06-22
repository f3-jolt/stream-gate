'use strict';

const express = require('express');
const axios = require('axios');
const { db } = require('../db/database');
const {
  getAllLeagues,
  getLeagueById,
  getLeagueByAbbr,
  getHealthStats,
  getOrCreateUser,
  addUserPlatform,
  addUserToLeague,
  removeUserFromLeague,
  getUsersInLeague,
  setLeagueAdvanceTemplate,
  // Dynasty
  createSeason,
  getSeasonsByLeague,
  getSeasonById,
  getCurrentSeason,
  setCurrentSeason,
  getConferences,
  upsertConference,
  getSeasonTeams,
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
  res.json(getAllLeagues(req.params.guildId));
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
    WHERE l.guild_id = ? AND u.active = 1
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

  res.json([...byKey.values()]);
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

  try {
    const username = platformUsername.replace(/^@/, '').toLowerCase();
    getOrCreateUser(discordId, discordUsername || discordId);
    addUserPlatform(discordId, platform, username, null);
    addUserToLeague(discordId, league.id, req.session.user.id, teamName || null, teamAbbrev || null);

    if (platform === 'youtube' && process.env.YOUTUBE_API_KEY) {
      const { getChannelIdByHandle, subscribeToChannel } = require('../platforms/youtube/api');
      const { updateSubscriptionId, updatePlatformUserId } = require('../db/queries');
      const channelId = await getChannelIdByHandle(username).catch(() => null);
      if (channelId) {
        await subscribeToChannel(channelId);
        updateSubscriptionId('youtube', username, channelId);
        updatePlatformUserId('youtube', username, channelId);
      }
    }

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
    // DB-first, CSV fallback (non-breaking).
    let rawMessage = buildDbAdvanceMessage(league, Number(week));
    let source = 'database';
    if (!rawMessage) {
      if (!league.schedule_url) {
        return res.status(400).json({ error: 'No games scheduled in the database for this week, and no schedule URL configured for this league' });
      }
      const decodedUrl = league.schedule_url.replace(/&amp;/g, '&');
      const response = await axios.get(decodedUrl, { responseType: 'text' });
      rawMessage = parseScheduleCell(response.data, 5, Number(week));
      source = 'sheet';
      if (!rawMessage) return res.status(404).json({ error: 'No data found for that week in the database or schedule sheet' });
    }

    const message = applyDateOverride(rawMessage, dateOverride || null);
    res.json({ ok: true, message, source });
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
    // DB-first, CSV fallback (non-breaking).
    let rawMessage = buildDbAdvanceMessage(league, Number(week));
    if (!rawMessage) {
      if (!league.schedule_url) {
        return res.status(400).json({ error: 'No games scheduled in the database for this week, and no schedule URL configured for this league' });
      }
      const decodedUrl = league.schedule_url.replace(/&amp;/g, '&');
      const response = await axios.get(decodedUrl, { responseType: 'text' });
      rawMessage = parseScheduleCell(response.data, 5, Number(week));
      if (!rawMessage) return res.status(404).json({ error: 'No data found for that week in the database or schedule sheet' });
    }

    const message = applyDateOverride(rawMessage, dateOverride || null);

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
  return { ...g, home_name: teamName(g.home_abbrev), away_name: teamName(g.away_abbrev) };
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
  const { year, label } = req.body;
  if (!year) return res.status(400).json({ error: 'year is required' });
  try {
    const season = createSeason(league.id, Number(year), label || null);
    logger.info('Season created', { adminId: req.session.user.id, leagueId: league.id, year });
    res.json(season);
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
  const { teamAbbrev, conferenceId } = req.body;
  if (!teamAbbrev) return res.status(400).json({ error: 'teamAbbrev is required' });
  if (!getTeamByAbbrev(teamAbbrev)) return res.status(400).json({ error: `Team ${teamAbbrev} not found` });
  upsertSeasonTeam(info.season.id, teamAbbrev, conferenceId ? Number(conferenceId) : null);
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
  if (discordId) userId = getOrCreateUser(discordId, discordUsername || discordId).id;
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
  const { coachId, teamAbbrev } = req.body;
  if (!coachId || !teamAbbrev) return res.status(400).json({ error: 'coachId and teamAbbrev are required' });
  const coach = getCoachById(Number(coachId));
  if (!coach || coach.league_id !== info.league.id) return res.status(404).json({ error: 'Coach not found' });
  assignCoachTeam(info.season.id, Number(coachId), teamAbbrev, teamName(teamAbbrev));
  logger.info('Coach assigned', { adminId: req.session.user.id, seasonId: info.season.id, coachId, team: teamAbbrev });
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
  if ((resultType === 'FR' || resultType === 'FS') && !winnerSide) {
    throw new Error('A winner is required for forfeit (FR) and fair-sim (FS) results');
  }
  recordGameResult(game.id, {
    homeScore: body.homeScore != null && body.homeScore !== '' ? Number(body.homeScore) : null,
    awayScore: body.awayScore != null && body.awayScore !== '' ? Number(body.awayScore) : null,
    attemptsTaken: body.attempts != null && body.attempts !== '' ? Number(body.attempts) : null,
    resultType,
    winnerSide,
  });
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

module.exports = router;
