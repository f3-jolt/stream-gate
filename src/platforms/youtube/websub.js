const crypto = require('crypto');
const xml2js = require('xml2js');
const { checkIfLiveStream, getLiveStreamDetails } = require('./api');
const { routeStream } = require('../../utils/channelRouter');
const { getUserByPlatform } = require('../../db/queries');
const logger = require('../../utils/logger');

function verifySignature(req) {
  const signature = req.headers['x-hub-signature'];
  if (!signature) return false;

  const [algo, hash] = signature.split('=');
  const expected = crypto
    .createHmac(algo, process.env.YOUTUBE_WEBSUB_SECRET)
    .update(req.rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
}

function registerYouTubeWebhook(app) {
  // Subscription verification challenge (GET)
  app.get('/webhooks/youtube', (req, res) => {
    const { 'hub.mode': mode, 'hub.topic': topic, 'hub.challenge': challenge } = req.query;

    if (mode === 'subscribe' && challenge) {
      // logger.info('YouTube WebSub verification', { topic });
      return res.status(200).type('text/plain').send(challenge);
    }

    res.sendStatus(400);
  });

  // Notification (POST)
  app.post('/webhooks/youtube', async (req, res) => {
    try {
      if (!verifySignature(req)) {
        logger.warn('YouTube WebSub: invalid signature');
        return res.sendStatus(403);
      }

      res.sendStatus(204); // Ack immediately

      handleYouTubeNotification(req.rawBody).catch(err =>
        logger.error('YouTube notification handler error', { error: err.message })
      );
    } catch (err) {
      logger.error('YouTube WebSub error', { error: err.message });
      res.sendStatus(500);
    }
  });
}

async function handleYouTubeNotification(rawBody) {
  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(rawBody.toString(), { explicitArray: false });
  } catch (err) {
    logger.error('Failed to parse YouTube XML', { error: err.message });
    return;
  }

  const entry = parsed?.feed?.entry;
  if (!entry) return; // Deletion notification or empty feed

  const videoId = entry['yt:videoId'];
  const channelId = entry['yt:channelId'];

  if (!videoId || !channelId) return;

  logger.info('YouTube WebSub notification', { videoId, channelId });

  let isLive = await checkIfLiveStream(videoId);
  if (!isLive) {
    // YouTube notifies before the stream status flips — retry for up to 5 minutes
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 60_000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      logger.info('YouTube retry live check', { videoId, attempt });
      isLive = await checkIfLiveStream(videoId);
      if (isLive) break;
    }
  }

  if (!isLive) {
    logger.info('YouTube video is not live after retries, ignoring', { videoId });
    return;
  }

  const streamData = await getLiveStreamDetails(videoId);
  if (!streamData) return;

  // Find the registered user by channel ID (stored as platform_user_id)
  const { db } = require('../../db/database');
  const platform_row = db.prepare(`
    SELECT up.platform_username
    FROM user_platforms up
    WHERE up.platform = 'youtube' AND up.platform_user_id = ?
  `).get(channelId);

  if (!platform_row) {
    logger.info('YouTube channel not registered, ignoring', { channelId });
    return;
  }

  await routeStream('youtube', platform_row.platform_username, streamData);
}

module.exports = { registerYouTubeWebhook };
