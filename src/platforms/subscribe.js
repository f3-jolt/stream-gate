const logger = require('../utils/logger');

// Create the platform subscription for a newly added/edited user immediately,
// instead of waiting for the next startup sync or daily renewal.
//
// Never throws: a subscription hiccup must not fail user registration, and the
// startup sync (Twitch) / daily renewal (YouTube) remain a backstop.
async function ensureSubscription(platform, username) {
  try {
    if (platform === 'twitch' && process.env.TWITCH_CLIENT_ID) {
      const { subscribeTwitchUser } = require('./twitch/api');
      const subId = await subscribeTwitchUser(username);
      if (subId) logger.info('Twitch subscription created on add', { username, subId });
    } else if (platform === 'youtube' && process.env.YOUTUBE_API_KEY) {
      const { subscribeYoutubeUser } = require('./youtube/api');
      const channelId = await subscribeYoutubeUser(username);
      if (channelId) logger.info('YouTube subscription created on add', { username, channelId });
    }
  } catch (err) {
    logger.error('Immediate subscription failed, deferred to sync/renewal', {
      platform, username, error: err.message,
    });
  }
}

module.exports = { ensureSubscription };
