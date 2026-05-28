const GOI_PATTERN = /\bGOI\b\s*([A-Z0-9]+)?/i;

function parseStreamTitle(title) {
  const match = title.match(GOI_PATTERN);

  if (!match) {
    return { isGOI: false, abbr: null };
  }

  const abbr = match[1] ? match[1].toUpperCase().trim() : null;
  return { isGOI: true, abbr };
}

module.exports = { parseStreamTitle };
