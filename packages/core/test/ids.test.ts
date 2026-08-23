import { describe, expect, test } from 'bun:test';
import { CASE_ID_ALPHABET, CASE_ID_LENGTH, newCaseId, newId } from '../src/ids.ts';

describe('newCaseId', () => {
  test('is seven characters of letters and digits, so it can be read out loud', () => {
    for (let i = 0; i < 100; i++) {
      const id = newCaseId();

      expect(id).toHaveLength(CASE_ID_LENGTH);
      expect(id).toMatch(/^[A-Za-z0-9]{7}$/);
    }
  });

  test('draws from the whole alphabet, upper and lower case alike', () => {
    const seen = new Set([...Array.from({ length: 4_000 }, newCaseId).join('')]);

    for (const character of CASE_ID_ALPHABET) {
      expect(seen.has(character)).toBe(true);
    }
  });

  // Not proof of uniformity, but a generator that had lost its randomness — a fixed prefix, a
  // stuck byte — would collide here long before it collided in production.
  test('does not repeat itself across a large draw', () => {
    const ids = Array.from({ length: 50_000 }, newCaseId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test('is not the id everything else uses, which stays a sortable ULID', () => {
    expect(newId()).toHaveLength(26);
  });
});
