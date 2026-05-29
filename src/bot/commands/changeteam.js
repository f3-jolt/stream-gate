const { SlashCommandBuilder } = require('discord.js');
const { getUserLeagues, addUserToLeague } = require('../../db/queries');
const { searchTeams, getTeamByAbbrev } = require('../../utils/teams');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('changeteam')
    .setDescription('Change your team assignment for a league')
    .addStringOption(opt =>
      opt.setName('league')
        .setDescription('League to update your team in')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('team')
        .setDescription('Your new team')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'team') {
      return interaction.respond(searchTeams(focused.value));
    }

    // league — only show leagues the user is already in
    const leagues = getUserLeagues(interaction.user.id, interaction.guildId);
    const query = focused.value.toUpperCase();
    const choices = leagues
      .filter(l => l.abbr.includes(query) || l.name.toUpperCase().includes(query))
      .slice(0, 25)
      .map(l => {
        const current = l.team_name ? ` (currently ${l.team_name})` : '';
        return { name: `${l.abbr} — ${l.name}${current}`, value: l.abbr };
      });
    await interaction.respond(choices);
  },

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const leagueAbbr = interaction.options.getString('league').toUpperCase();
    const teamAbbrev = interaction.options.getString('team').toUpperCase();

    const leagues = getUserLeagues(interaction.user.id, interaction.guildId);
    const league = leagues.find(l => l.abbr === leagueAbbr);
    if (!league) {
      return interaction.editReply({ content: `You are not registered in league **${leagueAbbr}**.` });
    }

    const team = getTeamByAbbrev(teamAbbrev);
    if (!team) {
      return interaction.editReply({ content: `Team **${teamAbbrev}** not found. Use autocomplete to pick a valid team.` });
    }

    addUserToLeague(interaction.user.id, league.id, 'self', team.name, team.abbrev);

    logger.info('User changed team', {
      discordId: interaction.user.id,
      guildId: interaction.guildId,
      league: league.abbr,
      team: team.abbrev,
    });

    await interaction.editReply({
      content: `Updated! Your team in **${league.name}** is now **${team.name}**.`,
    });
  },
};
