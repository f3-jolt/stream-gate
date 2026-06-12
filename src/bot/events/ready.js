const logger = require('../../utils/logger');
const { getAllPlatformUsers, getUserLeaguesByGuild, checkRecentStreamPostByTitle, getGuildSettings } = require('../../db/queries');
const { getActiveLiveStream, getChannelIdByHandle } = require('../../platforms/youtube/api');
const { getLiveStream } = require('../../platforms/twitch/api');
const { updateSubscriptionId, updatePlatformUserId } = require('../../db/queries');
const { postStreamToChannel } = require('../../utils/channelRouter');
const { parseStreamTitle } = require('../../utils/titleParser');

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info(`Bot online as ${client.user.tag}`);
    checkLiveAtStartup().catch(err =>
      logger.error('Startup live check failed', { error: err.message })
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

// Posts to leagues for the user on startup, applying the same keyword check as the normal
// WebSub path. Uses title-based dedup (not stream ID) so a restart catches an ongoing stream
// that was never posted, while still ignoring streams with no matching keyword.
async function postToAllLeagues(platform, platformUser, streamData) {
  const guildGroups = getUserLeaguesByGuild(platformUser.discord_id);
  if (!guildGroups.length) {
    logger.info('Startup: user has no leagues', { username: platformUser.platform_username });
    return;
  }

  for (const { guildId, leagues } of guildGroups) {
    const settings = getGuildSettings(guildId);
    const keyword = settings?.trigger_keyword || 'GOI';
    const { isMatch } = parseStreamTitle(streamData.title, keyword);
    if (!isMatch) {
      logger.info('Startup: title does not match keyword, skipping guild', {
        username: platformUser.platform_username, guildId, keyword, title: streamData.title,
      });
      continue;
    }

    for (const league of leagues) {
      if (checkRecentStreamPostByTitle(league.id, streamData.title)) {
        logger.info('Startup: stream already posted recently, skipping', {
          username: platformUser.platform_username,
          league: league.abbr,
          title: streamData.title,
        });
        continue;
      }

      const discordUser = {
        discord_id: platformUser.discord_id,
        discord_username: platformUser.discord_username,
      };

      logger.info('Startup: posting stream to league', { username: platformUser.platform_username, league: league.abbr });
      await postStreamToChannel(league, discordUser, platform, streamData);
    }
  }
}
