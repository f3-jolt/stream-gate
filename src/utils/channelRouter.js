const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { parseStreamTitle } = require('./titleParser');
const {
  getUserByPlatform,
  getUserLeaguesByGuild,
  getLeagueByAbbr,
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
  const { isGOI, abbr } = parseStreamTitle(streamData.title);
  if (!isGOI) return;

  const user = getUserByPlatform(platform, platformUsername);
  if (!user) return;

  // Get all (guild → leagues) pairs for this user and route each guild independently
  const guildGroups = getUserLeaguesByGuild(user.discord_id);
  if (!guildGroups.length) return;

  for (const { guildId, leagues } of guildGroups) {
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

    const embed = buildStreamEmbed(user, league, platform, streamData);
    await channel.send({ embeds: [embed] });

    saveStreamPost(platform, streamData.id, user.discord_id, league.id);
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

module.exports = { routeStream, routeForGuild, postStreamToChannel, setClient };
