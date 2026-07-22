'use strict';

// Builds the weekly advancement message from the database (replacing the CSV
// schedule sheet). Partitions the week's games into USER GAMES (both sides are
// human coaches) and CPU GAMES (one human coach vs a CPU team), tags the league's
// ping role, and stamps an advancement deadline (36h normally, 48h when there are
// user games — they need longer to schedule). Returns null when the league has no
// current season / no games for the week, so callers fall back to the CSV path.

const { getCurrentSeason, getGamesByWeek } = require('../db/queries');
const { getTeamByAbbrev } = require('./teams');
const { WEEK_LABELS } = require('./schedule');

function teamLabel(abbrev) {
  const t = getTeamByAbbrev(abbrev);
  if (!t) return abbrev;
  if (!t.mascot) return t.name;
  const mascot = t.mascot.replace(/\b\w/g, c => c.toUpperCase()); // normalize casing
  return `${t.name} ${mascot}`;
}

// 48h when there are user games (they need time to schedule), else 36h.
function advanceOffsetHours(hasUserGames) {
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

function computeAdvanceDate(hasUserGames, nowMs = Date.now()) {
  return formatAdvanceDate(new Date(nowMs + advanceOffsetHours(hasUserGames) * 3600 * 1000));
}

const DEFAULT_TEMPLATE = [
  '{pingRole} ',
  '# :rotating_light: {weekLabel} Season {season} :rotating_light:',
  '.',
  '```USER GAMES```',
  '{userGames}',
  '.',
  '```CPU GAMES```',
  '{cpuGames}',
  '.',
  '```ADVANCEMENT SCHEDULE [IF NOT SOONER]```',
  '`{advanceDate}`',
  '',
  '## :warning: REMEMBER CPU GAME RULES :warning: ',
  '> CPU Game Participation : The expectation is that you play ALL OF YOUR GAMES. If you do not communicate, then you could be awarded a FORCE LOSS. Key here, communicate and let the commissioner know what is going on so they can make the necessary adjustments. It is ok to miss games, just make it known.',
  '## :warning: STREAMING RULES :warning: ',
  '> You Must Stream : The expectation is that you stream/record ALL OF YOUR GAMES. If you do not stream/record, then you could be awarded a FORCE LOSS.',
].join('\n');

// allowEmpty: when true, a week with no scheduled games still builds a message
// (both sections render "*No Games Scheduled*") instead of returning null. Used
// for a confirmed "advance anyway" on an empty week. A missing current season
// still returns null regardless — there's nothing to build against.
function buildDbAdvanceMessage(league, weekValue, { dateOverride = null, allowEmpty = false } = {}) {
  const season = getCurrentSeason(league.id);
  if (!season) return null;

  const games = getGamesByWeek(season.id, Number(weekValue));
  if (!games.length && !allowEmpty) return null;

  const weekLabel = WEEK_LABELS[Number(weekValue)] ?? `Week ${weekValue}`;

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
  const advanceDate = dateOverride || computeAdvanceDate(userLines.length > 0);
  const pingRole = league.ping_role_id ? `<@&${league.ping_role_id}>` : '';

  const tpl = (league.advance_template && league.advance_template.trim())
    ? league.advance_template
    : DEFAULT_TEMPLATE;

  return tpl
    .replace(/\{pingRole\}/g, pingRole)
    .replace(/\{weekLabel\}/g, weekLabel)
    .replace(/\{week\}/g, weekLabel)
    .replace(/\{season\}/g, String(season.year))
    .replace(/\{userGames\}/g, userGames)
    .replace(/\{cpuGames\}/g, cpuGames)
    .replace(/\{matchups\}/g, [userGames, cpuGames].join('\n')) // back-compat
    .replace(/\{advanceDate\}/g, advanceDate);
}

module.exports = { buildDbAdvanceMessage, DEFAULT_TEMPLATE, formatAdvanceDate, computeAdvanceDate };
