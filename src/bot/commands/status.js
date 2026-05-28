const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserLeagues, getUserPlatforms } = require('../../db/queries');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('View your StreamGate registration for this server'),

  async execute(interaction) {
    const platforms = getUserPlatforms(interaction.user.id);
    const leagues = getUserLeagues(interaction.user.id, interaction.guildId);

    if (!platforms.length && !leagues.length) {
      return interaction.reply({
        content: 'You are not registered. Use `/register` to get started.',
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('Your StreamGate Registration')
      .setColor(0x5865F2)
      .setTimestamp();

    embed.addFields({
      name: 'Linked Platforms',
      value: platforms.length
        ? platforms.map(p => `**${p.platform}**: ${p.platform_username}`).join('\n')
        : 'None',
    });

    embed.addFields({
      name: `Leagues in ${interaction.guild.name}`,
      value: leagues.length
        ? leagues.map(l => `**${l.abbr}** — ${l.name}`).join('\n')
        : 'None',
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
