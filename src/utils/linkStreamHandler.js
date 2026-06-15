const { db } = require('../db/database');
const { getUserByPlatform, getUserLeagues, checkStreamPost } = require('../db/queries');
const { postStreamToChannel } = require('./channelRouter');
const logger = require('./logger');

const TWITCH_VOD_RE = /twitch\.tv\/videos\/(\d+)/i;
const TWITCH_RE = /twitch\.tv\/([a-zA-Z0-9_]+)/i;
const YOUTUBE_HANDLE_LIVE_RE = /youtube\.com\/(@?[a-zA-Z0-9_.-]+)\/live/i;
const YOUTUBE_RE = /youtube\.com\/watch\?(?:[^&\s]*&)*v=([a-zA-Z0-9_-]+)|youtu\.be\/([a-zA-Z0-9_-]+)|youtube\.com\/live\/([a-zA-Z0-9_-]+)/i;

// Returns true if the message content contains any recognized Twitch/YouTube
// stream link. Used to decide whether a skip is worth logging.
function containsStreamLink(content) {
  return TWITCH_VOD_RE.test(content) || TWITCH_RE.test(content)
    || YOUTUBE_HANDLE_LIVE_RE.test(content) || YOUTUBE_RE.test(content);
}

// Emits a consistent, greppable log line whenever a matched stream link is
// dropped before being posted, so silent skips are diagnosable from the logs.
function logSkip(reason, message, extra = {}) {
  logger.info('Link skipped', {
    reason,
    channel: message.channelId,
    guild: message.guild?.id,
    authorId: message.author.id,
    ...extra,
  });
}

// Processes a Discord message that may contain a Twitch or YouTube live stream link.
// If the link resolves to a registered, live streamer whose Discord ID matches the
// message author, deletes the message and posts the stream embed via the bot.
async function handleStreamLinkMessage(message, league) {
  const content = message.content;

  const twitchVodMatch = content.match(TWITCH_VOD_RE);
  const twitchMatch = !twitchVodMatch && content.match(TWITCH_RE);
  const youtubeHandleLiveMatch = content.match(YOUTUBE_HANDLE_LIVE_RE);
  const youtubeMatch = !youtubeHandleLiveMatch && content.match(YOUTUBE_RE);

  if (!twitchVodMatch && !twitchMatch && !youtubeHandleLiveMatch && !youtubeMatch) return;

  let platform, platformUsername, streamData, registeredUser;

  try {
    if (twitchVodMatch) {
      platform = 'twitch';
      const vodId = twitchVodMatch[1];
      const { getTwitchVideo } = require('../platforms/twitch/api');
      streamData = await getTwitchVideo(vodId);
      if (!streamData) { logSkip('twitch_vod_not_found', message, { platform, vodId }); return; }

      platformUsername = streamData.user_login;
      registeredUser = getUserByPlatform('twitch', platformUsername);
      if (!registeredUser) { logSkip('user_not_registered', message, { platform, platformUsername }); return; }
      if (registeredUser.discord_id !== message.author.id) {
        logSkip('discord_id_mismatch', message, { platform, platformUsername, registeredDiscordId: registeredUser.discord_id });
        return;
      }

    } else if (twitchMatch) {
      platform = 'twitch';
      platformUsername = twitchMatch[1];
      registeredUser = getUserByPlatform('twitch', platformUsername);
      if (!registeredUser) { logSkip('user_not_registered', message, { platform, platformUsername }); return; }
      if (registeredUser.discord_id !== message.author.id) {
        logSkip('discord_id_mismatch', message, { platform, platformUsername, registeredDiscordId: registeredUser.discord_id });
        return;
      }

      const { getLiveStream, getTwitchUserByUsername } = require('../platforms/twitch/api');
      streamData = await getLiveStream(platformUsername);
      if (!streamData) {
        const twitchUser = await getTwitchUserByUsername(platformUsername);
        streamData = {
          id: `manual-${platformUsername}`,
          title: twitchUser ? `${twitchUser.display_name} is live!` : `${platformUsername} is live!`,
          user_name: twitchUser?.display_name || platformUsername,
          user_login: platformUsername,
          videoId: null,
        };
      }

    } else if (youtubeHandleLiveMatch) {
      platform = 'youtube';
      const handle = youtubeHandleLiveMatch[1];
      const { getChannelIdByHandle, getActiveLiveStream } = require('../platforms/youtube/api');
      const channelId = await getChannelIdByHandle(handle);
      if (!channelId) { logSkip('youtube_channel_not_found', message, { platform, handle }); return; }

      streamData = await getActiveLiveStream(channelId);
      if (!streamData) { logSkip('stream_not_live', message, { platform, channelId }); return; }
      streamData.channelId = channelId;

      const row = db.prepare(
        "SELECT platform_username FROM user_platforms WHERE platform = 'youtube' AND platform_user_id = ?"
      ).get(channelId);
      if (!row) { logSkip('youtube_channel_not_linked', message, { platform, channelId }); return; }

      platformUsername = row.platform_username;
      registeredUser = getUserByPlatform('youtube', platformUsername);
      if (!registeredUser) { logSkip('user_not_registered', message, { platform, platformUsername }); return; }
      if (registeredUser.discord_id !== message.author.id) {
        logSkip('discord_id_mismatch', message, { platform, platformUsername, registeredDiscordId: registeredUser.discord_id });
        return;
      }

    } else {
      platform = 'youtube';
      const videoId = youtubeMatch[1] || youtubeMatch[2] || youtubeMatch[3];
      if (!videoId) { logSkip('youtube_no_video_id', message, { platform }); return; }

      const { getLiveStreamDetails } = require('../platforms/youtube/api');
      streamData = await getLiveStreamDetails(videoId);
      if (!streamData) { logSkip('stream_not_live', message, { platform, videoId }); return; }

      const row = db.prepare(
        "SELECT platform_username FROM user_platforms WHERE platform = 'youtube' AND platform_user_id = ?"
      ).get(streamData.channelId);
      if (!row) { logSkip('youtube_channel_not_linked', message, { platform, channelId: streamData.channelId }); return; }

      platformUsername = row.platform_username;
      registeredUser = getUserByPlatform('youtube', platformUsername);
      if (!registeredUser) { logSkip('user_not_registered', message, { platform, platformUsername }); return; }
      if (registeredUser.discord_id !== message.author.id) {
        logSkip('discord_id_mismatch', message, { platform, platformUsername, registeredDiscordId: registeredUser.discord_id });
        return;
      }
    }
  } catch (err) {
    logger.warn('Link handler: error resolving stream', { reason: 'resolve_error', error: err.message, platform, platformUsername, channel: message.channelId });
    return;
  }

  // Get user's league membership to populate team_abbrev for the embed
  const userLeagues = getUserLeagues(registeredUser.discord_id, league.guild_id);
  const memberLeague = userLeagues.find(l => l.id === league.id);
  if (!memberLeague) { logSkip('not_league_member', message, { platform, platformUsername, leagueId: league.id }); return; }

  if (checkStreamPost(platform, streamData.id, memberLeague.id)) {
    logSkip('already_posted', message, { platform, streamId: streamData.id, leagueId: memberLeague.id });
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

module.exports = { handleStreamLinkMessage, containsStreamLink };
