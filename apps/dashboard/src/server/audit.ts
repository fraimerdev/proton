import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { getDiscordUserId } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';

export const auditStampSchema = z.object({
  actorId: z.string().min(1),
  source: z.literal('dashboard'),
  ipHash: z.string().optional(),
});

export type AuditStamp = z.infer<typeof auditStampSchema>;

const env = loadEnv();
const encoder = new TextEncoder();

let hmacKey: Promise<CryptoKey> | undefined;

function ipKey(): Promise<CryptoKey> {
  hmacKey ??= crypto.subtle.importKey(
    'raw',
    encoder.encode(`audit-ip:${env.BETTER_AUTH_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hmacKey;
}

async function ipHash(): Promise<string | undefined> {
  const headers = getRequest().headers;
  const raw = headers.get('x-real-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!raw) return undefined;

  const digest = await crypto.subtle.sign('HMAC', await ipKey(), encoder.encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export async function withAudit<T>(
  sessionUserId: string,
  mutate: (stamp: AuditStamp) => Promise<T>,
): Promise<T> {
  const [hash, actorId] = await Promise.all([ipHash(), getDiscordUserId(sessionUserId)]);

  return mutate(auditStampSchema.parse({ actorId, source: 'dashboard', ipHash: hash }));
}
