const { SlashCommandBuilder } = require('discord.js');
const {
  getOrCreateUser,
  getAllLeagues,
  getLeagueByAbbr,
  addUserToLeague,
  addUserPlatform,
} = require('../../db/queries');
const { searchTeams, getTeamByAbbrev } = require('../../utils/teams');
const logger = require('../../utils/logger');

async function userCanAccessLeague(member, league) {
  if (!league.category_id) return true;
  const category = await member.guild.channels.fetch(league.category_id).catch(() => null);
  if (!category) return false;
  return category.permissionsFor(member).has('ViewChannel');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register your stream account for a league')
    .addStringOption(opt =>
      opt.setName('platform')
        .setDescription('Streaming platform')
        .setRequired(true)
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' }
        )
    )
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('Your Twitch login or YouTube handle (@handle or channel name)')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('league')
        .setDescription('League to join')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('team')
        .setDescription('Your team (e.g. Alabama, Ohio State)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'team') {
      return interaction.respond(searchTeams(focused.value));
    }

    const query = focused.value.toUpperCase();
    const leagues = getAllLeagues(interaction.guildId);
    const choices = leagues
      .filter(l => l.abbr.includes(query) || l.name.toUpperCase().includes(query))
      .slice(0, 25)
      .map(l => ({ name: `${l.abbr} — ${l.name}`, value: l.abbr }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username').replace(/^@/, '');
    const leagueAbbr = interaction.options.getString('league').toUpperCase();
    const teamAbbrev = interaction.options.getString('team').toUpperCase();

    const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
    if (!league) {
      return interaction.reply({
        content: `League **${leagueAbbr}** not found. Use autocomplete to pick a valid league.`,
        flags: 64,
      });
    }

    const team = getTeamByAbbrev(teamAbbrev);
    if (!team) {
      return interaction.reply({
        content: `Team **${teamAbbrev}** not found. Use autocomplete to pick a valid team.`,
        flags: 64,
      });
    }

    const canAccess = await userCanAccessLeague(interaction.member, league);
    if (!canAccess) {
      return interaction.reply({
        content: `You don't have access to the **${league.name}** league.`,
        flags: 64,
      });
    }

    await interaction.deferReply({ flags: 64 });

    try {
      getOrCreateUser(interaction.user.id, interaction.user.username);
      addUserPlatform(interaction.user.id, platform, username, null);
      addUserToLeague(interaction.user.id, league.id, 'self', team.name, team.abbrev);

      if (platform === 'youtube' && process.env.YOUTUBE_API_KEY) {
        const { getChannelIdByHandle, subscribeToChannel } = require('../../platforms/youtube/api');
        const { updateSubscriptionId, updatePlatformUserId } = require('../../db/queries');
        const channelId = await getChannelIdByHandle(username);
        if (channelId) {
          await subscribeToChannel(channelId);
          updateSubscriptionId('youtube', username, channelId);
          updatePlatformUserId('youtube', username, channelId);
          logger.info('YouTube subscription created on self-register', { username, channelId });
        }
      }

      logger.info('User self-registered', {
        discordId: interaction.user.id,
        guildId: interaction.guildId,
        platform,
        username,
        league: league.abbr,
      });

      await interaction.editReply({
        content: `Registered! Your **${platform}** account \`${username}\` is now linked to the **${league.name}** league as **${team.name}**.`,
      });
    } catch (err) {
      logger.error('Registration error', { error: err.message, discordId: interaction.user.id });
      await interaction.editReply({ content: 'Registration failed. Please try again.' });
    }
  },
};
