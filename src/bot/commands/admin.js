const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const {
  getOrCreateUser,
  getGuildSettings,
  setGuildAdminRole,
  getAllLeagues,
  getLeagueByAbbr,
  getLeagueById,
  addLeague,
  addUserToLeague,
  removeUserFromLeague,
  addUserPlatform,
  removeUserPlatform,
  getUserLeagues,
  getUserPlatforms,
  getUsersInLeague,
  getHealthStats,
} = require('../../db/queries');
const logger = require('../../utils/logger');

// Admin check: server owner, MANAGE_GUILD permission, or configured admin role
function isAdmin(interaction) {
  const member = interaction.member;
  if (member.id === interaction.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const settings = getGuildSettings(interaction.guildId);
  if (settings?.admin_role_id && member.roles.cache.has(settings.admin_role_id)) return true;
  return false;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin management commands')
    // setup
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Configure StreamGate for this server')
        .addRoleOption(o => o.setName('admin_role').setDescription('Role that can use admin commands').setRequired(false))
    )
    // register
    .addSubcommand(sub =>
      sub.setName('register')
        .setDescription('Register any user on any platform for any league')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
        .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
          .addChoices({ name: 'Twitch', value: 'twitch' }, { name: 'YouTube', value: 'youtube' }))
        .addStringOption(o => o.setName('username').setDescription('Platform username').setRequired(true))
        .addStringOption(o => o.setName('league').setDescription('League abbreviation').setRequired(true).setAutocomplete(true))
    )
    // unregister
    .addSubcommand(sub =>
      sub.setName('unregister')
        .setDescription('Remove a user\'s platform account')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
        .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
          .addChoices({ name: 'Twitch', value: 'twitch' }, { name: 'YouTube', value: 'youtube' }))
    )
    // removeleague
    .addSubcommand(sub =>
      sub.setName('removeleague')
        .setDescription('Remove a user from a specific league')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
        .addStringOption(o => o.setName('league').setDescription('League abbreviation').setRequired(true).setAutocomplete(true))
    )
    // status
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show full registration details for any user')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    )
    // leagues
    .addSubcommand(sub =>
      sub.setName('leagues')
        .setDescription('List all leagues configured for this server')
    )
    // addleague
    .addSubcommand(sub =>
      sub.setName('addleague')
        .setDescription('Add a new league to this server')
        .addStringOption(o => o.setName('name').setDescription('League name').setRequired(true))
        .addStringOption(o => o.setName('abbr').setDescription('Abbreviation used in GOI titles (e.g. ALPHA)').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('PPV channel to post streams to').setRequired(true))
        .addChannelOption(o => o.setName('category').setDescription('Category that gates self-registration (optional)').setRequired(false))
    )
    // users
    .addSubcommand(sub =>
      sub.setName('users')
        .setDescription('List all registered users in a league')
        .addStringOption(o => o.setName('league').setDescription('League abbreviation').setRequired(true).setAutocomplete(true))
    )
    // health
    .addSubcommand(sub =>
      sub.setName('health')
        .setDescription('Show subscription health stats for this server')
    )
    // announce
    .addSubcommand(sub =>
      sub.setName('announce')
        .setDescription('Manually post a stream link to a league PPV channel')
        .addStringOption(o => o.setName('league').setDescription('League abbreviation').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('url').setDescription('Stream URL').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('Stream title').setRequired(true))
        .addStringOption(o => o.setName('streamer').setDescription('Streamer display name').setRequired(false))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toUpperCase();
    const leagues = getAllLeagues(interaction.guildId);
    const choices = leagues
      .filter(l => l.abbr.includes(focused) || l.name.toUpperCase().includes(focused))
      .slice(0, 25)
      .map(l => ({ name: `${l.abbr} — ${l.name}`, value: l.abbr }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // setup is allowed for anyone with MANAGE_GUILD — check before the full isAdmin guard
    if (sub === 'setup') return handleSetup(interaction);

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'Not authorized.', ephemeral: true });
    }

    switch (sub) {
      case 'register':     return handleRegister(interaction);
      case 'unregister':   return handleUnregister(interaction);
      case 'removeleague': return handleRemoveLeague(interaction);
      case 'status':       return handleStatus(interaction);
      case 'leagues':      return handleLeagues(interaction);
      case 'addleague':    return handleAddLeague(interaction);
      case 'users':        return handleUsers(interaction);
      case 'health':       return handleHealth(interaction);
      case 'announce':     return handleAnnounce(interaction);
      default:
        return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    }
  },
};

