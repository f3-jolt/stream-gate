const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserLeagues, getUserPlatforms } = require('../../db/queries');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('View your StreamGate registration for this server'),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const platforms = getUserPlatforms(interaction.user.id);
    const leagues = getUserLeagues(interaction.user.id, interaction.guildId);

    if (!platforms.length && !leagues.length) {
      return interaction.editReply('You are not registered. Use `/register` to get started.');
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
        ? leagues.map(l => {
            const team = l.team_name ? ` — ${l.team_name}` : '';
            return `**${l.name}** \`${l.abbr}\`${team}`;
          }).join('\n')
        : 'None',
    });

    await interaction.editReply({ embeds: [embed] });
  },
};
