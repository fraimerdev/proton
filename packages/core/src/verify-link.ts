import { z } from 'zod';
import { snowflakeSchema } from './actions/payloads.ts';
import { newId } from './ids.ts';
import {
  readLink,
  SIGNED_LINK_SECRET_MIN,
  type SignedLinkResult,
  signLink,
} from './signed-link.ts';

export const VERIFY_LINK_TTL_MS = 15 * 60 * 1000;

export const VERIFY_LINK_SECRET_MIN = SIGNED_LINK_SECRET_MIN;

export const verifyLinkClaimsSchema = z.object({
  // Every signed link in Proton is HMACed with the same secret, so without a discriminator an
  // appeal token would parse here — unknown keys are stripped — and redeem as a verification pass.
  purpose: z.literal('verify'),

  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  expiresAt: z.number().int().positive(),
  jti: z.string().min(1).max(64),
});

export type VerifyLinkClaims = z.infer<typeof verifyLinkClaimsSchema>;

export type VerifyLinkResult = SignedLinkResult<VerifyLinkClaims>;

export function newVerifyLinkClaims(
  guildId: string,
  userId: string,
  now: number = Date.now(),
  ttlMs: number = VERIFY_LINK_TTL_MS,
): VerifyLinkClaims {
  return { purpose: 'verify', guildId, userId, expiresAt: now + ttlMs, jti: newId() };
}

export async function signVerifyLink(claims: VerifyLinkClaims, secret: string): Promise<string> {
  return signLink(verifyLinkClaimsSchema, claims, secret);
}

export async function readVerifyLink(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<VerifyLinkResult> {
  return readLink(verifyLinkClaimsSchema, token, secret, now, 'a verification link');
}