async function handleSetup(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) &&
      interaction.member.id !== interaction.guild.ownerId) {
    return interaction.reply({ content: 'You need the **Manage Server** permission to run setup.', ephemeral: true });
  }

  const role = interaction.options.getRole('admin_role');

  if (role) {
    setGuildAdminRole(interaction.guildId, role.id);
    logger.info('Guild admin role set', { guildId: interaction.guildId, roleId: role.id });
    await interaction.reply({
      content: `StreamGate configured. Members with **${role.name}** can now use \`/admin\` commands.\n\nNext: use \`/admin addleague\` to create your first league.`,
      ephemeral: true,
    });
  } else {
    const settings = getGuildSettings(interaction.guildId);
    const currentRole = settings?.admin_role_id
      ? `<@&${settings.admin_role_id}>`
      : 'Not set (only server owner and Manage Server users can run admin commands)';
    await interaction.reply({
      content: `**StreamGate Setup**\nAdmin role: ${currentRole}\n\nTo set an admin role: \`/admin setup admin_role:@YourRole\``,
      ephemeral: true,
    });
  }
}

async function handleRegister(interaction) {
  const target = interaction.options.getUser('user');
  const platform = interaction.options.getString('platform');
  const username = interaction.options.getString('username').replace(/^@/, '');
  const leagueAbbr = interaction.options.getString('league').toUpperCase();

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    getOrCreateUser(target.id, target.username);
    addUserPlatform(target.id, platform, username, null);
    addUserToLeague(target.id, league.id, interaction.user.id);

    logger.info('Admin registered user', {
      adminId: interaction.user.id,
      targetId: target.id,
      guildId: interaction.guildId,
      platform,
      username,
      league: league.abbr,
    });

    await interaction.editReply({
      content: `Registered <@${target.id}> on **${platform}** as \`${username}\` for **${league.name}**.`,
    });
  } catch (err) {
    logger.error('Admin register error', { error: err.message });
    await interaction.editReply({ content: `Registration failed: ${err.message}` });
  }
}

async function handleUnregister(interaction) {
  const target = interaction.options.getUser('user');
  const platform = interaction.options.getString('platform');

  removeUserPlatform(target.id, platform);
  logger.info('Admin unregistered platform', { adminId: interaction.user.id, targetId: target.id, platform });
  await interaction.reply({ content: `Removed **${platform}** account for <@${target.id}>.`, ephemeral: true });
}

async function handleRemoveLeague(interaction) {
  const target = interaction.options.getUser('user');
  const leagueAbbr = interaction.options.getString('league').toUpperCase();

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, ephemeral: true });
  }

  removeUserFromLeague(target.id, league.id);
  logger.info('Admin removed user from league', { adminId: interaction.user.id, targetId: target.id, league: league.abbr });
  await interaction.reply({ content: `Removed <@${target.id}> from **${league.name}**.`, ephemeral: true });
}

