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
