import {
  type EventListener,
  type EventType,
  errorStatus,
  type InteractionBase,
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  readModalInteraction,
} from '@proton/core';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { PUNISH_ACTIONS, type PunishAction } from '../punish/interactions.ts';
import { MODERATION_OFF } from '../punish/pending.ts';
import {
  REPORT_INTERACTION_ACTIONS,
  type ReportInteractionHandler,
} from '../reports/interactions.ts';
import { replyTo, respondTo, send, statusMessage } from './respond.ts';

export const MODERATION_INTERACTION_TYPES: EventType[] = [
  'interaction.component',
  'interaction.modal',
];

export const UNKNOWN_CONTROL =
  "I don't recognise that button or form any more, so nothing was done. Start again from the " +
  'command, the message or the report.';

export function moderationInteractionHandler(action: string): ReportInteractionHandler | null {
  if (Object.hasOwn(REPORT_INTERACTION_ACTIONS, action)) {
    return REPORT_INTERACTION_ACTIONS[action] ?? null;
  }
  if (Object.hasOwn(PUNISH_ACTIONS, action)) return PUNISH_ACTIONS[action as PunishAction];
  return null;
}

async function refuse(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  facts: InteractionBase,
  text: string,
): Promise<void> {
  const to = respondTo(
    ctx.guildId,
    facts.userId,
    interactionRef(facts),
    `${MODULE_ID}:${event.id}`,
  );
  await send(ctx, replyTo(to, statusMessage(errorStatus(text))));
}

export async function routeModerationInteraction(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
): Promise<void> {
  const facts =
    event.type === 'interaction.modal'
      ? readModalInteraction(event)
      : event.type === 'interaction.component'
        ? readComponentInteraction(event)
        : null;
  if (!facts) return;

  const parsed = parseCustomId(facts.customId);
  if (parsed?.moduleId !== MODULE_ID) return;

  if (!ctx.config.enabled) return refuse(event, ctx, facts, MODERATION_OFF);

  const handler = moderationInteractionHandler(parsed.action);
  if (!handler) {
    ctx.logger.warn(`moderation has no handler for the control '${parsed.action}'`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      eventType: event.type,
    });
    return refuse(event, ctx, facts, UNKNOWN_CONTROL);
  }

  await handler(event, ctx, deps);
}

export function createModerationInteractionListener(
  deps: ModerationDeps,
): EventListener<ModerationConfig> {
  return {
    types: MODERATION_INTERACTION_TYPES,
    handler: (event, ctx) => routeModerationInteraction(event, ctx, deps),
  };
}
