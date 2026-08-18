const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const {
  getGuildSettings,
  getAllLeagues,
  getLeagueByAbbr,
  getCurrentSeason,
  getScheduledGames,
  getGamesByWeek,
  getGameById,
  insertGame,
  recordGameResult,
} = require('../../db/queries');
const { searchTeams, getTeamByAbbrev } = require('../../utils/teams');
const { GAME_WEEKS, weekLabel, isPostseasonWeek } = require('../../utils/weeks');
const logger = require('../../utils/logger');

// Same admin gate as /admin (server owner, Manage Server, or configured admin role)
function isAdmin(interaction) {
  const member = interaction.member;
  if (member.id === interaction.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const settings = getGuildSettings(interaction.guildId);
  if (settings?.admin_role_id && member.roles.cache.has(settings.admin_role_id)) return true;
  return false;
}

// Results are only ever entered for weeks that carry games — the admin-only
// stages have nothing to record. Stays under Discord's 25-choice ceiling.
const WEEK_CHOICES = GAME_WEEKS.map(w => ({ name: w.label, value: w.value }));

function gameLabel(g) {
  const wk = weekLabel(g.week);
  return `${wk}: ${g.away_abbrev} @ ${g.home_abbrev}`;
}

function deriveWinnerSide(homeScore, awayScore, resultType, winnerSide) {
  if (resultType === 'FR') return winnerSide; // only forfeits force a winner
  if (homeScore == null || awayScore == null) return null;
  if (homeScore > awayScore) return 'home';
  if (awayScore > homeScore) return 'away';
  return null; // tie
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('results')
    .setDescription('Record and view dynasty schedule results')
    // record
    .addSubcommand(sub =>
      sub.setName('record')
        .setDescription('Record the result of a scheduled game (opens a form for the scores)')
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('game').setDescription('Scheduled game').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('result_type').setDescription('Result type (default: normal)').setRequired(false)
          .addChoices(
            { name: 'Normal', value: 'normal' },
            { name: 'Forfeit Result (FR)', value: 'FR' },
            { name: 'Fair Sim (FS)', value: 'FS' },
          ))
        .addStringOption(o => o.setName('winner').setDescription('Winner (required for FR only)').setRequired(false)
          .addChoices({ name: 'Home', value: 'home' }, { name: 'Away', value: 'away' }))
    )
    // schedule
    .addSubcommand(sub =>
      sub.setName('schedule')
        .setDescription('Add a single game to the current season schedule')
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName('week').setDescription('Week or stage').setRequired(true).addChoices(...WEEK_CHOICES))
        .addStringOption(o => o.setName('home').setDescription('Home team').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('away').setDescription('Away team').setRequired(true).setAutocomplete(true))
    )
    // show
    .addSubcommand(sub =>
      sub.setName('show')
        .setDescription('Show results for a week in the current season')
        .addStringOption(o => o.setName('league').setDescription('League').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName('week').setDescription('Week or stage').setRequired(true).addChoices(...WEEK_CHOICES))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'home' || focused.name === 'away') {
      return interaction.respond(searchTeams(focused.value));
    }

    if (focused.name === 'game') {
      const leagueAbbr = interaction.options.getString('league');
      if (!leagueAbbr) return interaction.respond([]);
      const league = getLeagueByAbbr(interaction.guildId, leagueAbbr.toUpperCase());
      if (!league) return interaction.respond([]);
      const season = getCurrentSeason(league.id);
      if (!season) return interaction.respond([]);
      const q = focused.value.toUpperCase();
      const choices = getScheduledGames(season.id, { unplayedOnly: true })
        .map(g => ({ name: gameLabel(g), value: String(g.id) }))
        .filter(c => c.name.toUpperCase().includes(q))
        .slice(0, 25);
      return interaction.respond(choices);
    }

    // league
    const query = focused.value.toUpperCase();
    const choices = getAllLeagues(interaction.guildId)
      .filter(l => l.abbr.includes(query) || l.name.toUpperCase().includes(query))
      .slice(0, 25)
      .map(l => ({ name: `${l.abbr} — ${l.name}`, value: l.abbr }));
    return interaction.respond(choices);
  },

  async execute(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'Not authorized.', flags: 64 });
    }
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'record':   return handleRecord(interaction);
      case 'schedule': return handleSchedule(interaction);
      case 'show':     return handleShow(interaction);
      default:         return interaction.reply({ content: 'Unknown subcommand.', flags: 64 });
    }
  },

  // Called from interactionCreate for the `results:record:*` modal submit.
  handleModal,
};

