import {
  computeEvenlySpacedMinutes,
  formatMinutesAsClock,
  isValidDateOnly,
  parseClockToMinutes,
  toDateOnly,
} from './autonomy.utils';

describe('autonomy.utils', () => {
  it('computes evenly spaced five-slot schedules across the default window', () => {
    const slots = computeEvenlySpacedMinutes(5, 9 * 60, 21 * 60);
    expect(slots).toEqual([540, 720, 900, 1080, 1260]);
    expect(slots.map(formatMinutesAsClock)).toEqual([
      '09:00',
      '12:00',
      '15:00',
      '18:00',
      '21:00',
    ]);
  });

  it('computes evenly spaced seven-slot schedules across the default window', () => {
    const slots = computeEvenlySpacedMinutes(7, 9 * 60, 21 * 60);
    expect(slots.map(formatMinutesAsClock)).toEqual([
      '09:00',
      '11:00',
      '13:00',
      '15:00',
      '17:00',
      '19:00',
      '21:00',
    ]);
  });

  it('parses valid clock strings and falls back for invalid values', () => {
    expect(parseClockToMinutes('09:30', 0)).toBe(570);
    expect(parseClockToMinutes('99:99', 123)).toBe(123);
    expect(parseClockToMinutes('bad', 456)).toBe(456);
  });

  it('validates strict date-only strings', () => {
    expect(isValidDateOnly('2026-03-10')).toBe(true);
    expect(isValidDateOnly('2026-02-30')).toBe(false);
    expect(isValidDateOnly('2026-3-10')).toBe(false);
  });

  it('throws when converting an invalid date-only string', () => {
    expect(() => toDateOnly('2026-02-30')).toThrow('Invalid date');
  });
});
