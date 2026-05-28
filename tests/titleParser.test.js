const { parseStreamTitle } = require('../src/utils/titleParser');

describe('parseStreamTitle', () => {
  test('returns isGOI: true and abbr for "GOI ALPHA Week 3"', () => {
    expect(parseStreamTitle('GOI ALPHA Week 3')).toEqual({ isGOI: true, abbr: 'ALPHA' });
  });

  test('returns isGOI: true and abbr for "GOI ALPHA Championship Week 3"', () => {
    expect(parseStreamTitle('GOI ALPHA Championship Week 3')).toEqual({ isGOI: true, abbr: 'ALPHA' });
  });

  test('returns isGOI: true and null abbr for bare "GOI"', () => {
    expect(parseStreamTitle('GOI')).toEqual({ isGOI: true, abbr: null });
  });

  test('returns isGOI: false for non-GOI title', () => {
    expect(parseStreamTitle('just a regular stream')).toEqual({ isGOI: false, abbr: null });
  });

  test('returns isGOI: false for "College Football Week 7"', () => {
    expect(parseStreamTitle('College Football Week 7')).toEqual({ isGOI: false, abbr: null });
  });

  test('is case-insensitive — "goi alpha" works like "GOI ALPHA"', () => {
    expect(parseStreamTitle('goi alpha')).toEqual({ isGOI: true, abbr: 'ALPHA' });
  });

  test('handles "GOI - Beta League Finals" style dashes', () => {
    const result = parseStreamTitle('GOI - Beta League Finals');
    expect(result.isGOI).toBe(true);
    // dash separates GOI from next word, abbr should be null since "-" breaks the capture
    expect(result.abbr).toBeNull();
  });

  test('handles alphanumeric abbreviations like "GOI xyz123"', () => {
    expect(parseStreamTitle('GOI xyz123')).toEqual({ isGOI: true, abbr: 'XYZ123' });
  });

  test('does not match "EGOIST" as a GOI stream', () => {
    expect(parseStreamTitle('EGOIST gaming marathon')).toEqual({ isGOI: false, abbr: null });
  });

  test('matches GOI mid-title', () => {
    expect(parseStreamTitle('Playing ranked | GOI BETA | !discord')).toEqual({ isGOI: true, abbr: 'BETA' });
  });
});
