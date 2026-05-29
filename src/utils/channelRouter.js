const path = require('path');
const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { parseStreamTitle } = require('./titleParser');
const { getTeamByAbbrev } = require('./teams');
const {
  getUserByPlatform,
  getUserLeaguesByGuild,
  getLeagueByAbbr,
  getGuildSettings,
  checkStreamPost,
  saveStreamPost,
  savePendingRoute,
} = require('../db/queries');
const logger = require('./logger');

let _client = null;

function setClient(client) {
  _client = client;
}

async function routeStream(platform, platformUsername, streamData) {
  const user = getUserByPlatform(platform, platformUsername);
  if (!user) return;

  const guildGroups = getUserLeaguesByGuild(user.discord_id);
  if (!guildGroups.length) return;

  for (const { guildId, leagues } of guildGroups) {
    const settings = getGuildSettings(guildId);
    const keyword = settings?.trigger_keyword || 'GOI';
    const { isMatch, abbr } = parseStreamTitle(streamData.title, keyword);
    if (!isMatch) continue;
    await routeForGuild(guildId, leagues, user, platform, streamData, abbr);
  }
}

async function routeForGuild(guildId, leagues, user, platform, streamData, abbr) {
  let targetLeague = null;

  if (abbr) {
    // Match the abbreviation against leagues in THIS guild only
    targetLeague = leagues.find(l => l.abbr === abbr.toUpperCase()) || null;
  }

  if (!targetLeague && leagues.length === 1) {
    targetLeague = leagues[0];
  }

  if (!targetLeague) {
    // Multiple leagues in this guild, no valid abbr — DM the user for this guild
    await sendDisambiguationDM(user.discord_id, guildId, leagues, platform, streamData);
    return;
  }

  if (checkStreamPost(platform, streamData.id, targetLeague.id)) {
    logger.info('Stream already posted to this league, skipping', { platform, streamId: streamData.id, leagueId: targetLeague.id });
    return;
  }

  await postStreamToChannel(targetLeague, user, platform, streamData);
}

async function postStreamToChannel(league, user, platform, streamData) {
  try {
    const channel = await _client.channels.fetch(league.ppv_channel_id);
    if (!channel) {
      logger.error('PPV channel not found', { leagueId: league.id, channelId: league.ppv_channel_id });
      return;
    }

    const teamAbbrev = league.team_abbrev || null;
    const team = teamAbbrev ? getTeamByAbbrev(teamAbbrev) : null;
    const { embed, files } = buildStreamEmbed(user, league, platform, streamData, team);
    const content = league.ping_role_id ? `<@&${league.ping_role_id}>` : undefined;
    await channel.send({ content, embeds: [embed], files });

    saveStreamPost(platform, streamData.id, user.discord_id, league.id, streamData.title);
    logger.info('Stream posted', {
      platform,
      user: user.discord_username,
      league: league.abbr,
      guild: league.guild_id,
      channel: channel.name,
    });
  } catch (err) {
    logger.error('Failed to post stream to channel', { error: err.message });
  }
}

async function sendDisambiguationDM(discordUserId, guildId, leagues, platform, streamData) {
  try {
    savePendingRoute(discordUserId, guildId, platform, streamData.id, streamData.url, streamData.title);

    // Resolve guild name for the button labels so the user knows which server each button belongs to
    let guildName = guildId;
    try {
      const guild = await _client.guilds.fetch(guildId);
      guildName = guild.name;
    } catch {
      // non-fatal
    }

    // customId encodes guildId so interactionCreate can look up the right pending record
    // format: route_<guildId>_<leagueId>_<streamId>
    const buttons = leagues.map(league =>
      new ButtonBuilder()
        .setCustomId(`route_${guildId}_${league.id}_${streamData.id}`)
        .setLabel(leagues.length > 1 ? `${league.abbr} — ${guildName}` : league.name)
        .setStyle(ButtonStyle.Primary)
    );

    // Discord limits 5 buttons per row, 5 rows max (25 total)
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    const discordUser = await _client.users.fetch(discordUserId);
    await discordUser.send({
      content: `Your stream **"${streamData.title}"** is live on **${guildName}**! Which league should it be posted to?`,
      components: rows,
    });

    logger.info('Disambiguation DM sent', { discordUserId, guildId, leagues: leagues.map(l => l.abbr) });
  } catch (err) {
    logger.error('Failed to send disambiguation DM', { error: err.message, discordUserId, guildId });
  }
}

function buildStreamEmbed(user, league, platform, streamData, team = null) {
  const streamUrl = platform === 'twitch'
    ? `https://twitch.tv/${streamData.user_login}`
    : `https://youtube.com/watch?v=${streamData.videoId}`;

  const platformColor = platform === 'twitch' ? 0x6441a5 : 0xFF0000;
  const platformLabel = platform === 'twitch' ? 'Twitch' : 'YouTube';

  const embedColor = team?.colors?.[0]
    ? parseInt(team.colors[0].replace('#', ''), 16)
    : platformColor;

  const fields = [
    { name: 'League', value: league.name, inline: true },
    { name: 'Platform', value: platformLabel, inline: true },
  ];

  const files = [];
  const title = team?.name
    ? `${team.name} is streaming their game!`
    : `${streamData.user_name} is LIVE on ${platformLabel}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(streamUrl)
    .setDescription(streamData.title)
    .addFields(fields)
    .setColor(embedColor)
    .setTimestamp();

  if (team?.pic) {
    const logoPath = path.resolve(process.cwd(), team.pic.replace(/^\.\//, ''));
    const attachment = new AttachmentBuilder(logoPath, { name: 'team-logo.png' });
    embed.setThumbnail('attachment://team-logo.png');
    files.push(attachment);
  }

  return { embed, files };
}

module.exports = { routeStream, routeForGuild, postStreamToChannel, setClient };
