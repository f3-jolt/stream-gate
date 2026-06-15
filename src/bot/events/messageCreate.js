const { getLeagueByUserChannel, getLeagueByPpvChannel } = require('../../db/queries');
const { handleStreamLinkMessage, containsStreamLink } = require('../../utils/linkStreamHandler');
const logger = require('../../utils/logger');

module.exports = {
  name: 'messageCreate',
  once: false,
  async execute(message) {
    if (message.author.bot || !message.guild) return;
    const league = getLeagueByUserChannel(message.guild.id, message.channelId)
      || getLeagueByPpvChannel(message.guild.id, message.channelId);
    if (!league) {
      if (containsStreamLink(message.content)) {
        logger.info('Link skipped', {
          reason: 'channel_not_configured',
          channel: message.channelId,
          guild: message.guild.id,
          authorId: message.author.id,
        });
      }
      return;
    }
    handleStreamLinkMessage(message, league).catch(err =>
      logger.warn('Link handler error', { error: err.message, channel: message.channelId, guild: message.guild.id })
    );
  },
};