async function handleStatus(interaction) {
  const target = interaction.options.getUser('user');
  const platforms = getUserPlatforms(target.id);
  const leagues = getUserLeagues(target.id, interaction.guildId);

  const embed = new EmbedBuilder()
    .setTitle(`Registration: ${target.username}`)
    .setColor(0x5865F2)
    .setTimestamp();

  embed.addFields({
    name: 'Platforms',
    value: platforms.length
      ? platforms.map(p => `**${p.platform}**: ${p.platform_username}${p.subscription_id ? ' ✓' : ' (no sub)'}`).join('\n')
      : 'None',
  });

  embed.addFields({
    name: `Leagues in ${interaction.guild.name}`,
    value: leagues.length
      ? leagues.map(l => `**${l.abbr}** — ${l.name}`).join('\n')
      : 'None',
  });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleLeagues(interaction) {
  const leagues = getAllLeagues(interaction.guildId);

  if (!leagues.length) {
    return interaction.reply({
      content: 'No leagues configured yet. Use `/admin addleague` to create one.',
      ephemeral: true,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Leagues in ${interaction.guild.name}`)
    .setColor(0x5865F2)
    .setDescription(
      leagues.map(l =>
        `**${l.abbr}** — ${l.name}\nPPV: <#${l.ppv_channel_id}>${l.category_id ? `\nAccess gate: <#${l.category_id}>` : ''}`
      ).join('\n\n')
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAddLeague(interaction) {
  const name = interaction.options.getString('name');
  const abbr = interaction.options.getString('abbr').toUpperCase();
  const channel = interaction.options.getChannel('channel');
  const category = interaction.options.getChannel('category');

  try {
    addLeague(interaction.guildId, name, abbr, channel.id, category?.id || null);
    logger.info('League added', { adminId: interaction.user.id, guildId: interaction.guildId, name, abbr, channelId: channel.id });
    await interaction.reply({
      content: `League **${abbr}** (${name}) added. Streams tagged \`GOI ${abbr}\` will post to <#${channel.id}>.`,
      ephemeral: true,
    });
  } catch (err) {
    await interaction.reply({ content: `Failed to add league: ${err.message}`, ephemeral: true });
  }
}

async function handleUsers(interaction) {
  const leagueAbbr = interaction.options.getString('league').toUpperCase();
  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);

  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, ephemeral: true });
  }

  const users = getUsersInLeague(league.id);

  if (!users.length) {
    return interaction.reply({ content: `No users in **${league.name}**.`, ephemeral: true });
  }

  const lines = [];
  const seen = new Set();
  for (const u of users) {
    if (!seen.has(u.discord_id)) {
      seen.add(u.discord_id);
      const platformLines = users
        .filter(x => x.discord_id === u.discord_id && x.platform)
        .map(x => `${x.platform}: ${x.platform_username}`)
        .join(', ');
      lines.push(`<@${u.discord_id}> (${u.discord_username})${platformLines ? ` — ${platformLines}` : ''}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`Users in ${league.name}`)
    .setColor(0x5865F2)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleHealth(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const stats = getHealthStats(interaction.guildId);

  const embed = new EmbedBuilder()
    .setTitle(`StreamGate Health — ${interaction.guild.name}`)
    .setColor(0x57F287)
    .addFields(
      { name: 'Users in this server', value: String(stats.totalUsers), inline: true },
      { name: 'Twitch Subs', value: `${stats.twitchSubs}/${stats.twitchTotal}`, inline: true },
      { name: 'YouTube Subs', value: `${stats.youtubeSubs}/${stats.youtubeTotal}`, inline: true },
      { name: 'Stuck Pending Routes (>5min)', value: String(stats.stuckRoutes), inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleAnnounce(interaction) {
  const leagueAbbr = interaction.options.getString('league').toUpperCase();
  const url = interaction.options.getString('url');
  const title = interaction.options.getString('title');
  const streamer = interaction.options.getString('streamer') || interaction.user.username;

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel = await interaction.client.channels.fetch(league.ppv_channel_id);
    const platform = url.includes('twitch.tv') ? 'twitch' : 'youtube';
    const platformLabel = platform === 'twitch' ? 'Twitch' : 'YouTube';
    const platformColor = platform === 'twitch' ? 0x6441a5 : 0xFF0000;

    const embed = new EmbedBuilder()
      .setTitle(`${streamer} is LIVE on ${platformLabel}`)
      .setURL(url)
      .setDescription(title)
      .addFields(
        { name: 'League', value: league.name, inline: true },
        { name: 'Platform', value: platformLabel, inline: true }
      )
      .setColor(platformColor)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    await interaction.editReply({ content: `Announced in <#${league.ppv_channel_id}>.` });

    logger.info('Admin manual announce', { adminId: interaction.user.id, guildId: interaction.guildId, league: league.abbr, url });
  } catch (err) {
    logger.error('Announce error', { error: err.message });
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}
