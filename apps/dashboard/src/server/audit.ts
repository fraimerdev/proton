import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { getDiscordUserId } from '../lib/discord-token.ts';

export const auditStampSchema = z.object({
  actorId: z.string().min(1),
  source: z.literal('dashboard'),
  ipHash: z.string().optional(),
});

export type AuditStamp = z.infer<typeof auditStampSchema>;

async function ipHash(): Promise<string | undefined> {
  const headers = getRequest().headers;
  const raw = headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? headers.get('x-real-ip');
  if (!raw) return undefined;

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
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