function resolveSeason(interaction) {
  const leagueAbbr = interaction.options.getString('league').toUpperCase();
  const league = getLeagueByAbbr(interaction.guildId, leagueAbbr);
  if (!league) return { error: `League **${leagueAbbr}** not found.` };
  const season = getCurrentSeason(league.id);
  if (!season) return { error: `**${league.name}** has no current season. Create one in the web portal first.` };
  return { league, season };
}

const lbl45 = s => (s.length > 45 ? s.slice(0, 45) : s);

// Opens a modal whose score fields are labeled with the actual team names.
async function handleRecord(interaction) {
  const { season, error } = resolveSeason(interaction);
  if (error) return interaction.reply({ content: error, flags: 64 });

  const gameId = Number(interaction.options.getString('game'));
  const game = getGameById(gameId);
  if (!game || game.season_id !== season.id) {
    return interaction.reply({ content: 'Game not found in the current season. Pick one from autocomplete.', flags: 64 });
  }

  const resultType = interaction.options.getString('result_type') || 'normal';
  const winner = interaction.options.getString('winner') || '';
  if (resultType === 'FR' && !winner) {
    return interaction.reply({ content: 'Pick a `winner` for a Forfeit (FR) result, then run the command.', flags: 64 });
  }

  const homeName = getTeamByAbbrev(game.home_abbrev)?.name || game.home_abbrev;
  const awayName = getTeamByAbbrev(game.away_abbrev)?.name || game.away_abbrev;

  const modal = new ModalBuilder()
    .setCustomId(`results:record:${gameId}:${resultType}:${winner || '-'}`)
    .setTitle(lbl45(`Result — ${game.away_abbrev} @ ${game.home_abbrev}`));

  const rows = [
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('home_score').setLabel(lbl45(`${homeName} score`))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder('e.g. 31')),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('away_score').setLabel(lbl45(`${awayName} score`))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder('e.g. 24')),
  ];
  if (resultType === 'normal') {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('attempts').setLabel('Attempts')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder('e.g. 1')));
  }
  modal.addComponents(...rows);
  await interaction.showModal(modal);
}

