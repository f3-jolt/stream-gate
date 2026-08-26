'use strict';

// Builds the weekly advancement message from the database (replacing the CSV
// schedule sheet). Partitions the week's games into USER GAMES (both sides are
// human coaches) and CPU GAMES (one human coach vs a CPU team), tags the league's
// ping role, and stamps an advancement deadline (36h normally, 48h when there are
// user games — they need longer to schedule). Returns null when the league has no
// current season / no games for the week, so callers fall back to the CSV path.

const { getCurrentSeason, getGamesByWeek } = require('../db/queries');
const { getTeamByAbbrev } = require('./teams');
const { weekLabel: labelForWeek, weekHasGames, weekTasks, weekHours } = require('./weeks');

function teamLabel(abbrev) {
  const t = getTeamByAbbrev(abbrev);
  if (!t) return abbrev;
  if (!t.mascot) return t.name;
  const mascot = t.mascot.replace(/\b\w/g, c => c.toUpperCase()); // normalize casing
  return `${t.name} ${mascot}`;
}

// An admin-only stage carries its own fixed deadline. A stage that plays games
// gets 48h when there are user games (they need time to schedule), else 36h.
function advanceOffsetHours(hasUserGames, weekValue = null) {
  const fixed = weekValue == null ? null : weekHours(weekValue);
  if (fixed != null) return fixed;
  return hasUserGames ? 48 : 36;
}

// Format like "Monday June 22 at 10AM CST" (no minutes when on the hour), in
// US Central time. DST gives CDT/CST automatically.
function formatAdvanceDate(date, timeZone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || '';
  const time = get('minute') === '00'
    ? `${get('hour')}${get('dayPeriod')}`
    : `${get('hour')}:${get('minute')}${get('dayPeriod')}`;
  return `${get('weekday')} ${get('month')} ${get('day')} at ${time} ${get('timeZoneName')}`;
}

function computeAdvanceDate(hasUserGames, nowMs = Date.now(), weekValue = null) {
  const hours = advanceOffsetHours(hasUserGames, weekValue);
  return formatAdvanceDate(new Date(nowMs + hours * 3600 * 1000));
}

// The footers. Everything above a footer — the header, the matchup sections,
// the task list, the advancement deadline — is fixed in buildBody() so every
// league's advancement reads the same way. A league can replace the footer, and
// only the footer, with its own house rules.
const DEFAULT_FOOTER = [
  '## :warning: REMEMBER CPU GAME RULES :warning: ',
  '> CPU Game Participation : The expectation is that you play ALL OF YOUR GAMES. If you do not communicate, then you could be awarded a FORCE LOSS. Key here, communicate and let the commissioner know what is going on so they can make the necessary adjustments. It is ok to miss games, just make it known.',
  '## :warning: STREAMING RULES :warning: ',
  '> You Must Stream : The expectation is that you stream/record ALL OF YOUR GAMES. If you do not stream/record, then you could be awarded a FORCE LOSS.',
].join('\n');

// Nobody plays on an admin-only stage, so the game rules would be noise.
const DEFAULT_ADMIN_FOOTER =
  '> Get your tasks done before the deadline above. If something is going to hold you up, let the commissioner know so they can adjust.';

// The standard frame, identical for every league. An admin-only stage swaps the
// two matchup sections for a single "no games" banner; everything else matches.
// windowStart, when set, turns the fixed deadline into a 24h advancement window
// (windowStart → advanceDate) that the league may advance early within.
function buildBody({ pingRole, weekLabel, season, isAdminWeek, userGames, cpuGames, tasks, advanceDate, windowStart = null }) {
  const lines = [
    `${pingRole} `,
    `# :rotating_light: ${weekLabel} Season ${season} :rotating_light:`,
    '.',
  ];

  if (isAdminWeek) {
    lines.push('```NO GAMES THIS WEEK - ADMIN TASKS ONLY```', '.');
  } else {
    lines.push('```USER GAMES```', userGames, '.', '```CPU GAMES```', cpuGames, '.');
  }

  lines.push("```THIS WEEK'S TASKS```", tasks, '.');

  if (windowStart) {
    lines.push(
      '```ADVANCEMENT WINDOW```',
      `Anytime between \`${windowStart}\` and \`${advanceDate}\`. Requirement to advance early in this window will be that \`all games are played or accounted for.\``,
    );
  } else {
    lines.push('```ADVANCEMENT SCHEDULE [IF NOT SOONER]```', `\`${advanceDate}\``);
  }

  return lines.join('\n');
}

