const logger = require('../../utils/logger');
const { getAllPlatformUsers, getUserLeaguesByGuild, checkRecentStreamPostByTitle, getGuildSettings, getAllLeaguesWithUserChannel, getAllLeaguesWithPpvChannel } = require('../../db/queries');
const { getActiveLiveStream, getChannelIdByHandle } = require('../../platforms/youtube/api');
const { getLiveStream } = require('../../platforms/twitch/api');
const { updateSubscriptionId, updatePlatformUserId } = require('../../db/queries');
const { routeForGuild } = require('../../utils/channelRouter');
const { parseStreamTitle } = require('../../utils/titleParser');
const { handleStreamLinkMessage } = require('../../utils/linkStreamHandler');

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info(`Bot online as ${client.user.tag}`);
    checkLiveAtStartup().catch(err =>
      logger.error('Startup live check failed', { error: err.message })
    );
    scanUserChannelsForLinks(client).catch(err =>
      logger.error('Startup user channel scan failed', { error: err.message })
    );
  },
};

async function checkLiveAtStartup() {
  logger.info('Running startup live stream check');

  const youtubeUsers = getAllPlatformUsers('youtube');
  logger.info('Startup: checking YouTube users', { count: youtubeUsers.length });

  for (const user of youtubeUsers) {
    try {
      let channelId = user.platform_user_id;

      if (!channelId) {
        logger.info('Startup: resolving channelId for user', { username: user.platform_username });
        channelId = await getChannelIdByHandle(user.platform_username);
        if (!channelId) {
          logger.warn('Startup: could not resolve YouTube channelId', { username: user.platform_username });
          continue;
        }
        updateSubscriptionId('youtube', user.platform_username, channelId);
        updatePlatformUserId('youtube', user.platform_username, channelId);
        logger.info('Startup: resolved YouTube channelId', { username: user.platform_username, channelId });
      }

      logger.info('Startup: checking for live stream', { username: user.platform_username, channelId });
      const streamData = await getActiveLiveStream(channelId);
      if (!streamData) {
        logger.info('Startup: no live stream found', { username: user.platform_username });
        continue;
      }

      logger.info('Startup: found live YouTube stream', { username: user.platform_username, title: streamData.title });
      await postToAllLeagues('youtube', user, streamData);
    } catch (err) {
      logger.error('Startup YouTube check error', { username: user.platform_username, error: err.message });
    }
  }

  const twitchUsers = getAllPlatformUsers('twitch');
  logger.info('Startup: checking Twitch users', { count: twitchUsers.length });

  for (const user of twitchUsers) {
    try {
      const streamData = await getLiveStream(user.platform_username);
      if (!streamData) {
        logger.info('Startup: no live Twitch stream', { username: user.platform_username });
        continue;
      }
      logger.info('Startup: found live Twitch stream', { username: user.platform_username, title: streamData.title });
      await postToAllLeagues('twitch', user, streamData);
    } catch (err) {
      logger.error('Startup Twitch check error', { username: user.platform_username, error: err.message });
    }
  }

  logger.info('Startup live stream check complete');
}

async function scanUserChannelsForLinks(client) {
  // Build a map of channelId → league, covering both user channels and PPV channels.
  // A league may have both; we scan each distinct channel independently so manual links
  // posted in either channel are picked up after a restart.
  const channelLeaguePairs = new Map(); // channelId → league

  for (const l of getAllLeaguesWithUserChannel()) {
    channelLeaguePairs.set(l.user_channel_id, l);
  }
  for (const l of getAllLeaguesWithPpvChannel()) {
    if (!channelLeaguePairs.has(l.ppv_channel_id)) {
      channelLeaguePairs.set(l.ppv_channel_id, l);
    }
  }

  if (!channelLeaguePairs.size) return;

  logger.info('Startup: scanning channels for recent stream links', { count: channelLeaguePairs.size });

  for (const [channelId, league] of channelLeaguePairs) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) continue;

      const messages = await channel.messages.fetch({ limit: 10 });
      const nonBot = messages.filter(m => !m.author.bot);

      for (const message of nonBot.values()) {
        await handleStreamLinkMessage(message, league);
      }
    } catch (err) {
      logger.warn('Startup: error scanning channel', { leagueId: league.id, channelId, error: err.message });
    }
  }

  logger.info('Startup: channel scan complete');
}

// Posts to leagues for the user on startup using the same keyword and abbr routing as the
// normal webhook path. Title-based dedup (not stream ID) is checked first so a restart catches
// an ongoing stream never posted, while still ignoring already-handled streams.
async function postToAllLeagues(platform, platformUser, streamData) {
  const guildGroups = getUserLeaguesByGuild(platformUser.discord_id);
  if (!guildGroups.length) {
    logger.info('Startup: user has no leagues', { username: platformUser.platform_username });
    return;
  }

  for (const { guildId, leagues } of guildGroups) {
    const settings = getGuildSettings(guildId);
    const keyword = settings?.trigger_keyword || 'GOI';
    const { isMatch, abbr } = parseStreamTitle(streamData.title, keyword);
    if (!isMatch) {
      logger.info('Startup: title does not match keyword, skipping guild', {
        username: platformUser.platform_username, guildId, keyword, title: streamData.title,
      });
      continue;
    }

    // Title-based dedup: if any league in this guild already has this stream posted recently,
    // skip the whole guild (stream ID may differ across restarts so we check by title).
    const alreadyPosted = leagues.some(l => checkRecentStreamPostByTitle(l.id, streamData.title));
    if (alreadyPosted) {
      logger.info('Startup: stream already posted recently, skipping guild', {
        username: platformUser.platform_username, guildId, title: streamData.title,
      });
      continue;
    }

    logger.info('Startup: routing stream for guild', { username: platformUser.platform_username, guildId, abbr });
    await routeForGuild(guildId, leagues, platformUser, platform, streamData, abbr);
  }
}
