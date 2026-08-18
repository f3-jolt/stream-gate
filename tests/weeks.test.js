const {
  WEEKS, GAME_WEEKS, weekLabel, weekHasGames, isPostseasonWeek,
  isValidWeek, weeksForSeason, nextWeek,
} = require('../src/utils/weeks');

const labels = year => weeksForSeason(year).map(w => w.label);

describe('week values', () => {
  test('the values that carry games are the frozen 0-19 the database already stores', () => {
    expect(GAME_WEEKS.map(w => w.value)).toEqual([...Array(20).keys()]);
    expect(weekLabel(15)).toBe('CCW');
    expect(weekLabel(19)).toBe('National Championship');
  });

  test('every value is unique', () => {
    expect(new Set(WEEKS.map(w => w.value)).size).toBe(WEEKS.length);
  });

  test('postseason is CCW onward, and only for weeks with games', () => {
    expect(isPostseasonWeek(14)).toBe(false);
    expect(isPostseasonWeek(15)).toBe(true);
    expect(isPostseasonWeek(19)).toBe(true);
    expect(isPostseasonWeek(20)).toBe(false); // Week 15 bye — value is high, no games
    expect(isPostseasonWeek(28)).toBe(false); // National Signing Day
  });

  test('admin-only stages are flagged as having no games', () => {
    expect(weekHasGames(-1)).toBe(false);  // Preseason
    expect(weekHasGames(0)).toBe(true);    // Week 0
    expect(weekHasGames(30)).toBe(false);  // Offseason
  });

  test('isValidWeek rejects anything not in the list', () => {
    expect(isValidWeek(-1)).toBe(true);
    expect(isValidWeek(30)).toBe(true);
    expect(isValidWeek(31)).toBe(false);
    expect(isValidWeek(-2)).toBe(false);
  });
});

describe('weeksForSeason', () => {
  test('2026 takes its bye at Week 15, before CCW', () => {
    const l = labels(2026);
    expect(l.slice(l.indexOf('Week 14'), l.indexOf('Week 14') + 3))
      .toEqual(['Week 14', 'Week 15', 'CCW']);
    expect(l).not.toContain('Week 16');
  });

  test('2027 and later play a 16th week and take their bye after CCW', () => {
    const l = labels(2027);
    expect(l.slice(l.indexOf('Week 14'), l.indexOf('Week 14') + 4))
      .toEqual(['Week 14', 'CCW', 'Week 16', 'Bowl Week 1']);
    expect(l).not.toContain('Week 15');
    expect(labels(2030)).toEqual(l);
  });

  test('an unknown year leaves out both year-specific byes', () => {
    const l = labels(null);
    expect(l).not.toContain('Week 15');
    expect(l).not.toContain('Week 16');
  });

  test('every season runs Preseason first and Offseason last', () => {
    for (const year of [2026, 2027, null]) {
      const l = labels(year);
      expect(l[0]).toBe('Preseason');
      expect(l[l.length - 1]).toBe('Offseason');
    }
  });
});

describe('nextWeek', () => {
  test('a season that has never advanced starts at Preseason', () => {
    expect(nextWeek(null, 2026)).toBe(-1);
  });

  test('walks the season order, not the numeric value', () => {
    expect(nextWeek(-1, 2026)).toBe(0);   // Preseason -> Week 0
    expect(nextWeek(14, 2026)).toBe(20);  // Week 14 -> Week 15 (bye)
    expect(nextWeek(20, 2026)).toBe(15);  // Week 15 -> CCW
    expect(nextWeek(15, 2026)).toBe(16);  // CCW -> Bowl Week 1
    expect(nextWeek(14, 2027)).toBe(15);  // Week 14 -> CCW
    expect(nextWeek(15, 2027)).toBe(21);  // CCW -> Week 16 (bye)
    expect(nextWeek(21, 2027)).toBe(16);  // Week 16 -> Bowl Week 1
    expect(nextWeek(19, 2026)).toBe(22);  // National Championship -> End of Season
    expect(nextWeek(28, 2026)).toBe(29);  // Signing Day -> Training Results
  });

  test('the last stage stays put', () => {
    expect(nextWeek(30, 2026)).toBe(30);
  });

  test('a stage that does not apply to this season falls back to the start', () => {
    expect(nextWeek(20, 2027)).toBe(-1); // 2027 has no Week 15
    expect(nextWeek(99, 2026)).toBe(-1);
  });

  test('advancing every stage in turn visits the whole season exactly once', () => {
    for (const year of [2026, 2027]) {
      const expected = weeksForSeason(year).map(w => w.value);
      const walked = [nextWeek(null, year)];
      while (walked.length < expected.length) {
        walked.push(nextWeek(walked[walked.length - 1], year));
      }
      expect(walked).toEqual(expected);
    }
  });
});

