'use strict';

// The canonical, ordered list of weeks/stages a season moves through.
//
// ORDER vs VALUE. `value` is what lands in the database (games.week and
// seasons.current_week), so the values for weeks that carry games are frozen at
// what they have always been (0-14 regular season, 15 CCW, 16-19 postseason) —
// renumbering them would silently rewrite every game already recorded. The
// stages added later (Preseason, the bye weeks, and the whole offseason) take
// values from 20 up, which have never been used. That means `value` is NOT in
// playing order; the array order below is the only ordering that matters, and
// nextWeek() walks it rather than doing arithmetic on the number.
//
// `games` marks whether coaches play that week. A `games: false` stage is admin
// work only — no user games, no CPU games, nothing to schedule — so it never
// appears in the schedule builder or the results grid.
//
// `onlyYears` restricts a stage to certain season years: the game gives 2026 a
// bye at Week 15 before the conference championships, while 2027 and later run a
// 16th week of football and take their bye after CCW instead.

// A bye is a game week without the game — the practice and recruiting work
// still has to happen. The postseason stages stack extra jobs on top.
const BYE_TASKS  = ['Set Practice Schedule', 'Recruit Players'];
const GAME_TASKS = [...BYE_TASKS, 'Play Games'];
const BOWL_TASKS = [...GAME_TASKS, 'Manage Staff', 'Evaluate Job Offers'];

// `tasks` is what the advancement message lists for the stage. `hours` is the
// advancement deadline: the admin-only stages each have a fixed one, while the
// stages that play games leave it null and fall back to the 36h/48h rule (user
// games need the longer window to get scheduled).
const WEEKS = [
  { value: -1, label: 'Preseason',                    short: 'Pre',      games: false, hours: 24,
    tasks: ['Hire Staff', 'Recruit Players', 'Define Blueprint', 'Commissioner Set Schedules'] },
  { value:  0, label: 'Week 0',                       short: 'W0',       games: true,  tasks: GAME_TASKS },
  { value:  1, label: 'Week 1',                       short: 'W1',       games: true,  tasks: GAME_TASKS },
  { value:  2, label: 'Week 2',                       short: 'W2',       games: true,  tasks: GAME_TASKS },
  { value:  3, label: 'Week 3',                       short: 'W3',       games: true,  tasks: GAME_TASKS },
  { value:  4, label: 'Week 4',                       short: 'W4',       games: true,  tasks: GAME_TASKS },
  { value:  5, label: 'Week 5',                       short: 'W5',       games: true,  tasks: GAME_TASKS },
  { value:  6, label: 'Week 6',                       short: 'W6',       games: true,  tasks: GAME_TASKS },
  { value:  7, label: 'Week 7',                       short: 'W7',       games: true,  tasks: GAME_TASKS },
  { value:  8, label: 'Week 8',                       short: 'W8',       games: true,  tasks: GAME_TASKS },
  { value:  9, label: 'Week 9',                       short: 'W9',       games: true,  tasks: GAME_TASKS },
  { value: 10, label: 'Week 10',                      short: 'W10',      games: true,  tasks: GAME_TASKS },
  { value: 11, label: 'Week 11',                      short: 'W11',      games: true,  tasks: GAME_TASKS },
  { value: 12, label: 'Week 12',                      short: 'W12',      games: true,  tasks: GAME_TASKS },
  { value: 13, label: 'Week 13',                      short: 'W13',      games: true,  tasks: GAME_TASKS },
  { value: 14, label: 'Week 14',                      short: 'W14',      games: true,  tasks: GAME_TASKS },
  { value: 20, label: 'Week 15',                      short: 'W15',      games: false, hours: 12,
    tasks: BYE_TASKS, onlyYears: y => y === 2026 },
  { value: 15, label: 'CCW',                          short: 'CCW',      games: true,
    tasks: [...GAME_TASKS, 'Manage Staff'] },
  { value: 21, label: 'Week 16',                      short: 'W16',      games: false, hours: 12,
    tasks: BYE_TASKS, onlyYears: y => y >= 2027 },
  { value: 16, label: 'Bowl Week 1',                  short: 'BW1',      games: true,
    tasks: ['View Early National Signing Day', ...BOWL_TASKS] },
  { value: 17, label: 'Bowl Week 2',                  short: 'BW2',      games: true,  tasks: BOWL_TASKS },
  { value: 18, label: 'CFP Semi-Finals',              short: 'CFP Semi', games: true,  tasks: BOWL_TASKS },
  { value: 19, label: 'National Championship',        short: 'NC',       games: true,  tasks: BOWL_TASKS },
  { value: 22, label: 'End of Season',                short: 'EOS',      games: false, hours: 12,
    tasks: ['Set Next Season NIL', 'Facility Upgrades'] },
  { value: 23, label: 'Players Leaving',              short: 'Leaving',  games: false, hours: 12,
    tasks: ['Players Leaving'] },
  { value: 24, label: 'Offseason Recruiting Week 1',  short: 'REC1',     games: false, hours: 12,
    tasks: ['View Draft Results', 'Recruit Players/Transfers'] },
  { value: 25, label: 'Offseason Recruiting Week 2',  short: 'REC2',     games: false, hours: 12,
    tasks: ['Recruit Players/Transfers'] },
  { value: 26, label: 'Offseason Recruiting Week 3',  short: 'REC3',     games: false, hours: 12,
    tasks: ['Recruit Players/Transfers'] },
  { value: 27, label: 'Offseason Recruiting Week 4',  short: 'REC4',     games: false, hours: 12,
    tasks: ['Recruit Players/Transfers'] },
  { value: 28, label: 'National Signing Day',         short: 'NSD',      games: false, hours: 12,
    tasks: ['View National Signing Day', 'Position Changes'] },
  { value: 29, label: 'Training Results',             short: 'Training', games: false, hours: 24,
    tasks: ['View and Upgrade Players'] },
  { value: 30, label: 'Offseason',                    short: 'Off',      games: false, hours: 12,
    tasks: ['Encourage Transfers', 'Commissioner Set Custom Conferences'] },
];

