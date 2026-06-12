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
} = require('../db/queries');
const { requireAuth, requireGuildAccess } = require('./middleware');
const { parseScheduleCell, parseMatchups, WEEK_LABELS, applyDateOverride } = require('../utils/schedule');
const logger = require('../utils/logger');

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
  if (!league.schedule_url) return res.status(400).json({ error: 'No schedule URL configured for this league' });

  try {
    const decodedUrl = league.schedule_url.replace(/&amp;/g, '&');
    const response = await axios.get(decodedUrl, { responseType: 'text' });
    const rawMessage = parseScheduleCell(response.data, 5, Number(week));

    if (!rawMessage) return res.status(404).json({ error: 'No data found for that week in the schedule sheet' });

    const message = applyDateOverride(rawMessage, dateOverride || null);
    res.json({ ok: true, message });
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
  if (!league.schedule_url) return res.status(400).json({ error: 'No schedule URL configured for this league' });

  try {
    const decodedUrl = league.schedule_url.replace(/&amp;/g, '&');
    const response = await axios.get(decodedUrl, { responseType: 'text' });
    const rawMessage = parseScheduleCell(response.data, 5, Number(week));

    if (!rawMessage) return res.status(404).json({ error: 'No data found for that week in the schedule sheet' });

    const message = applyDateOverride(rawMessage, dateOverride || null);

    const client = require('../bot/client');
    const channel = await client.channels.fetch(league.advance_channel_id);
    await channel.send(message);

    let threadCount = 0;
    if (league.user_channel_id) {
      const matchups = parseMatchups(message);
      if (matchups.length > 0) {
        const leagueUsers = getUsersInLeague(league.id);
        const teamMap = new Map(leagueUsers.map(u => [u.discord_id, u.team_name || u.discord_username]));
        const weekLabel = WEEK_LABELS[Number(week)] ?? `Week ${week}`;
        const userChannel = await client.channels.fetch(league.user_channel_id);

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

module.exports = router;