// Handles the modal submitted from /results record.
async function handleModal(interaction) {
  // customId: results:record:<gameId>:<resultType>:<winner|->
  const [, , gameIdRaw, resultType = 'normal', winnerRaw] = interaction.customId.split(':');
  const winner = winnerRaw && winnerRaw !== '-' ? winnerRaw : null;
  const game = getGameById(Number(gameIdRaw));
  if (!game) return interaction.reply({ content: 'Game not found.', flags: 64 });

  const num = raw => { const t = (raw ?? '').trim(); return t === '' ? null : Number(t); };
  const homeScore = num(interaction.fields.getTextInputValue('home_score'));
  const awayScore = num(interaction.fields.getTextInputValue('away_score'));
  let attemptsRaw = '';
  try { attemptsRaw = interaction.fields.getTextInputValue('attempts'); } catch { /* no attempts field for FR/FS */ }

  if ([homeScore, awayScore].some(s => s != null && Number.isNaN(s))) {
    return interaction.reply({ content: 'Scores must be whole numbers.', flags: 64 });
  }
  if ((resultType === 'normal' || resultType === 'FS') && (homeScore == null || awayScore == null)) {
    return interaction.reply({ content: 'Both scores are required for normal and Fair Sim (FS) results.', flags: 64 });
  }

  const sim = resultType === 'FR' || resultType === 'FS';
  const attemptsTaken = sim ? 0 : num(attemptsRaw);
  if (attemptsTaken != null && Number.isNaN(attemptsTaken)) {
    return interaction.reply({ content: 'Attempts must be a whole number.', flags: 64 });
  }

  try {
    recordGameResult(game.id, { homeScore, awayScore, attemptsTaken, resultType, winnerSide: winner });

    const winSide = deriveWinnerSide(homeScore, awayScore, resultType, winner);
    const winnerAbbrev = winSide === 'home' ? game.home_abbrev : winSide === 'away' ? game.away_abbrev : 'Tie';
    const scoreLine = (homeScore != null && awayScore != null) ? `${game.home_abbrev} ${homeScore} – ${awayScore} ${game.away_abbrev}` : '_no score_';

    const embed = new EmbedBuilder()
      .setTitle(`Result recorded — ${gameLabel(game)}`)
      .setColor(0x57F287)
      .addFields(
        { name: 'Score', value: scoreLine, inline: true },
        { name: 'Winner', value: winnerAbbrev, inline: true },
        { name: 'Type', value: resultType, inline: true },
      );
    if (attemptsTaken != null) embed.addFields({ name: 'Attempts', value: String(attemptsTaken), inline: true });

    logger.info('Result recorded via Discord modal', { adminId: interaction.user.id, gameId: game.id, resultType });
    await interaction.reply({ embeds: [embed], flags: 64 });
  } catch (err) {
    logger.error('results modal record error', { error: err.message });
    await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 });
  }
}

async function handleSchedule(interaction) {
  const { season, error } = resolveSeason(interaction);
  if (error) return interaction.reply({ content: error, flags: 64 });

  const week = interaction.options.getInteger('week');
  const homeAbbrev = interaction.options.getString('home').toUpperCase();
  const awayAbbrev = interaction.options.getString('away').toUpperCase();

  const home = getTeamByAbbrev(homeAbbrev);
  const away = getTeamByAbbrev(awayAbbrev);
  if (!home || !away) {
    return interaction.reply({ content: 'Home and away must be valid teams (use autocomplete).', flags: 64 });
  }

  const isPostseason = isPostseasonWeek(week) ? 1 : 0;
  insertGame(season.id, week, homeAbbrev, awayAbbrev, isPostseason);
  const wk = weekLabel(week);
  logger.info('Game scheduled via Discord', { adminId: interaction.user.id, seasonId: season.id, week, home: homeAbbrev, away: awayAbbrev });
  await interaction.reply({ content: `Scheduled **${wk}**: ${away.name} @ ${home.name}.`, flags: 64 });
}

async function handleShow(interaction) {
  const { season, error } = resolveSeason(interaction);
  if (error) return interaction.reply({ content: error, flags: 64 });

  const week = interaction.options.getInteger('week');
  const games = getGamesByWeek(season.id, week);
  const wk = weekLabel(week);

  if (!games.length) {
    return interaction.reply({ content: `No games scheduled for **${wk}**.`, flags: 64 });
  }

  const lines = games.map(g => {
    const played = g.result_type !== 'normal' || (g.home_score != null && g.away_score != null);
    if (!played) return `• ${g.away_abbrev} @ ${g.home_abbrev} — _not played_`;
    const winSide = deriveWinnerSide(g.home_score, g.away_score, g.result_type, g.winner_side);
    const tag = g.result_type !== 'normal' ? ` (${g.result_type})` : '';
    const score = (g.home_score != null && g.away_score != null) ? `${g.home_score}–${g.away_score}` : '—';
    const mark = winSide === 'home' ? `**${g.home_abbrev}**` : g.home_abbrev;
    const mark2 = winSide === 'away' ? `**${g.away_abbrev}**` : g.away_abbrev;
    return `• ${mark2} @ ${mark} — ${score}${tag}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`${wk} — ${season.year} results`)
    .setColor(0x5865F2)
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], flags: 64 });
}
