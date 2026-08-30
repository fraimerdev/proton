import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  APPEAL_LINK_TTL_MS,
  type AppealLinkClaims,
  appealLinkUrl,
  newAppealLinkClaims,
  readAppealLink,
  signAppealLink,
} from '../src/appeal-link.ts';
import { BUTTON_URL_MAX } from '../src/messages/components.ts';
import { signLink } from '../src/signed-link.ts';
import {
  newVerifyLinkClaims,
  readVerifyLink,
  signVerifyLink,
  verifyLinkClaimsSchema,
} from '../src/verify-link.ts';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

const GUILD = '1234567890123456789';
const USER = '9876543210987654321';

const NOW = 1_700_000_000_000;

function claims(overrides: Partial<AppealLinkClaims> = {}): AppealLinkClaims {
  return {
    ...newAppealLinkClaims({
      guildId: GUILD,
      userId: USER,
      panelId: 'panel-1',
      origin: 'honeypot',
      issuedAt: NOW,
      jti: 'honeypot:1:2',
    }),
    ...overrides,
  };
}

// The two signed-link kinds share VERIFY_LINK_SECRET, so this is the test that stops an appeal
// token being spent as a verification pass. It runs first on purpose.
describe('the two link kinds cannot be spent on each other', () => {
  test('an appeal token is refused by the verification reader', async () => {
    const token = await signAppealLink(claims(), SECRET);

    expect(await readVerifyLink(token, SECRET, NOW)).toEqual({
      invalid: 'the body is signed but is not a verification link',
    });
  });

  test('a verification token is refused by the appeal reader', async () => {
    const token = await signVerifyLink(newVerifyLinkClaims(GUILD, USER, NOW), SECRET);

    expect(await readAppealLink(token, SECRET, NOW)).toEqual({
      invalid: 'the body is signed but is not an appeal link',
    });
  });

  test('a correctly signed appeal body with the purpose swapped is refused as an appeal', async () => {
    const forged = await signLink(
      verifyLinkClaimsSchema,
      newVerifyLinkClaims(GUILD, USER, NOW),
      SECRET,
    );

    expect(await readAppealLink(forged, SECRET, NOW)).toEqual({
      invalid: 'the body is signed but is not an appeal link',
    });
  });
});

describe('newAppealLinkClaims', () => {
  test('expires thirty days out', () => {
    expect(claims().expiresAt).toBe(NOW + APPEAL_LINK_TTL_MS);
  });

  // A RESUME redelivery mints this again from the same event. If a later reader "tidies" issuedAt
  // back to Date.now() or jti to newId(), one ban hands the member two different appeal links.
  test('is a pure function of its input, so a redelivered event mints the same token', async () => {
    const input = {
      guildId: GUILD,
      userId: USER,
      panelId: 'panel-1',
      origin: 'honeypot',
      issuedAt: NOW,
      jti: 'honeypot:1:2',
    };

    expect(newAppealLinkClaims(input)).toEqual(newAppealLinkClaims(input));

    expect(await signAppealLink(newAppealLinkClaims(input), SECRET)).toBe(
      await signAppealLink(newAppealLinkClaims(input), SECRET),
    );
  });
});

describe('readAppealLink', () => {
  test('round-trips everything the appeal page needs', async () => {
    const minted = claims();

    expect(await readAppealLink(await signAppealLink(minted, SECRET), SECRET, NOW)).toEqual({
      claims: minted,
    });
  });

  test('refuses a token signed with another deployment’s secret', async () => {
    const token = await signAppealLink(claims(), OTHER_SECRET);

    expect(await readAppealLink(token, SECRET, NOW)).toEqual({
      invalid: 'the signature does not match this deployment’s VERIFY_LINK_SECRET',
    });
  });

  test('refuses a token whose body was edited to name a different user', async () => {
    const token = await signAppealLink(claims(), SECRET);
    const [body = '', signature = ''] = token.split('.');

    const edited = btoa(JSON.stringify({ ...claims(), userId: '1111111111111111111' })).replaceAll(
      '=',
      '',
    );

    expect(await readAppealLink(`${edited}.${signature}`, SECRET, NOW)).toEqual({
      invalid: 'the signature does not match this deployment’s VERIFY_LINK_SECRET',
    });
    expect(body.length).toBeGreaterThan(0);
  });

  test('refuses a token whose signature was edited', async () => {
    const token = await signAppealLink(claims(), SECRET);
    const [body = '', signature = ''] = token.split('.');

    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expect(await readAppealLink(`${body}.${flipped}`, SECRET, NOW)).toEqual({
      invalid: 'the signature does not match this deployment’s VERIFY_LINK_SECRET',
    });
  });

  test('refuses the link the moment it expires, not a tick later', async () => {
    const minted = claims();
    const token = await signAppealLink(minted, SECRET);

    expect(await readAppealLink(token, SECRET, minted.expiresAt - 1)).toEqual({ claims: minted });
    expect(await readAppealLink(token, SECRET, minted.expiresAt)).toEqual({
      invalid: `the link expired at ${new Date(minted.expiresAt).toISOString()}`,
    });
  });
});

describe('appealLinkUrl', () => {
  test('joins the base url without doubling the slash', () => {
    expect(appealLinkUrl('https://prtn.xyz/', 'token')).toBe('https://prtn.xyz/appeal/token');
    expect(appealLinkUrl('https://prtn.xyz', 'token')).toBe('https://prtn.xyz/appeal/token');
  });

  // The link goes on a Discord link button, which refuses a url over 512 characters — so the
  // longest claims body Proton can mint still has to fit.
  test('fits a link button for the longest claims a mint can produce', () => {
    const snowflake = fc.stringMatching(/^[0-9]{17,20}$/);

    return fc.assert(
      fc.asyncProperty(
        snowflake,
        snowflake,
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        async (guildId, userId, panelId, origin, jti) => {
          const token = await signAppealLink(
            newAppealLinkClaims({ guildId, userId, panelId, origin, issuedAt: NOW, jti }),
            SECRET,
          );

          expect(appealLinkUrl('https://prtn.xyz', token).length).toBeLessThanOrEqual(
            BUTTON_URL_MAX,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
