const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { postStreamToChannel } = require('../../utils/channelRouter');
const {
  getOrCreateUser,
  getGuildSettings,
  setGuildAdminRole,
  setGuildTriggerKeyword,
  getAllLeagues,
  getLeagueByAbbr,
  getLeagueById,
  addLeague,
  updateLeague,
  addUserToLeague,
  updateUserPlatformUsername,
  getLastStreams,
  removeUserFromLeague,
  addUserPlatform,
  removeUserPlatform,
  getUserLeagues,
  getUserPlatforms,
  getUsersInLeague,
  getHealthStats,
  addCustomTeam,
  updateCustomTeam,
} = require('../../db/queries');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { searchTeams, searchCustomTeams, getTeamByAbbrev, invalidateTeamsCache, TEAMS_JSON_PATH } = require('../../utils/teams');
const logger = require('../../utils/logger');
const { WEEK_LABELS, parseScheduleCell, parseMatchups } = require('../../utils/schedule');

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
        .addStringOption(o => o.setName('keyword').setDescription('Stream title trigger word to match (e.g. GOI). Default: GOI').setRequired(false))
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
        .addStringOption(o => o.setName('team').setDescription('Team the user represents').setRequired(true).setAutocomplete(true))
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
    // audituser
    .addSubcommand(sub =>
      sub.setName('audituser')
        .setDescription('Show full registration details for any user')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    )
    // auditleague
    .addSubcommand(sub =>
      sub.setName('auditleague')
        .setDescription('Show full configuration and roster for a league')
        .addStringOption(o => o.setName('league').setDescription('League abbreviation').setRequired(true).setAutocomplete(true))
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
        .addStringOption(o => o.setName('keyword').setDescription('Secondary keyword in stream title (e.g. OPEN). Case-insensitive.').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('PPV channel to post streams to').setRequired(true))
        .addChannelOption(o => o.setName('category').setDescription('Category that gates self-registration (optional)').setRequired(false))
        .addRoleOption(o => o.setName('ping_role').setDescription('Role to ping when a stream is posted (optional)').setRequired(false))
        .addChannelOption(o => o.setName('advance_channel').setDescription('Channel to post week advancement messages').setRequired(false))
        .addChannelOption(o => o.setName('user_channel').setDescription('Channel for user scheduling updates').setRequired(false))
        .addStringOption(o => o.setName('schedule_url').setDescription('Published CSV URL for the week schedule sheet').setRequired(false))
        .addRoleOption(o => o.setName('staff_role').setDescription('Staff role for this league').setRequired(false))
    )
    // editleague
    .addSubcommand(sub =>
      sub.setName('editleague')
        .setDescription('Edit an existing league')
        .addStringOption(o => o.setName('league').setDescription('League to edit').setRequired(true).setAutocomplete(true))
        .addRoleOption(o => o.setName('ping_role').setDescription('Role to ping on stream post (set to @everyone to clear)').setRequired(false))
        .addChannelOption(o => o.setName('channel').setDescription('Change the PPV channel').setRequired(false))
        .addStringOption(o => o.setName('name').setDescription('Rename the league').setRequired(false))
        .addChannelOption(o => o.setName('advance_channel').setDescription('Change the advance channel').setRequired(false))
        .addChannelOption(o => o.setName('user_channel').setDescription('Channel for user scheduling updates').setRequired(false))
        .addStringOption(o => o.setName('schedule_url').setDescription('Update the schedule sheet CSV URL').setRequired(false))
        .addRoleOption(o => o.setName('staff_role').setDescription('Staff role for this league').setRequired(false))
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
        .setDescription('Post a registered user\'s current live stream to a league channel')
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
        .addUserOption(o => o.setName('user').setDescription('Registered Discord user').setRequired(true))
        .addStringOption(o => o.setName('platform').setDescription('Platform (auto-selected if user only has one)').setRequired(false).setAutocomplete(true))
        .addStringOption(o => o.setName('url').setDescription('Override stream URL (skips live lookup)').setRequired(false))
        .addStringOption(o => o.setName('title').setDescription('Override stream title').setRequired(false))
    )
    // edituser
    .addSubcommand(sub =>
      sub.setName('edituser')
        .setDescription('Edit a user\'s platform, username, or team assignment in a league')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('platform').setDescription('Change platform').setRequired(false)
          .addChoices({ name: 'Twitch', value: 'twitch' }, { name: 'YouTube', value: 'youtube' }))
        .addStringOption(o => o.setName('username').setDescription('New platform username').setRequired(false))
        .addStringOption(o => o.setName('team').setDescription('New team').setRequired(false).setAutocomplete(true))
    )
    // editteam
    .addSubcommand(sub =>
      sub.setName('editteam')
        .setDescription('Edit a team\'s details')
        .addStringOption(o => o.setName('team').setDescription('Team to edit').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('name').setDescription('New team name').setRequired(false))
        .addStringOption(o => o.setName('mascot').setDescription('New mascot').setRequired(false))
        .addStringOption(o => o.setName('abbreviation').setDescription('New abbreviation').setRequired(false))
        .addStringOption(o => o.setName('primary_color').setDescription('New primary hex color').setRequired(false))
        .addStringOption(o => o.setName('secondary_color').setDescription('New secondary hex color').setRequired(false))
        .addStringOption(o => o.setName('conference').setDescription('New conference').setRequired(false))
        .addAttachmentOption(o => o.setName('logo').setDescription('New logo image').setRequired(false))
    )
    // editcustomteam
    .addSubcommand(sub =>
      sub.setName('editcustomteam')
        .setDescription('Edit a custom team\'s details')
        .addStringOption(o => o.setName('team').setDescription('Custom team to edit').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('name').setDescription('New team name').setRequired(false))
        .addStringOption(o => o.setName('mascot').setDescription('New mascot').setRequired(false))
        .addStringOption(o => o.setName('abbreviation').setDescription('New abbreviation').setRequired(false))
        .addStringOption(o => o.setName('primary_color').setDescription('New primary hex color').setRequired(false))
        .addStringOption(o => o.setName('secondary_color').setDescription('New secondary hex color').setRequired(false))
        .addAttachmentOption(o => o.setName('logo').setDescription('New logo image').setRequired(false))
    )
    // removeuser
    .addSubcommand(sub =>
      sub.setName('removeuser')
        .setDescription('Remove a user from a league')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
    )
    // last3streams
    .addSubcommand(sub =>
      sub.setName('last3streams')
        .setDescription('Show the last 3 posted streams for a user')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    )
    // changeteam
    .addSubcommand(sub =>
      sub.setName('changeteam')
        .setDescription('Change the team assigned to a user in a league')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('team').setDescription('New team').setRequired(true).setAutocomplete(true))
    )
    // addcustomteam
    .addSubcommand(sub =>
      sub.setName('addcustomteam')
        .setDescription('Add a custom team to the team list')
        .addStringOption(o => o.setName('name').setDescription('Team name').setRequired(true))
        .addStringOption(o => o.setName('mascot').setDescription('Mascot name').setRequired(true))
        .addStringOption(o => o.setName('abbreviation').setDescription('Short abbreviation (e.g. TAMU)').setRequired(true))
        .addStringOption(o => o.setName('primary_color').setDescription('Primary color hex (e.g. #500000)').setRequired(true))
        .addAttachmentOption(o => o.setName('logo').setDescription('Team logo image (PNG recommended)').setRequired(true))
        .addStringOption(o => o.setName('secondary_color').setDescription('Secondary color hex (e.g. #FFFFFF)').setRequired(false))
    )
    // advance
    .addSubcommand(sub =>
      sub.setName('advance')
        .setDescription('Post the week advancement message to a league channel')
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName('week').setDescription('Week or stage to advance to').setRequired(true)
          .addChoices(
            { name: 'Week 0',               value: 0  },
            { name: 'Week 1',               value: 1  },
            { name: 'Week 2',               value: 2  },
            { name: 'Week 3',               value: 3  },
            { name: 'Week 4',               value: 4  },
            { name: 'Week 5',               value: 5  },
            { name: 'Week 6',               value: 6  },
            { name: 'Week 7',               value: 7  },
            { name: 'Week 8',               value: 8  },
            { name: 'Week 9',               value: 9  },
            { name: 'Week 10',              value: 10 },
            { name: 'Week 11',              value: 11 },
            { name: 'Week 12',              value: 12 },
            { name: 'Week 13',              value: 13 },
            { name: 'Week 14',              value: 14 },
            { name: 'CCW',                  value: 15 },
            { name: 'Bowl Week 1',          value: 16 },
            { name: 'Bowl Week 2',          value: 17 },
            { name: 'CFP Semi Finals',      value: 18 },
            { name: 'National Championship', value: 19 },
          ))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'team') {
      const sub = interaction.options.getSubcommand(false);
      const results = sub === 'editcustomteam'
        ? searchCustomTeams(focused.value)
        : searchTeams(focused.value);
      return interaction.respond(results);
    }

    if (focused.name === 'platform') {
      const targetUser = interaction.options.get('user');
      const platforms = targetUser ? getUserPlatforms(targetUser.value) : [];
      const query = focused.value.toLowerCase();
      const choices = platforms
        .filter(p => p.platform.includes(query) || p.platform_username.toLowerCase().includes(query))
        .map(p => ({ name: `${p.platform} — ${p.platform_username}`, value: p.platform }));
      return interaction.respond(choices);
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
    const sub = interaction.options.getSubcommand();

    // setup is allowed for anyone with MANAGE_GUILD — check before the full isAdmin guard
    if (sub === 'setup') return handleSetup(interaction);

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'Not authorized.', flags: 64 });
    }

    switch (sub) {
      case 'register':     return handleRegister(interaction);
      case 'unregister':   return handleUnregister(interaction);
      case 'removeleague': return handleRemoveLeague(interaction);
      case 'audituser':    return handleAuditUser(interaction);
      case 'auditleague':  return handleAuditLeague(interaction);
      case 'leagues':      return handleLeagues(interaction);
      case 'addleague':    return handleAddLeague(interaction);
      case 'editleague':   return handleEditLeague(interaction);
      case 'users':        return handleUsers(interaction);
      case 'health':       return handleHealth(interaction);
      case 'announce':        return handleAnnounce(interaction);
      case 'edituser':        return handleEditUser(interaction);
      case 'editteam':        return handleEditTeam(interaction);
      case 'editcustomteam':  return handleEditCustomTeam(interaction);
      case 'removeuser':      return handleRemoveUser(interaction);
      case 'last3streams':    return handleLast3Streams(interaction);
      case 'changeteam':      return handleAdminChangeTeam(interaction);
      case 'addcustomteam':   return handleAddCustomTeam(interaction);
      case 'advance':         return handleAdvance(interaction);
      default:
        return interaction.reply({ content: 'Unknown subcommand.', flags: 64 });
    }
  },
};

