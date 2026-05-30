const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');

const TEAMS_JSON_PATH = path.join(process.cwd(), 'src/db/teams/ncca-teams.json');

let _cache = null;

function getTeams() {
  if (_cache) return _cache;
  const data = JSON.parse(fs.readFileSync(TEAMS_JSON_PATH, 'utf8'));
  _cache = Object.entries(data).map(([name, info]) => ({
    name,
    abbrev: info.abbrev,
    conference: info.conference,
    pic: info.pic,
    mascot: info.mascot,
    colors: info.colors || [],
  }));
  return _cache;
}

function invalidateTeamsCache() {
  _cache = null;
}

function rowToTeam(row) {
  return {
    name: row.name,
    abbrev: row.abbrev,
    conference: 'Custom',
    mascot: row.mascot,
    colors: JSON.parse(row.colors || '[]'),
    pic: null,
    logoBuffer: row.logo || null,
  };
}

function getTeamByAbbrev(abbrev) {
  const customRow = db.prepare('SELECT * FROM custom_teams WHERE abbrev = ? COLLATE NOCASE').get(abbrev);
  if (customRow) return rowToTeam(customRow);
  return getTeams().find(t => t.abbrev.toUpperCase() === abbrev.toUpperCase()) || null;
}

function searchTeams(query) {
  const q = query.toUpperCase();
  const customMatches = db.prepare('SELECT * FROM custom_teams ORDER BY name').all()
    .filter(t => t.name.toUpperCase().includes(q) || t.abbrev.toUpperCase().includes(q))
    .map(t => ({ name: t.name, value: t.abbrev }));

  const ncaaMatches = getTeams()
    .filter(t => t.name.toUpperCase().includes(q) || t.abbrev.toUpperCase().includes(q) || t.conference.toUpperCase().includes(q))
    .slice(0, 25 - customMatches.length)
    .map(t => ({ name: t.name, value: t.abbrev }));

  return [...customMatches, ...ncaaMatches].slice(0, 25);
}

function searchCustomTeams(query) {
  const q = query.toUpperCase();
  return db.prepare('SELECT * FROM custom_teams ORDER BY name').all()
    .filter(t => t.name.toUpperCase().includes(q) || t.abbrev.toUpperCase().includes(q))
    .slice(0, 25)
    .map(t => ({ name: t.name, value: t.abbrev }));
}

module.exports = { getTeams, searchTeams, searchCustomTeams, getTeamByAbbrev, invalidateTeamsCache, TEAMS_JSON_PATH };
