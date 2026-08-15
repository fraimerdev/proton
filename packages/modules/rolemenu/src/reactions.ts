import type { ModuleContext, ProtonEvent } from '@proton/core';
import type { RolemenuConfig, RolemenuMenu } from './config.ts';
import { bindReactionDeps, describeUnbound, type RolemenuDeps } from './deps.ts';
import { MODULE_ID, runRoleChanges } from './perform.ts';
import { resolveRoleChanges } from './resolve.ts';

/** What one reaction told us. */
export interface ReactionFacts {
  userId: string;
  channelId: string;
  messageId: string;
  /**
   * The emoji, keyed the way the gateway normaliser keys it: the custom emoji's
   * **id** when it has one, otherwise its name, which for a standard emoji is the
   * character itself. Preferring the id keeps two custom emoji sharing a name
   * distinct — and a config that named them by name could only ever bind one.
   */
  emojiKey: string;
  /**
   * The reactor's roles, or null.
   *
   * MESSAGE_REACTION_ADD carries a full member object; MESSAGE_REACTION_REMOVE
   * carries none at all. That asymmetry is Discord's, and `resolveRoleChanges`
   * is built around it rather than papering over it with a member fetch that
   * would cost a REST call on every un-react in the guild.
   */
  roleIds: string[] | null;
  isBot: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Read a `reaction.added` / `reaction.removed` event.
 *
 * The one place in this module that knows Discord's MESSAGE_REACTION_ADD shape.
 * PLAN.md P1 keeps dispatch shapes inside the gateway normaliser, but a listener
 * is handed the raw payload, so the knowledge is confined to this function rather
 * than spread across the handler — the same containment `verification` uses for
 * joins.
 */
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

/** The first menu on this message that binds this emoji, or null. */
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

/**
 * Grant or revoke a role because somebody reacted.
 *
 * There is nobody to answer here — a reaction is not an interaction, so there is
 * no token to reply on and no ephemeral message to send. A refusal therefore goes
 * to the log, loudly and naming the role, because the member's only other signal
 * is a reaction that appears to have done nothing (§1).
 *
 * Every action carries an idempotency key derived from `event.id` (I4), which
 * matters more here than almost anywhere else: a reaction has no id of its own,
 * so the normaliser derives one from `(channel, message, user, emoji)` and a
 * genuine react → unreact → react is indistinguishable from a redelivery. Role
 * moves are idempotent, which is exactly why that trade was acceptable.
 */
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
    // By far the common case: every reaction in the guild arrives here.
    return { action: 'ignored', reason: 'no reaction menu binds that emoji on that message' };
  }

  const bound = bindReactionDeps(rawDeps);
  if ('unbound' in bound) {
    /**
     * Fail closed, and say why.
     *
     * Without `botUserId` there is no way to tell Proton's own seeding reaction
     * from a member's, so carrying on would have `/rolemenu` grant the bot every
     * role on the menu it had just posted.
     */
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
    // The event says which way this points. An un-react is a member putting the
    // role down, never a toggle back on.
    intent: event.type === 'reaction.added' ? 'grant' : 'revoke',
    currentRoleIds: facts.roleIds,
  });

  if (!changes) {
    // `matchMenu` already required a binding for this emoji, so this is
    // unreachable — kept because the alternative to a branch is a non-null
    // assertion, and an unreachable branch that says so is cheaper to read.
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
