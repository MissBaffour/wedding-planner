import { describe, expect, it } from 'vitest';
import { ghanaNetworkHint, normalizePhone, uuidv7 } from '../src/index.ts';

describe('normalizePhone', () => {
  it.each([
    ['0241234567', '+233241234567'],
    ['024 123 4567', '+233241234567'],
    ['024-123-4567', '+233241234567'],
    ['233241234567', '+233241234567'],
    ['+233 24 123 4567', '+233241234567'],
    ['00233241234567', '+233241234567'],
    ['241234567', '+233241234567'],
    ['+447911123456', '+447911123456'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '12345', '02412345678', '+0233241234567', '0241234567x'])('rejects %j', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('ghanaNetworkHint', () => {
  it('maps prefixes', () => {
    expect(ghanaNetworkHint('+233241234567')).toBe('mtn');
    expect(ghanaNetworkHint('+233501234567')).toBe('telecel');
    expect(ghanaNetworkHint('+233571234567')).toBe('airteltigo');
    expect(ghanaNetworkHint('+233301234567')).toBeNull(); // landline
    expect(ghanaNetworkHint('+447911123456')).toBeNull();
  });
});

describe('uuidv7', () => {
  it('is a valid v7 uuid and time ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
