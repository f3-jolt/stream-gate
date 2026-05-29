const fs = require('fs');
const path = require('path');

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

function searchTeams(query) {
  const q = query.toUpperCase();
  return getTeams()
    .filter(t => t.name.toUpperCase().includes(q) || t.abbrev.toUpperCase().includes(q) || t.conference.toUpperCase().includes(q))
    .slice(0, 25)
    .map(t => ({ name: t.name, value: t.abbrev }));
}

function getTeamByAbbrev(abbrev) {
  return getTeams().find(t => t.abbrev.toUpperCase() === abbrev.toUpperCase()) || null;
}

function searchCustomTeams(query) {
  const q = query.toUpperCase();
  return getTeams()
    .filter(t => t.conference === 'Custom' && (t.name.toUpperCase().includes(q) || t.abbrev.toUpperCase().includes(q)))
    .slice(0, 25)
    .map(t => ({ name: t.name, value: t.abbrev }));
}

module.exports = { getTeams, searchTeams, searchCustomTeams, getTeamByAbbrev, invalidateTeamsCache, TEAMS_JSON_PATH };