const BY_VALUE = new Map(WEEKS.map(w => [w.value, w]));

// Weeks that carry games, in playing order — what the schedule builder and the
// results grid offer. Their values happen to run 0..19 contiguously.
const GAME_WEEKS = WEEKS.filter(w => w.games);

// First game week after the regular season — games from here on are postseason.
const FIRST_POSTSEASON_WEEK = 15;

// The last stage of a season. Advancing from here stays put.
const MAX_WEEK = WEEKS[WEEKS.length - 1].value;

function getWeek(value) {
  return BY_VALUE.get(Number(value)) || null;
}

function weekLabel(value) {
  return getWeek(value)?.label ?? `Week ${value}`;
}

function weekShort(value) {
  return getWeek(value)?.short ?? `W${value}`;
}

// True when coaches play games that week; unknown values are treated as game
// weeks so nothing already scheduled disappears.
function weekHasGames(value) {
  return getWeek(value)?.games ?? true;
}

// The stage's task list, in the order it should be worked through.
function weekTasks(value) {
  return getWeek(value)?.tasks ?? [];
}

// The stage's fixed advancement deadline in hours, or null when it follows the
// 36h/48h rule that keys off whether there are user games to schedule.
function weekHours(value) {
  return getWeek(value)?.hours ?? null;
}

function isPostseasonWeek(value) {
  return weekHasGames(value) && Number(value) >= FIRST_POSTSEASON_WEEK;
}

function isValidWeek(value) {
  return BY_VALUE.has(Number(value));
}

// The stages that apply to one season. A year of null/undefined means "we don't
// know yet" — the year-restricted bye weeks are left out rather than guessed at.
function weeksForSeason(year) {
  const y = Number(year);
  return WEEKS.filter(w => !w.onlyYears || (Number.isFinite(y) && w.onlyYears(y)));
}

// The stage to advance to next, given a season's active week. A season that has
// never advanced (null) starts at the first stage; the last stage stays put. An
// active week that doesn't apply to this season year (or isn't a known stage at
// all) also falls back to the first stage rather than guessing a position.
function nextWeek(currentWeek, year) {
  const weeks = weeksForSeason(year);
  if (currentWeek == null) return weeks[0].value;
  const i = weeks.findIndex(w => w.value === Number(currentWeek));
  if (i === -1) return weeks[0].value;
  return weeks[Math.min(i + 1, weeks.length - 1)].value;
}

// value -> label, for the callers that only need the lookup.
const WEEK_LABELS = Object.fromEntries(WEEKS.map(w => [w.value, w.label]));

module.exports = {
  WEEKS, GAME_WEEKS, WEEK_LABELS, MAX_WEEK, FIRST_POSTSEASON_WEEK,
  getWeek, weekLabel, weekShort, weekHasGames, weekTasks, weekHours, isPostseasonWeek, isValidWeek,
  weeksForSeason, nextWeek,
};
