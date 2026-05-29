const path = require('path');

let _cache = null;

function getTeams() {
  if (_cache) return _cache;
  const data = require(path.join(process.cwd(), 'src/db/teams/ncca-teams.json'));
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

module.exports = { getTeams, searchTeams, getTeamByAbbrev };
