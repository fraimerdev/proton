import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { readLink, SIGNED_LINK_SECRET_MIN, signLink } from '../src/signed-link.ts';

const SECRET = 'a'.repeat(SIGNED_LINK_SECRET_MIN);

const NOW = 1_700_000_000_000;

const invite = z.object({
  purpose: z.literal('invite'),
  expiresAt: z.number().int().positive(),
  seat: z.string(),
});

const receipt = z.object({
  purpose: z.literal('receipt'),
  expiresAt: z.number().int().positive(),
  amount: z.number(),
});

describe('readLink', () => {
  test('round-trips what its own schema minted', async () => {
    const claims = { purpose: 'invite', expiresAt: NOW + 1000, seat: '4A' } as const;

    expect(
      await readLink(invite, await signLink(invite, claims, SECRET), SECRET, NOW, 'x'),
    ).toEqual({ claims });
  });

  test('refuses a body signed under a different schema, however valid the signature', async () => {
    const token = await signLink(
      receipt,
      { purpose: 'receipt', expiresAt: NOW + 1000, amount: 10 },
      SECRET,
    );

    expect(await readLink(invite, token, SECRET, NOW, 'an invite')).toEqual({
      invalid: 'the body is signed but is not an invite',
    });
  });

  test('names what it wanted, so the page can say which link this is not', async () => {
    const token = await signLink(
      receipt,
      { purpose: 'receipt', expiresAt: NOW + 1, amount: 1 },
      SECRET,
    );

    expect(await readLink(invite, token, SECRET, NOW, 'a boarding pass')).toEqual({
      invalid: 'the body is signed but is not a boarding pass',
    });
  });

  test('refuses anything that is not a body.signature pair', async () => {
    for (const token of ['', '.', 'nodot', '.leading', 'trailing.']) {
      expect(await readLink(invite, token, SECRET, NOW, 'an invite')).toEqual({
        invalid: 'the token is not a body.signature pair',
      });
    }
  });
});
