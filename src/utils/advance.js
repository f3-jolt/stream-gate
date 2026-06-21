'use strict';

// Builds the weekly advancement message from the database (replacing the CSV
// schedule sheet). Returns a message string with "<@id> vs <@id>" lines for
// user games (so parseMatchups() / thread creation keep working) and team-name
// text for CPU games — or null when the league has no current season / no games
// for the week, in which case callers fall back to the CSV schedule_url path.

const { getCurrentSeason, getGamesByWeek } = require('../db/queries');
const { getTeamByAbbrev } = require('./teams');
const { WEEK_LABELS } = require('./schedule');

function teamLabel(abbrev) {
  const t = getTeamByAbbrev(abbrev);
  return t ? t.name : abbrev;
}

const DEFAULT_TEMPLATE = '**{weekLabel} Matchups**\n\n{matchups}';

function buildDbAdvanceMessage(league, weekValue) {
  const season = getCurrentSeason(league.id);
  if (!season) return null;

  const games = getGamesByWeek(season.id, Number(weekValue));
  if (!games.length) return null;

  const weekLabel = WEEK_LABELS[Number(weekValue)] ?? `Week ${weekValue}`;
  const matchups = games.map(g => {
    if (g.is_user_game && g.home_discord_id && g.away_discord_id) {
      return `<@${g.home_discord_id}> vs <@${g.away_discord_id}>`;
    }
    return `${teamLabel(g.home_abbrev)} vs ${teamLabel(g.away_abbrev)}`;
  }).join('\n');

  const tpl = league.advance_template && league.advance_template.trim()
    ? league.advance_template
    : DEFAULT_TEMPLATE;

  return tpl
    .replace(/\{weekLabel\}/g, weekLabel)
    .replace(/\{week\}/g, weekLabel)
    .replace(/\{matchups\}/g, matchups);
}

module.exports = { buildDbAdvanceMessage, DEFAULT_TEMPLATE };
