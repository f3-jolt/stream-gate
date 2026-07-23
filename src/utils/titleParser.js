function parseStreamTitle(title, keyword = 'GOI') {
  if (!title) return { isMatch: false, abbr: null };
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Treat only alphanumerics as "word" chars for the boundary check (NOT underscore),
  // so underscore-delimited titles like "TxState_GOI_TCM" match. Separators before the
  // league abbreviation may be whitespace or underscores.
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])[\\s_]*([A-Z0-9]+)?`, 'i');
  const match = title.match(pattern);

  if (!match) return { isMatch: false, abbr: null };

  const abbr = match[1] ? match[1].toUpperCase().trim() : null;
  return { isMatch: true, abbr };
}

module.exports = { parseStreamTitle };
