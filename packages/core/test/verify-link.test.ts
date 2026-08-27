import { describe, expect, test } from 'bun:test';
import {
  newVerifyLinkClaims,
  readVerifyLink,
  signVerifyLink,
  VERIFY_LINK_TTL_MS,
  type VerifyLinkClaims,
} from '../src/verify-link.ts';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

const GUILD = '1234567890123456789';
const USER = '9876543210987654321';

const NOW = 1_700_000_000_000;

function claims(overrides: Partial<VerifyLinkClaims> = {}): VerifyLinkClaims {
  return { ...newVerifyLinkClaims(GUILD, USER, NOW), ...overrides };
}

describe('newVerifyLinkClaims', () => {
  test('expires a quarter of an hour out and carries a unique jti', () => {
    const first = newVerifyLinkClaims(GUILD, USER, NOW);
    const second = newVerifyLinkClaims(GUILD, USER, NOW);

    expect(first.expiresAt).toBe(NOW + VERIFY_LINK_TTL_MS);
    expect(first.jti).not.toBe(second.jti);
  });
});

describe('readVerifyLink', () => {
  test('round-trips the guild and user it was minted for', async () => {
    const minted = claims();
    const result = await readVerifyLink(await signVerifyLink(minted, SECRET), SECRET, NOW);

    expect(result).toEqual({ claims: minted });
  });

  test('produces a token that is safe in a URL path segment', async () => {
    const token = await signVerifyLink(claims(), SECRET);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  test('refuses a token signed with another deployment’s secret', async () => {
    const token = await signVerifyLink(claims(), OTHER_SECRET);
    const result = await readVerifyLink(token, SECRET, NOW);

    expect(result).toEqual({ invalid: expect.stringContaining('VERIFY_LINK_SECRET') });
  });

  test('refuses a token whose body was edited to name a different user', async () => {
    const token = await signVerifyLink(claims(), SECRET);
    const forged = await signVerifyLink(claims({ userId: '1111111111111111111' }), SECRET);

    const swapped = `${forged.split('.')[0]}.${token.split('.')[1]}`;
    const result = await readVerifyLink(swapped, SECRET, NOW);

    expect('invalid' in result).toBe(true);
  });

  test('refuses a token whose signature was edited', async () => {
    const token = await signVerifyLink(claims(), SECRET);
    const [body, signature] = token.split('.') as [string, string];

    // The signature's last base64url character is mostly padding; editing it can decode unchanged.
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;

    expect('invalid' in (await readVerifyLink(`${body}.${flipped}`, SECRET, NOW))).toBe(true);
  });

  test('refuses the link the moment it expires, not a tick later', async () => {
    const minted = claims();
    const token = await signVerifyLink(minted, SECRET);

    expect('claims' in (await readVerifyLink(token, SECRET, minted.expiresAt - 1))).toBe(true);
    expect('invalid' in (await readVerifyLink(token, SECRET, minted.expiresAt))).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['no separator', 'notatoken'],
    ['empty body', '.signature'],
    ['empty signature', 'body.'],
    ['not base64url', 'body!!.signature!!'],
  ])('refuses a malformed token (%s)', async (_label, token) => {
    expect('invalid' in (await readVerifyLink(token, SECRET, NOW))).toBe(true);
  });

  test('refuses a correctly signed body that is not a verification link', async () => {
    const body = btoa(JSON.stringify({ hello: 'world' }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    const carrier = await signVerifyLink(claims(), SECRET);
    const signed = `${body}.${carrier.split('.')[1]}`;

    expect('invalid' in (await readVerifyLink(signed, SECRET, NOW))).toBe(true);
  });
});
