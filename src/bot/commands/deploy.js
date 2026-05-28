// Register slash commands with Discord.
// Run once after adding or changing commands:
//   node src/bot/commands/deploy.js
//
// If GUILD_ID is set, deploys to that guild only (instant, good for dev).
// Without GUILD_ID, deploys globally (all servers, takes up to 1 hour to propagate).

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const commands = [];
const commandsDir = __dirname;
const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js') && f !== 'deploy.js');

for (const file of commandFiles) {
  const command = require(path.join(commandsDir, file));
  if (command.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const guildId = process.env.GUILD_ID;
    const route = guildId
      ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId)
      : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);

    const scope = guildId ? `guild ${guildId} (instant)` : 'global (up to 1 hour to propagate)';
    logger.info(`Deploying ${commands.length} slash commands — ${scope}`);

    await rest.put(route, { body: commands });

    logger.info('Commands deployed successfully');
  } catch (err) {
    logger.error('Command deployment failed', { error: err.message });
    process.exit(1);
  }
})();
