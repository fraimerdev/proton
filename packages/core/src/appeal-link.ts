import { z } from 'zod';
import { snowflakeSchema } from './actions/payloads.ts';
import { readLink, type SignedLinkResult, signLink } from './signed-link.ts';

export const APPEAL_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const APPEAL_LINK_PATH = '/appeal/';

export const APPEAL_PANEL_ID_MAX = 32;

// Additive changes only, and every new field optional: the worker signs these and the dashboard
// reads them, and a rolling deploy runs both builds at once against links already in DMs.
export const appealLinkClaimsSchema = z.object({
  purpose: z.literal('appeal'),

  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  panelId: z.string().min(1).max(APPEAL_PANEL_ID_MAX),
  origin: z.string().min(1).max(32),

  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  jti: z.string().min(1).max(64),
});

export type AppealLinkClaims = z.infer<typeof appealLinkClaimsSchema>;

export type AppealLinkResult = SignedLinkResult<AppealLinkClaims>;

export interface NewAppealLinkInput {
  guildId: string;
  userId: string;
  panelId: string;
  origin: string;
  issuedAt: number;
  jti: string;
  ttlMs?: number;
}

// No Date.now() and no newId(): a RESUME redelivery of the event that minted this must produce a
// byte-identical token, or one ban hands the member two different appeal links.
export function newAppealLinkClaims(input: NewAppealLinkInput): AppealLinkClaims {
  return {
    purpose: 'appeal',
    guildId: input.guildId,
    userId: input.userId,
    panelId: input.panelId,
    origin: input.origin,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + (input.ttlMs ?? APPEAL_LINK_TTL_MS),
    jti: input.jti,
  };
}

export async function signAppealLink(claims: AppealLinkClaims, secret: string): Promise<string> {
  return signLink(appealLinkClaimsSchema, claims, secret);
}

export async function readAppealLink(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<AppealLinkResult> {
  return readLink(appealLinkClaimsSchema, token, secret, now, 'an appeal link');
}

export function appealLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${APPEAL_LINK_PATH}${token}`;
}
