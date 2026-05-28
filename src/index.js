require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const client = require('./bot/client');
const { initSchema } = require('./db/database');
const { setClient } = require('./utils/channelRouter');
const { registerTwitchWebhook } = require('./platforms/twitch/eventsub');
const { registerYouTubeWebhook } = require('./platforms/youtube/websub');
const { clearExpiredPendingRoutes } = require('./db/queries');
const logger = require('./utils/logger');

// ── Express + raw body capture (required for HMAC verification) ───────────────
const app = express();
app.use((req, res, next) => {
  let data = [];
  req.on('data', chunk => data.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(data);
    try { req.body = JSON.parse(req.rawBody.toString()); } catch { req.body = {}; }
    next();
  });
});

registerTwitchWebhook(app);
registerYouTubeWebhook(app);

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Load slash commands ───────────────────────────────────────────────────────
const commandsDir = path.join(__dirname, 'bot', 'commands');
for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js') && f !== 'deploy.js')) {
  const command = require(path.join(commandsDir, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

// ── Load events ───────────────────────────────────────────────────────────────
const eventsDir = path.join(__dirname, 'bot', 'events');
for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.js'))) {
  const event = require(path.join(eventsDir, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  initSchema();
  setClient(client);

  const port = process.env.PORT || 3000;
  app.listen(port, () => logger.info(`Webhook server listening on port ${port}`));

  if (!process.env.DISCORD_TOKEN) {
    logger.warn('DISCORD_TOKEN not set — bot will not connect to Discord');
    return;
  }

  await client.login(process.env.DISCORD_TOKEN);

  // Sync platform subscriptions once the bot is ready
  client.once('clientReady', async () => {
    try {
      if (process.env.TWITCH_CLIENT_ID) {
        const { syncSubscriptions } = require('./platforms/twitch/api');
        await syncSubscriptions();
      }
      if (process.env.YOUTUBE_API_KEY) {
        const { renewSubscriptions } = require('./platforms/youtube/api');
        await renewSubscriptions();
      }
    } catch (err) {
      logger.error('Subscription sync error on startup', { error: err.message });
    }
  });
}

// Daily at 03:00: renew YouTube WebSub subscriptions + purge expired pending routes
cron.schedule('0 3 * * *', async () => {
  try {
    if (process.env.YOUTUBE_API_KEY) {
      const { renewSubscriptions } = require('./platforms/youtube/api');
      await renewSubscriptions();
    }
    clearExpiredPendingRoutes();
    logger.info('Daily maintenance complete');
  } catch (err) {
    logger.error('Daily maintenance error', { error: err.message });
  }
});

start().catch(err => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