async function handleSetup(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) &&
      interaction.member.id !== interaction.guild.ownerId) {
    return interaction.reply({ content: 'You need the **Manage Server** permission to run setup.', flags: 64 });
  }

  const role = interaction.options.getRole('admin_role');
  const keyword = interaction.options.getString('keyword');

  if (!role && !keyword) {
    const settings = getGuildSettings(interaction.guildId);
    const currentRole = settings?.admin_role_id
      ? `<@&${settings.admin_role_id}>`
      : 'Not set (only server owner and Manage Server users can run admin commands)';
    const currentKeyword = settings?.trigger_keyword || 'GOI';
    return interaction.reply({
      content: `**StreamGate Setup**\nAdmin role: ${currentRole}\nTrigger keyword: \`${currentKeyword}\`\n\nOptions:\n\`/admin setup admin_role:@YourRole\`\n\`/admin setup keyword:GOI\``,
      flags: 64,
    });
  }

  const lines = [];

  if (role) {
    setGuildAdminRole(interaction.guildId, role.id);
    logger.info('Guild admin role set', { guildId: interaction.guildId, roleId: role.id });
    lines.push(`Admin role set to **${role.name}**.`);
  }

  if (keyword) {
    const kw = keyword.toUpperCase().trim();
    setGuildTriggerKeyword(interaction.guildId, kw);
    logger.info('Guild trigger keyword set', { guildId: interaction.guildId, keyword: kw });
    lines.push(`Trigger keyword set to \`${kw}\`. Streams must include \`${kw}\` in their title to be routed.`);
  }

  await interaction.reply({ content: lines.join('\n'), flags: 64 });
}

