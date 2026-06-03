function parseStreamTitle(title, keyword = 'GOI') {
  if (!title) return { isMatch: false, abbr: null };
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b\\s*([A-Z0-9]+)?`, 'i');
  const match = title.match(pattern);

  if (!match) return { isMatch: false, abbr: null };

  const abbr = match[1] ? match[1].toUpperCase().trim() : null;
  return { isMatch: true, abbr };
}

module.exports = { parseStreamTitle };
