const crypto = require('crypto');
const { routeStream } = require('../../utils/channelRouter');
const logger = require('../../utils/logger');

const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const TWITCH_MESSAGE_TYPE = 'twitch-eventsub-message-type';

function verifySignature(req) {
  const messageId = req.headers[TWITCH_MESSAGE_ID];
  const timestamp = req.headers[TWITCH_MESSAGE_TIMESTAMP];
  const signature = req.headers[TWITCH_MESSAGE_SIGNATURE];

  if (!messageId || !timestamp || !signature) return false;

  const hmacMessage = messageId + timestamp + req.rawBody;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.TWITCH_WEBHOOK_SECRET)
    .update(hmacMessage)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function registerTwitchWebhook(app) {
  app.post('/webhooks/twitch', (req, res) => {
    try {
      if (!verifySignature(req)) {
        logger.warn('Twitch webhook: invalid signature');
        return res.sendStatus(403);
      }

      const messageType = req.headers[TWITCH_MESSAGE_TYPE];

      if (messageType === 'webhook_callback_verification') {
        logger.info('Twitch webhook verification challenge received');
        return res.status(200).type('text/plain').send(req.body.challenge);
      }

      if (messageType === 'revocation') {
        const sub = req.body.subscription;
        logger.warn('Twitch subscription revoked', { type: sub.type, reason: sub.status });
        return res.sendStatus(204);
      }

      if (messageType === 'notification') {
        const { subscription, event } = req.body;
        res.sendStatus(204); // Respond immediately before async work

        if (subscription.type === 'stream.online') {
          handleStreamOnline(event).catch(err =>
            logger.error('Twitch stream.online handler error', { error: err.message })
          );
        }
        return;
      }

      res.sendStatus(204);
    } catch (err) {
      logger.error('Twitch webhook error', { error: err.message });
      res.sendStatus(500);
    }
  });
}

async function handleStreamOnline(event) {
  logger.info('Twitch stream.online', {
    user: event.broadcaster_user_login,
    userId: event.broadcaster_user_id,
  });

  // Fetch current stream data for the title (EventSub stream.online doesn't include title)
  const { twitchApiGet } = require('./api');
  let streamData;
  try {
    const data = await twitchApiGet('/streams', { user_id: event.broadcaster_user_id });
    const stream = data.data?.[0];
    if (!stream) {
      logger.warn('Twitch stream not found after online event', { userId: event.broadcaster_user_id });
      return;
    }
    streamData = {
      id: stream.id,
      title: stream.title,
      user_login: stream.user_login,
      user_name: stream.user_name,
      url: `https://twitch.tv/${stream.user_login}`,
    };
  } catch (err) {
    logger.error('Failed to fetch Twitch stream details', { error: err.message });
    return;
  }

  await routeStream('twitch', event.broadcaster_user_login, streamData);
}

module.exports = { registerTwitchWebhook };
