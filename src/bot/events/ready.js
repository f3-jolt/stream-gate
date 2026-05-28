const logger = require('../../utils/logger');

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info(`Bot online as ${client.user.tag}`);
  },
};
