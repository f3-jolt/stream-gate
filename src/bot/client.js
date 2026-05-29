const { Client, GatewayIntentBits, Collection } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ]
});

client.commands = new Collection();

client.on('error', err => {
  require('../utils/logger').error('Discord client error', { error: err.message });
});

module.exports = client;
