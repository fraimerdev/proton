import {
  type Causation,
  type EventType,
  type ModuleContext,
  type XpSource,
  xpAwardedSchema,
} from '@proton/core';
import { MODULE_ID } from './perform.ts';

type Publisher = Pick<ModuleContext, 'guildId' | 'logger' | 'publish'>;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function organicCausation(eventId: string): Causation {
  return { kind: 'organic', rootId: eventId, depth: 0 };
}

export function adminCausation(eventId: string): Causation {
  return { kind: 'admin', rootId: eventId, depth: 0 };
}

export async function publishFact(
  ctx: Publisher,
  type: EventType,
  naturalKey: string,
  payload: unknown,
  what: string,
): Promise<void> {
  if (!ctx.publish) {
    ctx.logger.warn(
      `leveling ${what} but could not publish ${type}: this module's context has no publish ` +
        'port, so nothing reacting to it — Achievements, rules — will ever see it. The process ' +
        'running modules must supply ModuleContext.publish.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  try {
    await ctx.publish(type, naturalKey, payload);
  } catch (error) {
    ctx.logger.error(
      `leveling ${what} but could not publish ${type}, so nothing reacting to it will see it: ` +
        reasonOf(error),
      { guildId: ctx.guildId, moduleId: MODULE_ID, naturalKey },
    );
  }
}

export interface XpAward {
  userId: string;
  amount: number;
  source: XpSource;
  channelId?: string | undefined;
  activityAt: number;
  xp: number;
  level: number;
  causation: Causation;
}

export async function publishXpAwarded(
  ctx: Publisher,
  naturalKey: string,
  award: XpAward,
): Promise<void> {
  const what = `credited ${award.amount} ${award.source} XP to ${award.userId}`;
  const { channelId, ...rest } = award;

  const parsed = xpAwardedSchema.safeParse({
    guildId: ctx.guildId,
    ...rest,
    ...(channelId === undefined ? {} : { channelId }),
  });

  if (!parsed.success) {
    ctx.logger.error(
      `leveling ${what} but its xp.awarded event is malformed, so it was not published: ` +
        parsed.error.message,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: award.userId },
    );
    return;
  }

  await publishFact(ctx, 'xp.awarded', naturalKey, parsed.data, what);
}
