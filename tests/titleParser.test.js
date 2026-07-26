const { parseStreamTitle } = require('../src/utils/titleParser');

describe('parseStreamTitle — default keyword (GOI)', () => {
  test('matches GOI with abbreviation', () => {
    expect(parseStreamTitle('GOI ALPHA Week 3')).toEqual({ isMatch: true, abbr: 'ALPHA' });
  });

  test('matches GOI with abbreviation mid-sentence', () => {
    expect(parseStreamTitle('GOI ALPHA Championship Week 3')).toEqual({ isMatch: true, abbr: 'ALPHA' });
  });

  test('matches bare GOI with no abbr', () => {
    expect(parseStreamTitle('GOI')).toEqual({ isMatch: true, abbr: null });
  });

  test('returns false for non-GOI title', () => {
    expect(parseStreamTitle('just a regular stream')).toEqual({ isMatch: false, abbr: null });
  });

  test('returns false for College Football', () => {
    expect(parseStreamTitle('College Football Week 7')).toEqual({ isMatch: false, abbr: null });
  });

  test('is case-insensitive', () => {
    expect(parseStreamTitle('goi alpha')).toEqual({ isMatch: true, abbr: 'ALPHA' });
  });

  test('handles dash-separated title — abbr is null', () => {
    const result = parseStreamTitle('GOI - Beta League Finals');
    expect(result.isMatch).toBe(true);
    expect(result.abbr).toBeNull();
  });

  test('handles alphanumeric abbreviations', () => {
    expect(parseStreamTitle('GOI xyz123')).toEqual({ isMatch: true, abbr: 'XYZ123' });
  });

  test('does not match EGOIST as a GOI stream', () => {
    expect(parseStreamTitle('EGOIST gaming marathon')).toEqual({ isMatch: false, abbr: null });
  });

  test('matches GOI mid-title', () => {
    expect(parseStreamTitle('Playing ranked | GOI BETA | !discord')).toEqual({ isMatch: true, abbr: 'BETA' });
  });

  test('matches underscore-delimited title (team_GOI_league)', () => {
    expect(parseStreamTitle('TxState_GOI_TCM')).toEqual({ isMatch: true, abbr: 'TCM' });
  });

  test('matches GOI_abbr with no leading team', () => {
    expect(parseStreamTitle('GOI_TCM')).toEqual({ isMatch: true, abbr: 'TCM' });
  });

  test('underscore format is case-insensitive', () => {
    expect(parseStreamTitle('txstate_goi_tcm')).toEqual({ isMatch: true, abbr: 'TCM' });
  });
});

describe('parseStreamTitle — custom keyword', () => {
  test('matches a custom keyword', () => {
    expect(parseStreamTitle('LEAGUE OPEN Week 1', 'LEAGUE')).toEqual({ isMatch: true, abbr: 'OPEN' });
  });

  test('does not match GOI when keyword is LEAGUE', () => {
    expect(parseStreamTitle('GOI OPEN Week 1', 'LEAGUE')).toEqual({ isMatch: false, abbr: null });
  });

  test('custom keyword is case-insensitive', () => {
    expect(parseStreamTitle('league open week 1', 'LEAGUE')).toEqual({ isMatch: true, abbr: 'OPEN' });
  });

  test('custom keyword with no abbr', () => {
    expect(parseStreamTitle('LEAGUE', 'LEAGUE')).toEqual({ isMatch: true, abbr: null });
  });
});

describe('parseStreamTitle — known league abbreviations (tight / glued forms)', () => {
  const known = ['OPEN', 'REBUILD', 'TCM'];

  test('glued keyword+abbr resolves against known list', () => {
    expect(parseStreamTitle('GOIOPEN', 'GOI', known)).toEqual({ isMatch: true, abbr: 'OPEN' });
  });

  test('glued keyword+abbr with trailing text', () => {
    expect(parseStreamTitle('GOIOPEN Week 3', 'GOI', known)).toEqual({ isMatch: true, abbr: 'OPEN' });
  });

  test('dash separator resolves the abbr', () => {
    expect(parseStreamTitle('GOI-OPEN', 'GOI', known)).toEqual({ isMatch: true, abbr: 'OPEN' });
  });

  test('colon separator resolves the abbr', () => {
    expect(parseStreamTitle('GOI:OPEN', 'GOI', known)).toEqual({ isMatch: true, abbr: 'OPEN' });
  });

  test('spaced dash before a known abbr resolves', () => {
    expect(parseStreamTitle('GOI - REBUILD tonight', 'GOI', known)).toEqual({ isMatch: true, abbr: 'REBUILD' });
  });

  test('longest known abbr wins (REBUILD glued)', () => {
    expect(parseStreamTitle('GOIREBUILD', 'GOI', known)).toEqual({ isMatch: true, abbr: 'REBUILD' });
  });

  test('case-insensitive glued form', () => {
    expect(parseStreamTitle('goitcm', 'GOI', known)).toEqual({ isMatch: true, abbr: 'TCM' });
  });

  test('does NOT false-match a word that starts with the keyword (GOING)', () => {
    expect(parseStreamTitle('GOING live tonight', 'GOI', known)).toEqual({ isMatch: false, abbr: null });
  });

  test('does NOT treat trailing prose as a glued abbr', () => {
    // "Beta" is not a known league, so the spaced-dash prose stays abbr-less.
    const r = parseStreamTitle('GOI - Beta League Finals', 'GOI', known);
    expect(r.isMatch).toBe(true);
    expect(r.abbr).toBeNull();
  });

  test('glued form does not partial-match inside a longer word (GOIOPENING)', () => {
    expect(parseStreamTitle('GOIOPENING soon', 'GOI', known)).toEqual({ isMatch: false, abbr: null });
  });

  test('spaced known abbr still resolves (regression)', () => {
    expect(parseStreamTitle('GOI OPEN', 'GOI', known)).toEqual({ isMatch: true, abbr: 'OPEN' });
  });

  test('unknown abbr falls back to free-form token capture', () => {
    expect(parseStreamTitle('GOI ALPHA', 'GOI', known)).toEqual({ isMatch: true, abbr: 'ALPHA' });
  });
});
