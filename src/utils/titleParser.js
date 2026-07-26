// Parses a stream title for the guild's trigger keyword (default "GOI") and,
// optionally, the league abbreviation that follows it.
//
// `knownAbbrs` is the list of league keywords for the guild. When supplied, the
// parser also recognizes an abbr joined tightly to the keyword — with a
// dash/colon/slash/pipe, or no separator at all ("GOIOPEN", "GOI-OPEN",
// "GOI : OPEN"). This is gated on the known list so words that merely start with
// the keyword (GOING, EGOIST) and descriptive prose after it
// ("GOI - Beta League Finals") can never be misread as a league.
function parseStreamTitle(title, keyword = 'GOI', knownAbbrs = []) {
  if (!title) return { isMatch: false, abbr: null };
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const k = esc(keyword);

  // Preferred: keyword joined to a KNOWN league abbr by any run of separators
  // (whitespace, underscore, dash, colon, slash, pipe) or nothing at all.
  if (knownAbbrs && knownAbbrs.length) {
    const alts = [...new Set(knownAbbrs.map(a => String(a).toUpperCase()).filter(Boolean))]
      .sort((a, b) => b.length - a.length) // longest first so REBUILD wins over any prefix
      .map(esc)
      .join('|');
    if (alts) {
      const joined = new RegExp(`(?<![A-Za-z0-9])${k}[\\s\\-:_/|]*(${alts})(?![A-Za-z0-9])`, 'i');
      const jm = title.match(joined);
      if (jm) return { isMatch: true, abbr: jm[1].toUpperCase() };
    }
  }

  // Fallback: keyword as a standalone token, optionally followed (after whitespace
  // or underscores) by a free-form abbr token. Preserves the original behavior for
  // abbrs not in the known list and for a bare keyword with no abbr. Alphanumeric
  // boundaries (not \b, since "_" is a word char) keep underscore-delimited titles
  // like "TxState_GOI_TCM" matching.
  const pattern = new RegExp(`(?<![A-Za-z0-9])${k}(?![A-Za-z0-9])[\\s_]*([A-Z0-9]+)?`, 'i');
  const match = title.match(pattern);
  if (!match) return { isMatch: false, abbr: null };

  const abbr = match[1] ? match[1].toUpperCase().trim() : null;
  return { isMatch: true, abbr };
}

module.exports = { parseStreamTitle };
