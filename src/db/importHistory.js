// Imports career history from the stored CSV export of the league-history
// sheet into the career_history table. One row per gamertag; safe to re-run —
// stats are refreshed in place and any user_id mapping already set is preserved.
//
//   node src/db/importHistory.js            # import the stored CSV
//   node src/db/importHistory.js file.csv   # or another export of the same tab
//
// In production: fly ssh console -C "node src/db/importHistory.js"

const fs = require('fs');
const path = require('path');
const { db, initSchema } = require('./database');
const logger = require('../utils/logger');

// Export of the sheet's "MERGED HISTORY INCLUDE 14" tab — the superset of its
// two summary tabs — kept as-is, spacer columns included.
const CSV_PATH = path.join(__dirname, 'history', 'career-history.csv');
const SOURCE = 'sheet:MERGED HISTORY INCLUDE 14';

// Column positions in the tab (spacer columns sit between the stat groups).
const COL = {
  gamertag: 1,
  cpu_wins: 3, cpu_losses: 4,
  user_wins: 6, user_losses: 7,
  overall_wins: 9, overall_losses: 10,
  conf_titles: 12, bowl_wins: 14, cfp_appearances: 16, national_titles: 18,
  points_total: 20, points_per_game: 22, grade: 24,
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toRecords(rows) {
  const headerIdx = rows.findIndex(r => (r[COL.gamertag] || '').trim().toUpperCase() === 'GAMERTAG');
  if (headerIdx === -1) throw new Error('GAMERTAG header row not found — has the sheet layout changed?');

  const int = v => parseInt(String(v).replace(/,/g, ''), 10) || 0;
  return rows.slice(headerIdx + 1)
    .filter(r => (r[COL.gamertag] || '').trim())
    .map(r => ({
      gamertag: r[COL.gamertag].trim(),
      cpu_wins: int(r[COL.cpu_wins]), cpu_losses: int(r[COL.cpu_losses]),
      user_wins: int(r[COL.user_wins]), user_losses: int(r[COL.user_losses]),
      overall_wins: int(r[COL.overall_wins]), overall_losses: int(r[COL.overall_losses]),
      conf_titles: int(r[COL.conf_titles]),
      bowl_wins: int(r[COL.bowl_wins]),
      cfp_appearances: int(r[COL.cfp_appearances]),
      national_titles: int(r[COL.national_titles]),
      points_total: int(r[COL.points_total]),
      points_per_game: parseFloat(r[COL.points_per_game]) || 0,
      // The sheet writes minus grades with U+2212; store a plain hyphen.
      grade: (r[COL.grade] || '').trim().replace(/−/g, '-') || null,
    }));
}

function importRecords(records) {
  const upsert = db.prepare(`
    INSERT INTO career_history (
      gamertag, cpu_wins, cpu_losses, user_wins, user_losses, overall_wins, overall_losses,
      conf_titles, bowl_wins, cfp_appearances, national_titles,
      points_total, points_per_game, grade, source
    ) VALUES (
      @gamertag, @cpu_wins, @cpu_losses, @user_wins, @user_losses, @overall_wins, @overall_losses,
      @conf_titles, @bowl_wins, @cfp_appearances, @national_titles,
      @points_total, @points_per_game, @grade, @source
    )
    ON CONFLICT(gamertag) DO UPDATE SET
      cpu_wins = excluded.cpu_wins, cpu_losses = excluded.cpu_losses,
      user_wins = excluded.user_wins, user_losses = excluded.user_losses,
      overall_wins = excluded.overall_wins, overall_losses = excluded.overall_losses,
      conf_titles = excluded.conf_titles, bowl_wins = excluded.bowl_wins,
      cfp_appearances = excluded.cfp_appearances, national_titles = excluded.national_titles,
      points_total = excluded.points_total, points_per_game = excluded.points_per_game,
      grade = excluded.grade, source = excluded.source,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    for (const r of records) upsert.run({ ...r, source: SOURCE });
  })();
}

function main() {
  const file = process.argv[2] || CSV_PATH;
  const text = fs.readFileSync(file, 'utf8');

  initSchema();
  const records = toRecords(parseCsv(text));
  importRecords(records);
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM career_history').get();
  logger.info('Imported career history', { rows: records.length, total: c, file });
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    logger.error('Career history import failed', { error: err.message });
    process.exit(1);
  }
}

module.exports = { parseCsv, toRecords };
