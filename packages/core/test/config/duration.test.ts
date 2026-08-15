import { describe, expect, test } from 'bun:test';
import {
  formatDuration,
  InvalidDurationError,
  parseDuration,
  tryParseDuration,
} from '../../src/config/duration.ts';

describe('parseDuration', () => {
  test('parses each supported unit', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1w')).toBe(604_800_000);
  });

  test('tolerates whitespace and case', () => {
    expect(parseDuration(' 12H ')).toBe(43_200_000);
    expect(parseDuration('30 m')).toBe(1_800_000);
  });

  test('rejects nonsense with a message that says what is valid', () => {
    expect(() => parseDuration('soon')).toThrow(InvalidDurationError);
    expect(() => parseDuration('7')).toThrow(/number followed by/);
    expect(() => parseDuration('-5m')).toThrow(InvalidDurationError);
    expect(() => parseDuration('5y')).toThrow(InvalidDurationError);
  });

  test('tryParseDuration returns null instead of throwing', () => {
    expect(tryParseDuration('5m')).toBe(300_000);
    expect(tryParseDuration('nope')).toBeNull();
  });
});

describe('formatDuration', () => {
  test('formatting then parsing preserves the value', () => {
    for (const input of ['30s', '5m', '2h', '7d', '90s']) {
      const ms = parseDuration(input);
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });

  test('string identity holds where the unit is already largest', () => {
    for (const input of ['30s', '5m', '2h']) {
      expect(formatDuration(parseDuration(input))).toBe(input);
    }
  });

  test('prefers the largest exact unit', () => {
    expect(formatDuration(604_800_000)).toBe('1w');
    expect(formatDuration(3_600_000)).toBe('1h');
  });

  test('falls back to seconds when nothing divides evenly', () => {
    expect(formatDuration(90_000)).toBe('90s');
  });
});
