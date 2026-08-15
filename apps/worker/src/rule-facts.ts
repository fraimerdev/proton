import {
  auditLogEventPayloadSchema,
  isAuditLogEventType,
  type ProtonEvent,
  type RuleFacts,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';

/**
 * Resolve what a rule is evaluated *about*, from the event that triggered it.
 *
 * `RuleEngine` deliberately never reads `ProtonEvent.payload` — payload shapes
 * are the gateway normaliser's knowledge (PLAN.md P1), and a predicate reaching
 * into `d.author.id` would spread Discord's field names through the whole engine.
 * So the resolution happens once, here, at the worker edge, and every condition
 * in every rule for that event sees the same snapshot. Two predicates can then
 * never disagree about who the member is.
 *
 * Nothing here throws and nothing here guesses. An event whose payload does not
 * carry a fact simply does not produce it, and a condition that needed it fails
 * closed naming the fact it was missing — which is a far better answer than a
 * fabricated one.
 *
 * `accountCreatedAt` is never set: `evaluateFactCondition` derives it from
 * `actorId`'s snowflake, and a second derivation here would be a second place to
 * get the Discord epoch wrong. `entitlement` is likewise absent — nothing in the
 * worker reads `entitlements` yet, and `is-premium` already treats "unknown" as
 * `free`, which is the correct fail-closed answer for a paid gate.
 */

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nested(value: unknown, key: string): unknown {
  return record(value)?.[key];
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

/**
 * MESSAGE_CREATE / MESSAGE_UPDATE.
 *
 * `member` is present on a guild message and absent on a DM, which is fine: a DM
 * has no guild and never reaches a rule at all.
 */
function messageFacts(payload: unknown): RuleFacts {
  const d = record(payload);
  if (!d) return {};

  const facts: RuleFacts = {};
  const authorId = str(nested(d.author, 'id'));
  if (authorId) facts.actorId = authorId;

  const channelId = str(d.channel_id);
  if (channelId) facts.channelId = channelId;

  /**
   * An empty `content` is reported as *no* content, not as empty content.
   *
   * Discord sends `content: ''` for every message when the Message Content
   * privileged intent is not granted, and also for a genuinely empty message
   * (an attachment or a sticker on its own). The dispatch cannot tell the two
   * apart. Treating `''` as absent picks the reading that produces the useful
   * sentence: `content-pattern` then answers "the Message Content privileged
   * intent is not granted to the bot", which is actionable, instead of "the
   * content does not match /x/", which is a dead end for an admin whose rule
   * never fires for any message in the server. The cost is that an
   * attachment-only message gets that same sentence — and no pattern of at
   * least one character could have matched it anyway.
   */
  const content = str(d.content);
  if (content !== undefined) facts.content = content;

  const roleIds = stringArray(nested(d.member, 'roles'));
  if (roleIds) facts.roleIds = roleIds;

  return facts;
}

/**
 * GUILD_MEMBER_ADD / _REMOVE / _UPDATE.
 *
 * A fresh join carries `roles: []`, and that is recorded as an empty list rather
 * than dropped: "holds none of the required roles" and "this member's roles are
 * unknown" are different answers, and only the first one is true here.
 */
function memberFacts(payload: unknown): RuleFacts {
  const d = record(payload);
  if (!d) return {};

  const facts: RuleFacts = {};
  const userId = str(nested(d.user, 'id'));
  if (userId) facts.actorId = userId;

  const roleIds = stringArray(d.roles);
  if (roleIds) facts.roleIds = roleIds;

  return facts;
}

/**
 * The audit-derived events.
 *
 * Their payload is not a raw dispatch — the normaliser already lifted the four
 * fields that matter through `auditLogEventPayloadSchema` — so this parses with
 * that same schema rather than reaching into the entry a second time.
 *
 * `actorId` is nullable because Discord omits `user_id` for entries with nobody
 * behind them. Those produce no actor, so a rule that needs one is skipped with
 * a named reason instead of being attributed to whoever is convenient.
 */
function auditFacts(payload: unknown): RuleFacts {
  const parsed = auditLogEventPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.actorId === null) return {};
  return { actorId: parsed.data.actorId };
}

/**
 * The contract for Proton's own events — `moderation.warned`, `xp.level_gained`.
 *
 * Both are published by a module through the `emits` allowlist rather than by
 * Discord, and **neither has a publisher yet**: `cases` records the missing warn
 * emission as a blocker and `leveling` is not written. So this schema is not a
 * reader of an existing shape, it is the shape — the module that eventually
 * publishes one has to match it, or its event resolves to no facts and every
 * rule triggered on it is skipped for want of an actor.
 *
 * `userId` is the member the event is **about**: for a warn that is the warned
 * member and never the moderator who typed the command. Counting the moderator
 * would point the escalation ladder at staff, which is the one way to get this
 * exactly backwards (see `cases/escalation.ts`).
 *
 * It lives here rather than in `packages/core` because payload knowledge belongs
 * at the edge that resolves it, and because there is no second consumer to share
 * it with yet. When the emitting module lands it should move next to
 * `auditLogEventPayloadSchema`, so publisher and resolver validate against one
 * definition the way the normaliser and the audit path already do.
 */
export const internalMemberEventSchema = z.object({
  userId: snowflakeSchema,
  /** Where to answer, when the event has a natural channel (a level-up message). */
  channelId: snowflakeSchema.optional(),
});

function internalMemberFacts(payload: unknown): RuleFacts {
  const parsed = internalMemberEventSchema.safeParse(payload);
  if (!parsed.success) return {};

  return {
    actorId: parsed.data.userId,
    ...(parsed.data.channelId ? { channelId: parsed.data.channelId } : {}),
  };
}

/**
 * Facts for one event.
 *
 * An unhandled type returns `{}` rather than throwing. That is deliberate and it
 * is safe in exactly one direction: with no facts, `payloadDefaults` supplies no
 * target and every condition that needs one refuses by name, so a rule on an
 * unresolved type does nothing loudly rather than acting on a guess. Adding an
 * arm is how a type becomes usable by rules — there is no silent middle state.
 */
export function factsFor(event: ProtonEvent): RuleFacts {
  if (isAuditLogEventType(event.type)) return auditFacts(event.payload);

  switch (event.type) {
    case 'message.created':
    case 'message.updated':
      return messageFacts(event.payload);

    case 'member.joined':
    case 'member.left':
    case 'member.updated':
      return memberFacts(event.payload);

    case 'moderation.warned':
    case 'xp.level_gained':
      return internalMemberFacts(event.payload);

    default:
      return {};
  }
}
