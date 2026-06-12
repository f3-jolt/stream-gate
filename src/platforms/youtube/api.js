const axios = require('axios');
const { getAllPlatformUsers, updateSubscriptionId, updatePlatformUserId } = require('../../db/queries');
const logger = require('../../utils/logger');

const YT_API = 'https://www.googleapis.com/youtube/v3';
const WEBSUB_HUB = 'https://pubsubhubbub.appspot.com/subscribe';

async function ytGet(path, params = {}) {
  const res = await axios.get(`${YT_API}${path}`, {
    params: { key: process.env.YOUTUBE_API_KEY, ...params },
  });
  return res.data;
}

async function getChannelIdByHandle(handle) {
  const search = handle.replace(/^@/, '');
  try {
    const data = await ytGet('/channels', { forHandle: `@${search}`, part: 'id' });
    if (data.items?.[0]) return data.items[0].id;
  } catch {
    // fallback: search by username
  }
  const data = await ytGet('/channels', { forUsername: search, part: 'id' });
  return data.items?.[0]?.id || null;
}

async function subscribeToChannel(channelId) {
  const params = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
    'hub.callback': `${process.env.PUBLIC_URL}/webhooks/youtube`,
    'hub.secret': process.env.YOUTUBE_WEBSUB_SECRET,
    'hub.lease_seconds': '864000',
  });
  await axios.post(WEBSUB_HUB, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function checkIfLiveStream(videoId) {
  const data = await ytGet('/videos', { id: videoId, part: 'snippet' });
  const video = data.items?.[0];
  if (!video) return false;
  return video.snippet.liveBroadcastContent === 'live';
}

async function getLiveStreamDetails(videoId) {
  const data = await ytGet('/videos', { id: videoId, part: 'snippet' });
  const video = data.items?.[0];
  if (!video) return null;
  return {
    id: videoId,
    title: video.snippet.title,
    channelId: video.snippet.channelId,
    channelTitle: video.snippet.channelTitle,
    videoId,
    url: `https://youtube.com/watch?v=${videoId}`,
    user_name: video.snippet.channelTitle,
    user_login: video.snippet.channelTitle,
  };
}

async function renewSubscriptions() {
  const users = getAllPlatformUsers('youtube');
  if (!users.length) return;

  // logger.info('Renewing YouTube WebSub subscriptions', { count: users.length });

  for (const user of users) {
    try {
      let channelId = user.platform_user_id;

      if (!channelId) {
        channelId = await getChannelIdByHandle(user.platform_username);
        if (!channelId) {
          logger.warn('YouTube channel not found', { handle: user.platform_username });
          continue;
        }
      }

      await subscribeToChannel(channelId);
      updateSubscriptionId('youtube', user.platform_username, channelId);
      updatePlatformUserId('youtube', user.platform_username, channelId);
      // logger.info('YouTube subscription renewed', { handle: user.platform_username, channelId });
    } catch (err) {
      logger.error('YouTube renewal error', { handle: user.platform_username, error: err.message });
    }
  }
}

async function getActiveLiveStream(channelId) {
  const data = await ytGet('/search', {
    channelId,
    part: 'snippet',
    type: 'video',
    eventType: 'live',
    maxResults: 1,
  });
  const item = data.items?.[0];
  if (!item) return null;
  const videoId = item.id.videoId;
  return {
    id: videoId,
    title: item.snippet.title,
    url: `https://youtube.com/watch?v=${videoId}`,
    user_login: item.snippet.channelTitle,
    user_name: item.snippet.channelTitle,
    videoId,
  };
}

module.exports = { getChannelIdByHandle, subscribeToChannel, checkIfLiveStream, getLiveStreamDetails, renewSubscriptions, getActiveLiveStream };
