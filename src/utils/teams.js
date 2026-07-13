const path = require('path');
const { db } = require('../db/database');

// The bundled JSON is now only a seed baseline (see seedTeamsIfEmpty in
// database.js). At runtime every lookup reads the `teams` table so edits made
// through the portal/bot persist on the data volume.
const TEAMS_JSON_PATH = path.join(process.cwd(), 'src/db/teams/ncca-teams.json');

// Kept for backwards compatibility; the DB is the live source now, so there is
// no in-process cache to clear.
function invalidateTeamsCache() {}

function rowToTeam(row) {
  return {
    name: row.name,
    abbrev: row.abbrev,
    conference: row.conference,
    mascot: row.mascot,
    colors: JSON.parse(row.colors || '[]'),
    pic: row.pic || null,
    logoBuffer: row.logo || null,
    active: row.active,
    is_custom: row.is_custom,
  };
}

// Active teams only — used for selection catalogs.
function getTeams() {
  return db.prepare('SELECT * FROM teams WHERE active = 1 ORDER BY name').all().map(rowToTeam);
}

// Lookups resolve regardless of active state so historical schedules/results
// referencing a deactivated team still render.
function getTeamByAbbrev(abbrev) {
  const row = db.prepare('SELECT * FROM teams WHERE abbrev = ? COLLATE NOCASE').get(abbrev);
  return row ? rowToTeam(row) : null;
}

// Typeahead for team pickers: active teams, custom ones first, capped at 25.
function searchTeams(query) {
  const q = query.toUpperCase();
  return db.prepare('SELECT * FROM teams WHERE active = 1 ORDER BY is_custom DESC, name').all()
    .filter(t =>
      t.name.toUpperCase().includes(q) ||
      t.abbrev.toUpperCase().includes(q) ||
      (t.conference || '').toUpperCase().includes(q))
    .slice(0, 25)
    .map(t => ({ name: t.name, value: t.abbrev }));
}

function searchCustomTeams(query) {
  const q = query.toUpperCase();
  return db.prepare('SELECT * FROM teams WHERE is_custom = 1 AND active = 1 ORDER BY name').all()
    .filter(t => t.name.toUpperCase().includes(q) || t.abbrev.toUpperCase().includes(q))
    .slice(0, 25)
    .map(t => ({ name: t.name, value: t.abbrev }));
}

module.exports = { getTeams, searchTeams, searchCustomTeams, getTeamByAbbrev, invalidateTeamsCache, TEAMS_JSON_PATH };
