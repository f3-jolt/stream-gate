'use strict';

const WEEK_LABELS = {
  0: 'Week 0', 1: 'Week 1', 2: 'Week 2', 3: 'Week 3', 4: 'Week 4',
  5: 'Week 5', 6: 'Week 6', 7: 'Week 7', 8: 'Week 8', 9: 'Week 9',
  10: 'Week 10', 11: 'Week 11', 12: 'Week 12', 13: 'Week 13', 14: 'Week 14',
  15: 'CCW', 16: 'Bowl Week 1', 17: 'Bowl Week 2',
  18: 'CFP Semi Finals', 19: 'National Championship',
};

function parseScheduleCell(csvText, row, col) {
  let r = 0, c = 0;
  let i = 0;
  let inQuote = false;
  let cell = '';

  while (i < csvText.length) {
    const ch = csvText[i];

    if (inQuote) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ',') {
        if (r === row && c === col) return cell;
        c++;
        cell = '';
        i++;
      } else if (ch === '\n' || (ch === '\r' && csvText[i + 1] === '\n')) {
        if (r === row && c === col) return cell;
        r++;
        c = 0;
        cell = '';
        i += ch === '\r' ? 2 : 1;
      } else {
        cell += ch;
        i++;
      }
    }
  }

  if (r === row && c === col) return cell;
  return null;
}

// Matches the first date (with optional leading weekday and trailing time) in a message.
// Examples matched: "Monday, August 26th", "August 26 at 9 PM ET", "8/26 at 8:00 PM EST"
const DATETIME_RE = /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:AM|PM)(?:\s+[A-Z]{2,4})?)?/i;

function applyDateOverride(message, dateOverride) {
  if (!dateOverride) return message;
  if (DATETIME_RE.test(message)) return message.replace(DATETIME_RE, dateOverride);
  return `${message}\n\nDate override: ${dateOverride}`;
}

function parseMatchups(message) {
  const re = /<@(\d+)>\s+vs\s+<@(\d+)>/g;
  const matchups = [];
  let m;
  while ((m = re.exec(message)) !== null) matchups.push([m[1], m[2]]);
  return matchups;
}

module.exports = { WEEK_LABELS, parseScheduleCell, parseMatchups, applyDateOverride };
