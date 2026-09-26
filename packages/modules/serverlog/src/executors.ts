import { protonActionExecutedSchema } from '@proton/core';
import { isSnowflake } from './embed.ts';
import { record } from './render/types.ts';

export type ExecutorOf = (entity: unknown, botUserId: string | null) => string | null;

function personOrProton(id: unknown, botUserId: string | null): string | null {
  if (typeof id !== 'string' || id === '') return null;

  return isSnowflake(id) ? id : botUserId;
}

export function executorFrom(field: string): ExecutorOf {
  return (entity, botUserId) => personOrProton(record(entity)?.[field], botUserId);
}

export const protonExecutes: ExecutorOf = (_entity, botUserId) => botUserId;

export const actionExecutorId: ExecutorOf = (entity, botUserId) => {
  const parsed = protonActionExecutedSchema.safeParse(entity);
  if (!parsed.success) return null;

  return parsed.data.reversal ? botUserId : personOrProton(parsed.data.actorId, botUserId);
};
