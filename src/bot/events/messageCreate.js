const { getLeagueByUserChannel } = require('../../db/queries');
const { handleStreamLinkMessage } = require('../../utils/linkStreamHandler');

module.exports = {
  name: 'messageCreate',
  once: false,
  async execute(message) {
    if (message.author.bot || !message.guild) return;
    const league = getLeagueByUserChannel(message.guild.id, message.channelId);
    if (!league) return;
    handleStreamLinkMessage(message, league).catch(() => {});
  },
};
