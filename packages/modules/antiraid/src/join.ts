import { type ProtonEvent, snowflakeCreatedAt } from '@proton/core';

export interface JoinFacts {
  userId: string;

  isBot: boolean;

  avatarless: boolean | null;

  accountCreatedAt: number | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function readJoin(event: ProtonEvent): JoinFacts | null {
  const d = record(event.payload);
  const user = record(d?.user);
  if (!d || !user) return null;

  const userId = str(user.id);
  if (!userId) return null;

  const avatarless = 'avatar' in user ? str(user.avatar) === null && str(d.avatar) === null : null;

  return {
    userId,
    isBot: user.bot === true,
    avatarless,
    accountCreatedAt: snowflakeCreatedAt(userId),
  };
}