describe('tasks and deadlines', () => {
  const { weekTasks, weekHours } = require('../src/utils/weeks');

  test('every stage has a non-empty task list and every admin stage has a fixed deadline', () => {
    for (const w of WEEKS) {
      expect(w.tasks.length).toBeGreaterThan(0);
      if (!w.games) expect(typeof w.hours).toBe('number');
    }
  });

  test('game weeks leave the deadline to the 36h/48h rule', () => {
    for (const w of GAME_WEEKS) expect(weekHours(w.value)).toBeNull();
  });

  test('a plain game week is practice, recruiting, and playing', () => {
    expect(weekTasks(5)).toEqual(['Set Practice Schedule', 'Recruit Players', 'Play Games']);
  });

  test('a bye is a game week without the game', () => {
    const play = weekTasks(5);
    expect(weekTasks(20)).toEqual(play.filter(t => t !== 'Play Games')); // 2026 Week 15
    expect(weekTasks(21)).toEqual(weekTasks(20));                        // 2027+ Week 16
    expect(weekTasks(20)).not.toContain('Play Games');
  });

  test('the postseason stacks staff and job offers onto the game week tasks', () => {
    expect(weekTasks(15)).toEqual([...weekTasks(5), 'Manage Staff']);          // CCW: staff only
    expect(weekTasks(17)).toEqual([...weekTasks(5), 'Manage Staff', 'Evaluate Job Offers']);
    expect(weekTasks(18)).toEqual(weekTasks(17));
    expect(weekTasks(19)).toEqual(weekTasks(17));
  });

  test('one-off tasks land on their own stage only', () => {
    expect(weekTasks(16)[0]).toBe('View Early National Signing Day'); // Bowl Week 1
    expect(weekTasks(17)).not.toContain('View Early National Signing Day');
    expect(weekTasks(24)).toContain('View Draft Results');            // Recruiting Week 1
    expect(weekTasks(25)).not.toContain('View Draft Results');
  });

  test('admin deadlines are 24h for Preseason and Training Results, 12h elsewhere', () => {
    expect(weekHours(-1)).toBe(24);  // Preseason
    expect(weekHours(29)).toBe(24);  // Training Results
    for (const v of [20, 21, 22, 23, 24, 25, 26, 27, 28, 30]) expect(weekHours(v)).toBe(12);
  });
});

describe('advancement messages', () => {
  const {
    buildBody, DEFAULT_FOOTER, DEFAULT_ADMIN_FOOTER, computeAdvanceDate, formatAdvanceDate,
  } = require('../src/utils/advance');

  const frame = extra => buildBody({
    pingRole: '<@&1>', weekLabel: 'Week 5', season: 2026,
    userGames: 'U', cpuGames: 'C', tasks: '- Play Games',
    advanceDate: 'Monday June 22 at 10AM CST', isAdminWeek: false, ...extra,
  });

  test('the frame carries the header, matchups, tasks, and deadline', () => {
    const body = frame();
    expect(body).toContain('# :rotating_light: Week 5 Season 2026 :rotating_light:');
    expect(body).toContain('```USER GAMES```');
    expect(body).toContain('```CPU GAMES```');
    expect(body).toContain("```THIS WEEK'S TASKS```");
    expect(body).toContain('```ADVANCEMENT SCHEDULE [IF NOT SOONER]```');
    expect(body).toContain('`Monday June 22 at 10AM CST`');
  });

  test('an admin stage swaps the matchups for a no-games banner, keeping the rest', () => {
    const body = frame({ isAdminWeek: true, weekLabel: 'National Signing Day' });
    expect(body).toContain('```NO GAMES THIS WEEK - ADMIN TASKS ONLY```');
    expect(body).not.toContain('USER GAMES');
    expect(body).not.toContain('CPU GAMES');
    expect(body).toContain("```THIS WEEK'S TASKS```");
    expect(body).toContain('```ADVANCEMENT SCHEDULE [IF NOT SOONER]```');
  });

  test('the frame carries no footer — that is appended separately', () => {
    expect(frame()).not.toContain('STREAMING RULES');
    expect(frame({ isAdminWeek: true })).not.toContain(DEFAULT_ADMIN_FOOTER);
  });

  test('the default footers suit their week type', () => {
    expect(DEFAULT_FOOTER).toContain('STREAMING RULES');
    expect(DEFAULT_FOOTER).toContain('CPU GAME RULES');
    expect(DEFAULT_ADMIN_FOOTER).not.toContain('STREAMING RULES');
    expect(DEFAULT_ADMIN_FOOTER).not.toContain('GAMES');
  });

  test('the deadline follows the stage, falling back to 36h/48h on game weeks', () => {
    const NOW = Date.UTC(2026, 0, 1, 12);
    const at = (hasUserGames, week) => computeAdvanceDate(hasUserGames, NOW, week);
    // What the deadline reads when it lands `hours` from now.
    const h = hours => formatAdvanceDate(new Date(NOW + hours * 3600e3));

    expect(at(false, -1)).toBe(h(24));  // Preseason: fixed 24h
    expect(at(true,  -1)).toBe(h(24));  // ...regardless of user games
    expect(at(false, 22)).toBe(h(12));  // End of Season: fixed 12h
    expect(at(false,  5)).toBe(h(36));  // game week, CPU only
    expect(at(true,   5)).toBe(h(48));  // game week with user games
  });
});
