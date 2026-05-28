const logger = require('../../utils/logger');
const { getPendingRoute, clearPendingRoute, checkStreamPost, getLeagueById } = require('../../db/queries');
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
        logger.error('Command error', { command: interaction.commandName, error: err.message });
        const reply = { content: 'An error occurred running that command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply);
        } else {
          await interaction.reply(reply);
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
          logger.error('Autocomplete error', { command: interaction.commandName, error: err.message });
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

  const league = getLeagueById(leagueId);
  if (!league) {
    await interaction.editReply({ content: 'League not found.', components: [] });
    return;
  }

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
    user_name: interaction.user.username,
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