async function handleRegister(interaction) {
  const target = interaction.options.getUser('user');
  const platform = interaction.options.getString('platform');
  const username = interaction.options.getString('username').replace(/^@/, '');
  const leagueAbbr = interaction.options.getString('league').toUpperCase();

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, flags: 64 });
  }

  const teamAbbrev = interaction.options.getString('team').toUpperCase();
  const team = getTeamByAbbrev(teamAbbrev);
  if (!team) {
    return interaction.reply({ content: `Team **${teamAbbrev}** not found. Use autocomplete to pick a valid team.`, flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  try {
    getOrCreateUser(target.id, target.username);
    addUserPlatform(target.id, platform, username, null);
    addUserToLeague(target.id, league.id, interaction.user.id, team.name, team.abbrev);

    if (platform === 'youtube' && process.env.YOUTUBE_API_KEY) {
      const { getChannelIdByHandle, subscribeToChannel } = require('../../platforms/youtube/api');
      const { updateSubscriptionId, updatePlatformUserId } = require('../../db/queries');
      const channelId = await getChannelIdByHandle(username);
      if (channelId) {
        await subscribeToChannel(channelId);
        updateSubscriptionId('youtube', username, channelId);
        updatePlatformUserId('youtube', username, channelId);
        logger.info('YouTube subscription created on register', { username, channelId });
      } else {
        logger.warn('YouTube channel not found on register, subscription deferred to cron', { username });
      }
    }

    logger.info('Admin registered user', {
      adminId: interaction.user.id,
      targetId: target.id,
      guildId: interaction.guildId,
      platform,
      username,
      league: league.abbr,
    });

    await interaction.editReply({
      content: `Registered <@${target.id}> on **${platform}** as \`${username}\` for **${league.name}** representing **${team.name}**.`,
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
  await interaction.reply({ content: `Removed **${platform}** account for <@${target.id}>.`, flags: 64 });
}

async function handleRemoveLeague(interaction) {
  const target = interaction.options.getUser('user');
  const leagueAbbr = interaction.options.getString('league').toUpperCase();

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, flags: 64 });
  }

  removeUserFromLeague(target.id, league.id);
  logger.info('Admin removed user from league', { adminId: interaction.user.id, targetId: target.id, league: league.abbr });
  await interaction.reply({ content: `Removed <@${target.id}> from **${league.name}**.`, flags: 64 });
}

async function handleAuditUser(interaction) {
  const target = interaction.options.getUser('user');
  const platforms = getUserPlatforms(target.id);
  const leagues = getUserLeagues(target.id, interaction.guildId);

  const embed = new EmbedBuilder()
    .setTitle(`User Audit: ${target.username}`)
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
      ? leagues.map(l => {
          const team = l.team_name ? ` — ${l.team_name}` : '';
          return `**${l.name}** \`${l.abbr}\`${team}`;
        }).join('\n')
      : 'None',
  });

  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleAuditLeague(interaction) {
  const leagueAbbr = interaction.options.getString('league').toUpperCase();
  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);

  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found.`, flags: 64 });
  }

  const users = getUsersInLeague(league.id);

  const embed = new EmbedBuilder()
    .setTitle(`League Audit: ${league.name} (${league.abbr})`)
    .setColor(0x5865F2)
    .setTimestamp();

  embed.addFields(
    { name: 'PPV Channel',      value: league.ppv_channel_id      ? `<#${league.ppv_channel_id}>`      : 'Not set', inline: true },
    { name: 'Advance Channel',  value: league.advance_channel_id  ? `<#${league.advance_channel_id}>`  : 'Not set', inline: true },
    { name: 'User Channel',     value: league.user_channel_id     ? `<#${league.user_channel_id}>`     : 'Not set', inline: true },
    { name: 'Ping Role',        value: league.ping_role_id        ? `<@&${league.ping_role_id}>`       : 'Not set', inline: true },
    { name: 'Staff Role',       value: league.staff_role_id       ? `<@&${league.staff_role_id}>`      : 'Not set', inline: true },
    { name: 'Access Gate',      value: league.category_id         ? `<#${league.category_id}>`         : 'Not set', inline: true },
    { name: 'Schedule URL',     value: league.schedule_url        ? '✓ Configured'                     : 'Not set', inline: true },
  );

  const seen = new Set();
  const rosterLines = [];
  for (const u of users) {
    if (!seen.has(u.discord_id)) {
      seen.add(u.discord_id);
      const team = u.team_name ? ` — ${u.team_name}` : '';
      rosterLines.push(`<@${u.discord_id}>${team}`);
    }
  }

  embed.addFields({
    name: `Roster (${seen.size})`,
    value: rosterLines.length ? rosterLines.join('\n') : 'No users registered',
  });

  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleLeagues(interaction) {
  const leagues = getAllLeagues(interaction.guildId);

  if (!leagues.length) {
    return interaction.reply({
      content: 'No leagues configured yet. Use `/admin addleague` to create one.',
      flags: 64,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Leagues in ${interaction.guild.name}`)
    .setColor(0x5865F2)
    .setDescription(
      leagues.map(l =>
        `**${l.name}** \`keyword: ${l.abbr}\`\nPPV: <#${l.ppv_channel_id}>${l.category_id ? `\nAccess gate: <#${l.category_id}>` : ''}`
      ).join('\n\n')
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleAddLeague(interaction) {
  await interaction.deferReply({ flags: 64 });

  const name = interaction.options.getString('name');
  const keyword = interaction.options.getString('keyword').toUpperCase().trim();
  const channel = interaction.options.getChannel('channel');
  const category = interaction.options.getChannel('category');
  const pingRole = interaction.options.getRole('ping_role');
  const advanceChannel = interaction.options.getChannel('advance_channel');
  const userChannel = interaction.options.getChannel('user_channel');
  const scheduleUrl = interaction.options.getString('schedule_url') || null;
  const staffRole = interaction.options.getRole('staff_role');

  const settings = getGuildSettings(interaction.guildId);
  const triggerKeyword = settings?.trigger_keyword || 'GOI';

  try {
    addLeague(interaction.guildId, name, keyword, channel.id, category?.id || null, pingRole?.id || null, advanceChannel?.id || null, userChannel?.id || null, scheduleUrl, staffRole?.id || null);
    logger.info('League added', { adminId: interaction.user.id, guildId: interaction.guildId, name, keyword, channelId: channel.id });
    const pingNote = pingRole ? ` Role <@&${pingRole.id}> will be pinged on each stream.` : '';
    await interaction.editReply(
      `League **${name}** added with keyword \`${keyword}\`.\nStreams with \`${triggerKeyword} ${keyword}\` in the title will post to <#${channel.id}>.${pingNote}`
    );
  } catch (err) {
    logger.error('addleague failed', { error: err.message, guildId: interaction.guildId, name, keyword });
    const msg = err.message?.includes('UNIQUE')
      ? `A league with keyword \`${keyword}\` already exists in this server.`
      : `Failed to add league: ${err.message}`;
    await interaction.editReply(msg);
  }
}

async function handleUsers(interaction) {
  const leagueAbbr = interaction.options.getString('league').toUpperCase();
  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);

  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, flags: 64 });
  }

  const users = getUsersInLeague(league.id);

  if (!users.length) {
    return interaction.reply({ content: `No users in **${league.name}**.`, flags: 64 });
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
      const team = u.team_name ? ` | **${u.team_name}**` : '';
      lines.push(`<@${u.discord_id}> (${u.discord_username})${team}${platformLines ? ` — ${platformLines}` : ''}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`Users in ${league.name}`)
    .setColor(0x5865F2)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleHealth(interaction) {
  await interaction.deferReply({ flags: 64 });

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
  const targetUser = interaction.options.getUser('user');
  const platformOption = interaction.options.getString('platform')?.toLowerCase();
  const urlOverride = interaction.options.getString('url');
  const titleOverride = interaction.options.getString('title');

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.reply({ content: `League **${leagueAbbr}** not found in this server.`, flags: 64 });
  }

  const platforms = getUserPlatforms(targetUser.id);
  if (!platforms.length) {
    return interaction.reply({ content: `<@${targetUser.id}> has no registered platforms.`, flags: 64 });
  }

  let platform;
  if (platformOption) {
    platform = platforms.find(p => p.platform === platformOption);
    if (!platform) {
      return interaction.reply({ content: `<@${targetUser.id}> is not registered on **${platformOption}**.`, flags: 64 });
    }
  } else if (platforms.length === 1) {
    platform = platforms[0];
  } else {
    const list = platforms.map(p => `\`${p.platform}\``).join(', ');
    return interaction.reply({ content: `<@${targetUser.id}> has multiple platforms (${list}). Use the \`platform\` option to choose one.`, flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  try {
    let streamData = null;

    if (urlOverride && titleOverride) {
      streamData = {
        url: urlOverride,
        title: titleOverride,
        user_name: platform.platform_username,
      };
    } else {
      if (platform.platform === 'twitch' && process.env.TWITCH_CLIENT_ID) {
        const { getLiveStream } = require('../../platforms/twitch/api');
        streamData = await getLiveStream(platform.platform_username);
      } else if (platform.platform === 'youtube' && process.env.YOUTUBE_API_KEY) {
        const { getActiveLiveStream, getChannelIdByHandle, subscribeToChannel } = require('../../platforms/youtube/api');
        const { updateSubscriptionId, updatePlatformUserId } = require('../../db/queries');
        let channelId = platform.platform_user_id || platform.subscription_id;
        if (!channelId) {
          channelId = await getChannelIdByHandle(platform.platform_username);
          if (channelId) {
            await subscribeToChannel(channelId);
            updateSubscriptionId('youtube', platform.platform_username, channelId);
            updatePlatformUserId('youtube', platform.platform_username, channelId);
          }
        }
        if (channelId) {
          streamData = await getActiveLiveStream(channelId);
        }
      }

      if (!streamData) {
        return interaction.editReply({
          content: `Could not find an active live stream for **${platform.platform_username}** on ${platform.platform}. If they are live, use the \`url\` and \`title\` overrides.`,
        });
      }
    }

    const { checkRecentStreamPostByTitle } = require('../../db/queries');
    if (checkRecentStreamPostByTitle(league.id, streamData.title)) {
      return interaction.editReply({ content: `That stream was already posted to **${league.name}** within the last hour.` });
    }

    // Use the team-enriched league row so postStreamToChannel can apply team colors/logo
    const userLeagues = getUserLeagues(targetUser.id, interaction.guildId);
    const enrichedLeague = userLeagues.find(l => l.id === league.id) || league;

    const discordUser = { discord_id: targetUser.id, discord_username: targetUser.username };
    await postStreamToChannel(enrichedLeague, discordUser, platform.platform, streamData);

    logger.info('Admin manual announce', {
      adminId: interaction.user.id,
      targetId: targetUser.id,
      guildId: interaction.guildId,
      league: league.abbr,
      platform: platform.platform,
      username: platform.platform_username,
    });

    await interaction.editReply({ content: `Posted **${platform.platform_username}**'s stream to <#${league.ppv_channel_id}>.` });
  } catch (err) {
    logger.error('Announce error', {
      error: err.message,
      rawError: err.rawError ?? err.errors ?? undefined,
    });
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}

async function handleAdminChangeTeam(interaction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser('user');
  const leagueAbbr = interaction.options.getString('league').toUpperCase();
  const teamAbbrev = interaction.options.getString('team').toUpperCase();

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.editReply({ content: `League **${leagueAbbr}** not found.` });
  }

  const team = getTeamByAbbrev(teamAbbrev);
  if (!team) {
    return interaction.editReply({ content: `Team **${teamAbbrev}** not found. Use autocomplete to pick a valid team.` });
  }

  try {
    addUserToLeague(targetUser.id, league.id, interaction.user.id, team.name, team.abbrev);
    logger.info('Admin changed user team', {
      adminId: interaction.user.id,
      targetId: targetUser.id,
      league: league.abbr,
      team: team.abbrev,
    });
    await interaction.editReply({
      content: `Updated! <@${targetUser.id}>'s team in **${league.name}** is now **${team.name}**.`,
    });
  } catch (err) {
    logger.error('Admin changeteam error', { error: err.message });
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}

async function handleAddCustomTeam(interaction) {
  await interaction.deferReply({ flags: 64 });

  const name         = interaction.options.getString('name').trim();
  const mascot       = interaction.options.getString('mascot').trim();
  const abbrev       = interaction.options.getString('abbreviation').trim().toUpperCase();
  const primaryHex   = interaction.options.getString('primary_color').trim();
  const secondaryHex = interaction.options.getString('secondary_color')?.trim() || null;
  const attachment   = interaction.options.getAttachment('logo');

  const hexRegex = /^#?[0-9A-Fa-f]{6}$/;
  if (!hexRegex.test(primaryHex)) {
    return interaction.editReply({ content: `Invalid primary color **${primaryHex}**. Use hex format like \`#500000\`.` });
  }
  if (secondaryHex && !hexRegex.test(secondaryHex)) {
    return interaction.editReply({ content: `Invalid secondary color **${secondaryHex}**. Use hex format like \`#FFFFFF\`.` });
  }

  const normalizeHex = h => h.startsWith('#') ? h : `#${h}`;
  const colors = [normalizeHex(primaryHex)];
  if (secondaryHex) colors.push(normalizeHex(secondaryHex));

  if (getTeamByAbbrev(abbrev)) {
    return interaction.editReply({ content: `A team with abbreviation **${abbrev}** already exists.` });
  }

  let logoBuffer = null;
  if (attachment) {
    try {
      const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      logoBuffer = Buffer.from(response.data);
    } catch (err) {
      logger.error('Failed to download custom team logo', { error: err.message });
      return interaction.editReply({ content: 'Failed to download the logo. Please try again.' });
    }
  }

  addCustomTeam(name, abbrev, mascot, colors, logoBuffer);

  logger.info('Custom team added', { name, abbrev, addedBy: interaction.user.id });
  await interaction.editReply({ content: `Custom team **${name}** (\`${abbrev}\`) added successfully and is now available in team selects.` });
}

async function handleEditLeague(interaction) {
  await interaction.deferReply({ flags: 64 });

  const leagueAbbr     = interaction.options.getString('league').toUpperCase();
  const pingRole       = interaction.options.getRole('ping_role');
  const newChannel     = interaction.options.getChannel('channel');
  const newName        = interaction.options.getString('name');
  const advanceChannel = interaction.options.getChannel('advance_channel');
  const userChannel    = interaction.options.getChannel('user_channel');
  const newScheduleUrl = interaction.options.getString('schedule_url');
  const staffRole      = interaction.options.getRole('staff_role');

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.editReply({ content: `League **${leagueAbbr}** not found.` });
  }

  if (!pingRole && !newChannel && !newName && !advanceChannel && !userChannel && !newScheduleUrl && !staffRole) {
    return interaction.editReply({ content: 'No changes provided. Pass at least one option to update.' });
  }

  const updates = {};
  const notes = [];

  if (pingRole) {
    // @everyone id === guildId — treat as "clear the ping role"
    updates.pingRoleId = pingRole.id === interaction.guildId ? null : pingRole.id;
    notes.push(updates.pingRoleId ? `Ping role set to <@&${pingRole.id}>` : 'Ping role cleared');
  }
  if (newChannel) {
    updates.ppvChannelId = newChannel.id;
    notes.push(`PPV channel set to <#${newChannel.id}>`);
  }
  if (newName) {
    updates.name = newName;
    notes.push(`Name changed to **${newName}**`);
  }
  if (advanceChannel) {
    updates.advanceChannelId = advanceChannel.id;
    notes.push(`Advance channel set to <#${advanceChannel.id}>`);
  }
  if (userChannel) {
    updates.userChannelId = userChannel.id;
    notes.push(`User channel set to <#${userChannel.id}>`);
  }
  if (newScheduleUrl) {
    updates.scheduleUrl = newScheduleUrl;
    notes.push(`Schedule URL updated`);
  }
  if (staffRole) {
    updates.staffRoleId = staffRole.id;
    notes.push(`Staff role set to <@&${staffRole.id}>`);
  }

  updateLeague(league.id, updates);
  logger.info('League updated', { adminId: interaction.user.id, leagueId: league.id, updates });
  await interaction.editReply({ content: `League **${league.name}** updated:\n${notes.join('\n')}` });
}

async function handleEditUser(interaction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser  = interaction.options.getUser('user');
  const leagueAbbr  = interaction.options.getString('league').toUpperCase();
  const newPlatform = interaction.options.getString('platform');
  const newUsername = interaction.options.getString('username');
  const teamAbbrev  = interaction.options.getString('team')?.toUpperCase();

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) return interaction.editReply({ content: `League **${leagueAbbr}** not found.` });

  if (!newPlatform && !newUsername && !teamAbbrev) {
    return interaction.editReply({ content: 'No changes provided. Pass at least one option to update.' });
  }

  const notes = [];
  try {
    if (newUsername || newPlatform) {
      const platforms = getUserPlatforms(targetUser.id);
      const platform = newPlatform || platforms[0]?.platform;
      if (!platform) return interaction.editReply({ content: `<@${targetUser.id}> has no registered platform to update.` });

      if (newUsername) {
        updateUserPlatformUsername(targetUser.id, platform, newUsername);
        notes.push(`**${platform}** username changed to \`${newUsername}\``);

        if (platform === 'youtube' && process.env.YOUTUBE_API_KEY) {
          const { getChannelIdByHandle, subscribeToChannel } = require('../../platforms/youtube/api');
          const { updateSubscriptionId, updatePlatformUserId } = require('../../db/queries');
          const channelId = await getChannelIdByHandle(newUsername);
          if (channelId) {
            await subscribeToChannel(channelId);
            updateSubscriptionId('youtube', newUsername, channelId);
            updatePlatformUserId('youtube', newUsername, channelId);
            notes.push(`YouTube subscription updated`);
          }
        }
      }
    }

    if (teamAbbrev) {
      const team = getTeamByAbbrev(teamAbbrev);
      if (!team) return interaction.editReply({ content: `Team **${teamAbbrev}** not found.` });
      addUserToLeague(targetUser.id, league.id, interaction.user.id, team.name, team.abbrev);
      notes.push(`Team changed to **${team.name}**`);
    }

    logger.info('Admin edited user', { adminId: interaction.user.id, targetId: targetUser.id, league: leagueAbbr });
    await interaction.editReply({ content: `<@${targetUser.id}> updated in **${league.name}**:\n${notes.join('\n')}` });
  } catch (err) {
    logger.error('edituser error', { error: err.message });
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}

async function handleEditTeam(interaction) {
  await interaction.deferReply({ flags: 64 });

  const teamAbbrev    = interaction.options.getString('team').toUpperCase();
  const newName       = interaction.options.getString('name')?.trim();
  const newMascot     = interaction.options.getString('mascot')?.trim();
  const newAbbrev     = interaction.options.getString('abbreviation')?.trim().toUpperCase();
  const primaryHex    = interaction.options.getString('primary_color')?.trim();
  const secondaryHex  = interaction.options.getString('secondary_color')?.trim();
  const newConference = interaction.options.getString('conference')?.trim();
  const logoAttach    = interaction.options.getAttachment('logo');

  const team = getTeamByAbbrev(teamAbbrev);
  if (!team) return interaction.editReply({ content: `Team **${teamAbbrev}** not found.` });

  const hexRegex = /^#?[0-9A-Fa-f]{6}$/;
  if (primaryHex && !hexRegex.test(primaryHex)) {
    return interaction.editReply({ content: `Invalid primary color **${primaryHex}**.` });
  }
  if (secondaryHex && !hexRegex.test(secondaryHex)) {
    return interaction.editReply({ content: `Invalid secondary color **${secondaryHex}**.` });
  }

  const teamsData = JSON.parse(fs.readFileSync(TEAMS_JSON_PATH, 'utf8'));
  const entry = teamsData[team.name];

  if (newMascot)     entry.mascot = newMascot;
  if (newAbbrev)     entry.abbrev = newAbbrev;
  if (newConference) entry.conference = newConference;

  if (primaryHex) {
    const normalizeHex = h => h.startsWith('#') ? h : `#${h}`;
    entry.colors = [normalizeHex(primaryHex)];
    if (secondaryHex) entry.colors.push(normalizeHex(secondaryHex));
  } else if (secondaryHex) {
    const normalizeHex = h => h.startsWith('#') ? h : `#${h}`;
    entry.colors = [entry.colors?.[0] || '#000000', normalizeHex(secondaryHex)];
  }

  if (logoAttach) {
    try {
      const ext = path.extname(logoAttach.name) || '.png';
      const logoDir = entry.pic
        ? path.dirname(path.resolve(process.cwd(), entry.pic.replace(/^\.\//, '')))
        : path.join(process.cwd(), 'src/db/teams/logos');
      if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
      const filename = `${(newAbbrev || teamAbbrev).toLowerCase()}${ext}`;
      const logoPath = path.join(logoDir, filename);
      const response = await axios.get(logoAttach.url, { responseType: 'arraybuffer' });
      fs.writeFileSync(logoPath, response.data);
      entry.pic = `./src/db/teams/logos/${filename}`;
    } catch (err) {
      return interaction.editReply({ content: `Failed to download logo: ${err.message}` });
    }
  }

  // Handle name change — rename the JSON key
  const finalName = newName || team.name;
  if (newName && newName !== team.name) {
    delete teamsData[team.name];
  }
  teamsData[finalName] = entry;

  const sorted = Object.fromEntries(
    Object.entries(teamsData).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(TEAMS_JSON_PATH, JSON.stringify(sorted, null, 2));
  invalidateTeamsCache();

  logger.info('Team edited', { adminId: interaction.user.id, team: finalName });
  await interaction.editReply({ content: `Team **${finalName}** updated successfully.` });
}

async function handleRemoveUser(interaction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser('user');
  const leagueAbbr = interaction.options.getString('league').toUpperCase();

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) return interaction.editReply({ content: `League **${leagueAbbr}** not found.` });

  removeUserFromLeague(targetUser.id, league.id);
  logger.info('Admin removed user from league', { adminId: interaction.user.id, targetId: targetUser.id, league: leagueAbbr });
  await interaction.editReply({ content: `<@${targetUser.id}> has been removed from **${league.name}**.` });
}

async function handleLast3Streams(interaction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser('user');
  const streams = getLastStreams(targetUser.id);

  if (!streams.length) {
    return interaction.editReply({ content: `No posted streams found for <@${targetUser.id}>.` });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Last ${streams.length} stream${streams.length > 1 ? 's' : ''} — ${targetUser.username}`)
    .setColor(0x5865F2)
    .setTimestamp();

  for (const [i, s] of streams.entries()) {
    const title = s.stream_title || s.platform_stream_id;
    const url = s.platform === 'twitch'
      ? `https://twitch.tv/${s.platform_stream_id}`
      : `https://youtube.com/watch?v=${s.platform_stream_id}`;
    const date = new Date(s.posted_at).toLocaleString();
    embed.addFields({
      name: `#${i + 1} — ${s.league_abbr} — ${s.platform}`,
      value: `[${title}](${url})\n${date}`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleEditCustomTeam(interaction) {
  await interaction.deferReply({ flags: 64 });

  const teamAbbrev   = interaction.options.getString('team').toUpperCase();
  const newName      = interaction.options.getString('name')?.trim();
  const newMascot    = interaction.options.getString('mascot')?.trim();
  const newAbbrev    = interaction.options.getString('abbreviation')?.trim().toUpperCase();
  const primaryHex   = interaction.options.getString('primary_color')?.trim();
  const secondaryHex = interaction.options.getString('secondary_color')?.trim();
  const logoAttach   = interaction.options.getAttachment('logo');

  const team = getTeamByAbbrev(teamAbbrev);
  if (!team) return interaction.editReply({ content: `Team **${teamAbbrev}** not found.` });
  if (team.conference !== 'Custom') {
    return interaction.editReply({ content: `**${team.name}** is not a custom team. Use \`/admin editteam\` instead.` });
  }

  const hexRegex = /^#?[0-9A-Fa-f]{6}$/;
  if (primaryHex && !hexRegex.test(primaryHex)) {
    return interaction.editReply({ content: `Invalid primary color **${primaryHex}**.` });
  }
  if (secondaryHex && !hexRegex.test(secondaryHex)) {
    return interaction.editReply({ content: `Invalid secondary color **${secondaryHex}**.` });
  }

  if (!newName && !newMascot && !newAbbrev && !primaryHex && !secondaryHex && !logoAttach) {
    return interaction.editReply({ content: 'No changes provided. Pass at least one option to update.' });
  }

  const normalize = h => h.startsWith('#') ? h : `#${h}`;
  const updates = {};
  if (newName)   updates.name   = newName;
  if (newMascot) updates.mascot = newMascot;
  if (newAbbrev) updates.abbrev = newAbbrev;

  if (primaryHex) {
    updates.colors = [normalize(primaryHex)];
    if (secondaryHex) updates.colors.push(normalize(secondaryHex));
  } else if (secondaryHex) {
    updates.colors = [team.colors?.[0] || '#000000', normalize(secondaryHex)];
  }

  if (logoAttach) {
    try {
      const response = await axios.get(logoAttach.url, { responseType: 'arraybuffer' });
      updates.logo = Buffer.from(response.data);
    } catch (err) {
      return interaction.editReply({ content: `Failed to download logo: ${err.message}` });
    }
  }

  updateCustomTeam(teamAbbrev, updates);

  const finalName = newName || team.name;
  logger.info('Custom team edited', { adminId: interaction.user.id, team: finalName });
  await interaction.editReply({ content: `Custom team **${finalName}** updated successfully.` });
}

async function handleAdvance(interaction) {
  await interaction.deferReply({ flags: 64 });

  const leagueAbbr = interaction.options.getString('league').toUpperCase();
  const weekValue  = interaction.options.getInteger('week');

  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) {
    return interaction.editReply({ content: `League **${leagueAbbr}** not found.` });
  }
  if (!league.advance_channel_id) {
    return interaction.editReply({
      content: `No advance channel set for **${league.name}**. Use \`/admin editleague advance_channel:#channel\` to configure one.`,
    });
  }

  const scheduleUrl = league.schedule_url;
  if (!scheduleUrl) {
    return interaction.editReply({
      content: `No schedule URL set for **${league.name}**. Use \`/admin editleague schedule_url:...\` to configure one.`,
    });
  }

  try {
    const decodedUrl = scheduleUrl.replace(/&amp;/g, '&');
    const response = await axios.get(decodedUrl, { responseType: 'text' });
    // parseScheduleCell uses 0-based row/col: message row is index 5, week col is weekValue directly
    const message = parseScheduleCell(response.data, 5, weekValue);

    if (!message) {
      return interaction.editReply({ content: `No data found for that week in the schedule sheet.` });
    }

    const channel = await interaction.client.channels.fetch(league.advance_channel_id);
    await channel.send(message);

    logger.info('Advance message posted', {
      adminId: interaction.user.id,
      league: leagueAbbr,
      week: weekValue,
      channelId: league.advance_channel_id,
    });

    let threadCount = 0;
    if (league.user_channel_id) {
      const matchups = parseMatchups(message);
      if (matchups.length > 0) {
        const leagueUsers = getUsersInLeague(league.id);
        const teamMap = new Map(leagueUsers.map(u => [u.discord_id, u.team_name || u.discord_username]));
        const weekLabel = WEEK_LABELS[weekValue] ?? `Week ${weekValue}`;
        const userChannel = await interaction.client.channels.fetch(league.user_channel_id);

        for (const [id1, id2] of matchups) {
          const team1 = teamMap.get(id1) ?? `<@${id1}>`;
          const team2 = teamMap.get(id2) ?? `<@${id2}>`;
          const thread = await userChannel.threads.create({
            name: `${weekLabel} : ${team1} vs ${team2}`,
            autoArchiveDuration: 10080,
          });
          const staffMention = league.staff_role_id ? `<@&${league.staff_role_id}>` : 'Staff';
          await thread.send(
            `It's game time!  Time to get sweaty and get those sticks ready!\n\n<@${id1}> versus <@${id2}>\n\nMake sure to schedule your game in this thread.  You have 24 hours to make initial contact with each other before risking being put on Auto Pilot!\n\n~ ${staffMention}`
          );
          threadCount++;
        }

        logger.info('Scheduling threads created', {
          adminId: interaction.user.id,
          league: leagueAbbr,
          week: weekValue,
          threadCount,
          channelId: league.user_channel_id,
        });
      }
    }

    const threadNote = threadCount > 0 ? ` ${threadCount} scheduling thread${threadCount > 1 ? 's' : ''} created in <#${league.user_channel_id}>.` : '';
    await interaction.editReply({ content: `Week advancement posted to <#${league.advance_channel_id}>.${threadNote}` });
  } catch (err) {
    logger.error('Advance error', { error: err.message, league: leagueAbbr, week: weekValue });
    await interaction.editReply({ content: `Failed to post advancement: ${err.message}` });
  }
}

