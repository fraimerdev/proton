import type { ModuleContext, ProtonEvent } from '@proton/core';
import type { RolemenuConfig, RolemenuMenu } from './config.ts';
import { bindReactionDeps, describeUnbound, type RolemenuDeps } from './deps.ts';
import { MODULE_ID, runRoleChanges } from './perform.ts';
import { resolveRoleChanges } from './resolve.ts';

export interface ReactionFacts {
  userId: string;
  channelId: string;
  messageId: string;

  emojiKey: string;

  roleIds: string[] | null;
  isBot: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readReaction(event: ProtonEvent): ReactionFacts | null {
  const d = record(event.payload);
  if (!d) return null;

  const userId = str(d.user_id);
  const channelId = str(d.channel_id);
  const messageId = str(d.message_id);
  const emojiKey = str(record(d.emoji)?.id) ?? str(record(d.emoji)?.name);
  if (!userId || !channelId || !messageId || !emojiKey) return null;

  const member = record(d.member);

  return {
    userId,
    channelId,
    messageId,
    emojiKey,
    roleIds: Array.isArray(member?.roles)
      ? member.roles.filter((role): role is string => typeof role === 'string')
      : null,
    isBot: record(member?.user)?.bot === true,
  };
}

export type ReactionOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'applied'; menuId: string; added: string[]; removed: string[] }
  | { action: 'refused'; reason: string };

function matchMenu(config: RolemenuConfig, facts: ReactionFacts): RolemenuMenu | null {
  return (
    config.menus.find(
      (menu) =>
        menu.kind === 'reaction' &&
        menu.channelId === facts.channelId &&
        menu.messageId === facts.messageId &&
        menu.bindings.some((binding) => binding.key === facts.emojiKey),
    ) ?? null
  );
}

export async function handleReaction(
  event: ProtonEvent,
  ctx: ModuleContext<RolemenuConfig>,
  rawDeps: RolemenuDeps,
): Promise<ReactionOutcome> {
  if (!ctx.config.enabled) {
    return { action: 'ignored', reason: 'role menus are off in this server' };
  }

  const facts = readReaction(event);
  if (!facts) {
    ctx.logger.error(
      'rolemenu received a reaction event it could not read, so nobody got their role. This is ' +
        'a gateway/normaliser mismatch, not a configuration problem.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable reaction payload' };
  }

  const menu = matchMenu(ctx.config, facts);
  if (!menu) {
    return { action: 'ignored', reason: 'no reaction menu binds that emoji on that message' };
  }

  const bound = bindReactionDeps(rawDeps);
  if ('unbound' in bound) {
    const reason = describeUnbound(
      `a reaction on menu '${menu.id}' was ignored and nobody got their role`,
      bound.unbound,
    );
    ctx.logger.error(reason, { guildId: ctx.guildId, moduleId: MODULE_ID });
    return { action: 'refused', reason };
  }

  if (facts.userId === bound.deps.botUserId) {
    return { action: 'ignored', reason: 'the reaction is Proton’s own menu seeding' };
  }

  if (facts.isBot) {
    return { action: 'ignored', reason: 'the member is a bot' };
  }

  const changes = resolveRoleChanges({
    menu,
    bindingKey: facts.emojiKey,

    intent: event.type === 'reaction.added' ? 'grant' : 'revoke',
    currentRoleIds: facts.roleIds,
  });

  if (!changes) {
    return { action: 'ignored', reason: 'no binding for that emoji' };
  }

  const report = await runRoleChanges(ctx, {
    userId: facts.userId,
    menuId: menu.id,
    add: changes.add,
    remove: changes.remove,
    idempotencyRoot: event.id,
  });

  if (report.failures.length > 0) {
    const reason = report.failures.join(' | ');
    ctx.logger.error(
      `rolemenu could not apply menu '${menu.id}' for ${facts.userId}: ${reason} Until this is ` +
        'fixed, reacting to that message does nothing and nobody is told why.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: facts.userId, menuId: menu.id },
    );
    return { action: 'refused', reason };
  }

  return {
    action: 'applied',
    menuId: menu.id,
    added: report.added,
    removed: report.removed,
  };
}
