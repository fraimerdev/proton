import { describe, expect, test } from 'bun:test';
import { signInFailure } from '../src/routes/index.tsx';

describe('a Discord sign-in that does not complete says why', () => {
  test('declining the consent screen is named, not left as a code', () => {
    expect(signInFailure('access_denied')).toBe(
      'Discord did not grant Proton access, so nothing was shared.',
    );
  });

  test('every mapped code reads as a sentence rather than an identifier', () => {
    for (const code of [
      'access_denied',
      'no_code',
      'invalid_code',
      'unable_to_get_user_info',
      'no_callback_url',
    ]) {
      const line = signInFailure(code);

      expect(line).not.toContain('_');
      expect(line.endsWith('.')).toBe(true);
    }
  });

  test("a code Proton has no sentence for falls back to Discord's own description", () => {
    expect(signInFailure('some_new_code', 'The token expired.')).toBe('The token expired.');
  });

  test('with neither, the raw code is quoted rather than dropped', () => {
    expect(signInFailure('some_new_code')).toContain('some_new_code');
  });
});
