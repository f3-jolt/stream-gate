const { db } = require('../db/database');
const { getUserByPlatform, getUserLeagues, checkStreamPost } = require('../db/queries');
const { postStreamToChannel } = require('./channelRouter');
const logger = require('./logger');

const TWITCH_RE = /twitch\.tv\/([a-zA-Z0-9_]+)/i;
const YOUTUBE_RE = /youtube\.com\/watch\?(?:[^&\s]*&)*v=([a-zA-Z0-9_-]+)|youtu\.be\/([a-zA-Z0-9_-]+)|youtube\.com\/live\/([a-zA-Z0-9_-]+)/i;

// Processes a Discord message that may contain a Twitch or YouTube live stream link.
// If the link resolves to a registered, live streamer whose Discord ID matches the
// message author, deletes the message and posts the stream embed via the bot.
async function handleStreamLinkMessage(message, league) {
  const content = message.content;

  const twitchMatch = content.match(TWITCH_RE);
  const youtubeMatch = content.match(YOUTUBE_RE);

  if (!twitchMatch && !youtubeMatch) return;

  let platform, platformUsername, streamData, registeredUser;

  try {
    if (twitchMatch) {
      platformUsername = twitchMatch[1];
      registeredUser = getUserByPlatform('twitch', platformUsername);
      if (!registeredUser) return;
      if (registeredUser.discord_id !== message.author.id) return;

      const { getLiveStream } = require('../platforms/twitch/api');
      streamData = await getLiveStream(platformUsername);
      if (!streamData) return;
      platform = 'twitch';

    } else {
      const videoId = youtubeMatch[1] || youtubeMatch[2] || youtubeMatch[3];
      if (!videoId) return;

      const { checkIfLiveStream, getLiveStreamDetails } = require('../platforms/youtube/api');
      const isLive = await checkIfLiveStream(videoId);
      if (!isLive) return;

      streamData = await getLiveStreamDetails(videoId);
      if (!streamData) return;

      const row = db.prepare(
        "SELECT platform_username FROM user_platforms WHERE platform = 'youtube' AND platform_user_id = ?"
      ).get(streamData.channelId);
      if (!row) return;

      registeredUser = getUserByPlatform('youtube', row.platform_username);
      if (!registeredUser) return;
      if (registeredUser.discord_id !== message.author.id) return;

      platformUsername = row.platform_username;
      platform = 'youtube';
    }
  } catch (err) {
    logger.warn('Link handler: error resolving stream', { error: err.message, channel: message.channelId });
    return;
  }

  // Get user's league membership to populate team_abbrev for the embed
  const userLeagues = getUserLeagues(registeredUser.discord_id, league.guild_id);
  const memberLeague = userLeagues.find(l => l.id === league.id);
  if (!memberLeague) return;

  if (checkStreamPost(platform, streamData.id, memberLeague.id)) {
    logger.info('Link handler: stream already posted, skipping', { platform, streamId: streamData.id, leagueId: memberLeague.id });
    return;
  }

  try {
    await message.delete();
  } catch (err) {
    logger.warn('Link handler: failed to delete message', { error: err.message });
  }

  const discordUser = {
    discord_id: registeredUser.discord_id,
    discord_username: registeredUser.discord_username,
  };

  await postStreamToChannel(memberLeague, discordUser, platform, streamData);
}

module.exports = { handleStreamLinkMessage };