// allowEmpty: when true, a week with no scheduled games still builds a message
// (both sections render "*No Games Scheduled*") instead of returning null. Used
// for a confirmed "advance anyway" on an empty week. A missing current season
// still returns null regardless — there's nothing to build against.
// advanceWindow: render a 24h advancement window ending at the deadline instead
// of the fixed deadline. windowStartOverride carries the client-formatted start
// when the deadline itself was overridden (the server can't parse dateOverride).
function buildDbAdvanceMessage(league, weekValue, {
  dateOverride = null, allowEmpty = false, advanceWindow = false, windowStartOverride = null,
} = {}) {
  const season = getCurrentSeason(league.id);
  if (!season) return null;

  // An admin-only stage (Preseason, a bye week, anything in the offseason) has
  // no games by definition — there's nothing to confirm, so build it regardless.
  const games = getGamesByWeek(season.id, Number(weekValue));
  if (!games.length && !allowEmpty && weekHasGames(weekValue)) return null;

  const weekLabel = labelForWeek(weekValue);
  const isAdminWeek = !weekHasGames(weekValue);

  // USER GAMES: both sides human → "<@home> vs <@away>".
  // CPU GAMES: one human per line, from their perspective — home hosts ("vs Team"),
  // away travels ("at Team"). A coached-vs-coached game flagged non-user emits a
  // line for each coach so nothing involving a user is dropped.
  const userLines = [];
  const cpuLines = [];
  for (const g of games) {
    const homeUser = g.home_discord_id;
    const awayUser = g.away_discord_id;
    if (g.is_user_game && homeUser && awayUser) {
      userLines.push(`<@${homeUser}> vs <@${awayUser}>`);
      continue;
    }
    if (homeUser) cpuLines.push(`<@${homeUser}> vs ${teamLabel(g.away_abbrev)}`);
    if (awayUser) cpuLines.push(`<@${awayUser}> at ${teamLabel(g.home_abbrev)}`);
  }

  const userGames = userLines.length ? userLines.join('\n') : '*No Games Scheduled*';
  const cpuGames = cpuLines.length ? cpuLines.join('\n') : '*No Games Scheduled*';
  const hasUserGames = userLines.length > 0;
  const advanceDate = dateOverride || computeAdvanceDate(hasUserGames, Date.now(), weekValue);
  // The window opens 24h before the deadline. Shifting "now" back 24h before
  // adding the offset lands on exactly that. An overridden deadline is an opaque
  // string here, so its window start must arrive pre-formatted alongside it.
  let windowStart = null;
  if (advanceWindow) {
    windowStart = dateOverride
      ? windowStartOverride
      : computeAdvanceDate(hasUserGames, Date.now() - 24 * 3600 * 1000, weekValue);
  }
  const pingRole = league.ping_role_id ? `<@&${league.ping_role_id}>` : '';

  const taskList = weekTasks(weekValue);
  const tasks = taskList.length
    ? taskList.map(t => `- ${t}`).join('\n')
    : '*Nothing to do but advance*';

  const body = buildBody({
    pingRole, weekLabel, season: season.year, isAdminWeek, userGames, cpuGames, tasks, advanceDate, windowStart,
  });

  // The league's own footer, or the built-in one for this kind of week. The two
  // are kept apart because the game rules make no sense on a stage nobody plays.
  const custom = isAdminWeek ? league.advance_admin_footer : league.advance_footer;
  const footer = (custom && custom.trim()) || (isAdminWeek ? DEFAULT_ADMIN_FOOTER : DEFAULT_FOOTER);

  // Tokens work in a footer too, so house rules can name the week or the deadline.
  const filled = footer
    .replace(/\{pingRole\}/g, pingRole)
    .replace(/\{weekLabel\}/g, weekLabel)
    .replace(/\{week\}/g, weekLabel)
    .replace(/\{season\}/g, String(season.year))
    .replace(/\{userGames\}/g, userGames)
    .replace(/\{cpuGames\}/g, cpuGames)
    .replace(/\{tasks\}/g, tasks)
    .replace(/\{advanceDate\}/g, advanceDate);

  return `${body}\n\n${filled}`;
}

module.exports = {
  buildDbAdvanceMessage, buildBody,
  DEFAULT_FOOTER, DEFAULT_ADMIN_FOOTER,
  formatAdvanceDate, computeAdvanceDate,
};
