const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),

  async execute(interaction) {
    const latency = Date.now() - interaction.createdTimestamp;
    await interaction.reply({ content: `Pong! Latency: ${latency}ms`, ephemeral: true });
  },
};
