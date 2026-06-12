const axios = require('axios');
const { getAllPlatformUsers, updateSubscriptionId } = require('../../db/queries');
const logger = require('../../utils/logger');

let _appAccessToken = null;
let _tokenExpiry = 0;

async function getAppAccessToken() {
  if (_appAccessToken && Date.now() < _tokenExpiry) return _appAccessToken;

  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    },
  });

  _appAccessToken = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _appAccessToken;
}

async function twitchApiGet(path, params = {}) {
  const token = await getAppAccessToken();
  const res = await axios.get(`https://api.twitch.tv/helix${path}`, {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
    params,
  });
  return res.data;
}

async function getTwitchUserByUsername(username) {
  const data = await twitchApiGet('/users', { login: username.toLowerCase() });
  return data.data?.[0] || null;
}

async function subscribeToStreamOnline(twitchUserId) {
  const token = await getAppAccessToken();
  const res = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
    type: 'stream.online',
    version: '1',
    condition: { broadcaster_user_id: twitchUserId },
    transport: {
      method: 'webhook',
      callback: `${process.env.PUBLIC_URL}/webhooks/twitch`,
      secret: process.env.TWITCH_WEBHOOK_SECRET,
    },
  }, {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data.data?.[0];
}

async function deleteSubscription(subscriptionId) {
  const token = await getAppAccessToken();
  await axios.delete('https://api.twitch.tv/helix/eventsub/subscriptions', {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
    params: { id: subscriptionId },
  });
}

async function getExistingSubscriptions() {
  const data = await twitchApiGet('/eventsub/subscriptions', { type: 'stream.online' });
  return data.data || [];
}

async function syncSubscriptions() {
  const users = getAllPlatformUsers('twitch');
  if (!users.length) return;

  logger.info('Syncing Twitch subscriptions', { count: users.length });

  const existing = await getExistingSubscriptions();
  const existingByUserId = new Map(existing.map(s => [s.condition.broadcaster_user_id, s]));

  for (const user of users) {
    try {
      let platformUserId = user.platform_user_id;

      if (!platformUserId) {
        const twitchUser = await getTwitchUserByUsername(user.platform_username);
        if (!twitchUser) {
          logger.warn('Twitch user not found', { username: user.platform_username });
          continue;
        }
        platformUserId = twitchUser.id;
        updateSubscriptionId('twitch', user.platform_username, null);
      }

      if (existingByUserId.has(platformUserId)) {
        const sub = existingByUserId.get(platformUserId);
        updateSubscriptionId('twitch', user.platform_username, sub.id);
        logger.info('Twitch sub already active', { username: user.platform_username, subId: sub.id });
      } else {
        const sub = await subscribeToStreamOnline(platformUserId);
        updateSubscriptionId('twitch', user.platform_username, sub.id);
        logger.info('Twitch sub created', { username: user.platform_username, subId: sub.id });
      }
    } catch (err) {
      logger.error('Twitch sync error', { username: user.platform_username, error: err.message });
    }
  }
}

async function getTwitchVideo(videoId) {
  const data = await twitchApiGet('/videos', { id: videoId });
  const v = data.data?.[0];
  if (!v) return null;
  return {
    id: `vod-${v.id}`,
    title: v.title,
    url: v.url,
    user_login: v.user_login,
    user_name: v.user_name,
    videoId: null,
  };
}

async function getLiveStream(username) {
  const data = await twitchApiGet('/streams', { user_login: username.toLowerCase() });
  const stream = data.data?.[0];
  if (!stream) return null;
  return {
    id: stream.id,
    title: stream.title,
    url: `https://twitch.tv/${stream.user_login}`,
    user_login: stream.user_login,
    user_name: stream.user_name,
    videoId: null,
  };
}

module.exports = { getAppAccessToken, getTwitchUserByUsername, getTwitchVideo, subscribeToStreamOnline, deleteSubscription, syncSubscriptions, getLiveStream, twitchApiGet };
