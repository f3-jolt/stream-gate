const logger = require('../../utils/logger');
const { getPendingRoute, clearPendingRoute, checkStreamPost, getLeagueById, getUserLeagues } = require('../../db/queries');
const { postStreamToChannel } = require('../../utils/channelRouter');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction);
      } catch (err) {
        if (err.code === 10062) return; // Interaction expired — nothing to reply to
        logger.error('Command error', { command: interaction.commandName, error: err.message });
        try {
          const reply = { content: 'An error occurred running that command.', flags: 64 };
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply);
          } else {
            await interaction.reply(reply);
          }
        } catch {
          // Interaction expired between the command error and this fallback — safe to ignore
        }
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch (err) {
          if (err.code !== 10062) {
            logger.error('Autocomplete error', { command: interaction.commandName, error: err.message });
          }
        }
      }
      return;
    }

    // Modal submits: results:record:* → the /results command's modal handler
    if (interaction.isModalSubmit() && interaction.customId.startsWith('results:')) {
      const command = interaction.client.commands.get('results');
      if (command?.handleModal) {
        try {
          await command.handleModal(interaction);
        } catch (err) {
          if (err.code === 10062) return;
          logger.error('Modal submit error', { customId: interaction.customId, error: err.message });
          try { await interaction.reply({ content: 'An error occurred saving that result.', flags: 64 }); } catch { /* expired */ }
        }
      }
      return;
    }

    // Disambiguation buttons: route_<guildId>_<leagueId>_<streamId>
    if (interaction.isButton() && interaction.customId.startsWith('route_')) {
      await handleRouteButton(interaction);
    }
  },
};

async function handleRouteButton(interaction) {
  await interaction.deferUpdate();

  // customId format: route_<guildId>_<leagueId>_<streamId>
  // guildId can contain underscores (Snowflakes don't, but safe to split from the right)
  const withoutPrefix = interaction.customId.slice('route_'.length);
  const firstUnderscore = withoutPrefix.indexOf('_');
  const secondUnderscore = withoutPrefix.indexOf('_', firstUnderscore + 1);
  const guildId = withoutPrefix.slice(0, firstUnderscore);
  const leagueId = parseInt(withoutPrefix.slice(firstUnderscore + 1, secondUnderscore), 10);
  const streamId = withoutPrefix.slice(secondUnderscore + 1);

  const pending = getPendingRoute(interaction.user.id, guildId);

  if (!pending) {
    await interaction.editReply({
      content: 'This routing request has expired. Go live again to trigger a new one.',
      components: [],
    });
    return;
  }

  const baseLeague = getLeagueById(leagueId);
  if (!baseLeague) {
    await interaction.editReply({ content: 'League not found.', components: [] });
    return;
  }
  // Merge user's team_abbrev/team_name so the embed uses the correct team branding
  const userLeagueMatch = getUserLeagues(interaction.user.id, guildId).find(l => l.id === leagueId);
  const league = userLeagueMatch ?? baseLeague;

  if (checkStreamPost(pending.platform, pending.platform_stream_id, league.id)) {
    await interaction.editReply({ content: 'This stream has already been posted.', components: [] });
    clearPendingRoute(interaction.user.id, guildId);
    return;
  }

  const user = { discord_id: interaction.user.id, discord_username: interaction.user.username };
  const streamData = {
    id: pending.platform_stream_id,
    title: pending.stream_title,
    url: pending.stream_url,
    user_login: pending.stream_url.split('twitch.tv/')[1] || '',
    user_name: pending.user_name || interaction.user.username,
    videoId: pending.stream_url.split('watch?v=')[1] || '',
  };

  await postStreamToChannel(league, user, pending.platform, streamData);
  clearPendingRoute(interaction.user.id, guildId);

  const channel = await interaction.client.channels.fetch(league.ppv_channel_id).catch(() => null);
  const channelMention = channel ? `<#${league.ppv_channel_id}>` : `#${league.name}`;
  await interaction.editReply({
    content: `Done! Your stream has been posted to ${channelMention}.`,
    components: [],
  });
}
