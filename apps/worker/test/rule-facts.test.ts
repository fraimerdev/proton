import { describe, expect, test } from 'bun:test';
import { evaluateFactCondition, type ProtonEvent } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { factsFor } from '../src/rule-facts.ts';

/**
 * The fact resolver, tested against what the *normaliser* actually emits rather
 * than against payloads written here.
 *
 * That is the whole point of the file. `RuleEngine` never reads
 * `ProtonEvent.payload`, so nothing else in the system crosses this boundary, and
 * a resolver whose tests supply their own payload shapes would pass while reading
 * fields Discord does not send — which is precisely how `logging` stayed dead for
 * a phase (see `event-shapes.test.ts`).
 */

const GUILD = '900000000000000001';

/** The normalised event for a recorded dispatch, narrowed. */
function fromDispatch(name: Parameters<typeof dispatch>[0]): ProtonEvent {
  const event = normalise(dispatch(name));
  if (!event) throw new Error(`the normaliser produced nothing for ${name}`);
  return event;
}

/** An internal event, which by definition has no recorded dispatch. */
function internal(type: ProtonEvent['type'], payload: unknown): ProtonEvent {
  return { id: `${type}:1`, type, guildId: GUILD, occurredAt: 1_770_000_000_000, payload };
}

describe('message events', () => {
  test('a recorded MESSAGE_CREATE resolves the author, the channel and the content', () => {
    expect(factsFor(fromDispatch('messageCreate'))).toEqual({
      actorId: '100000000000000001',
      channelId: '500000000000000001',
      content: 'hello world',
    });
  });

  test('an edit resolves the same way, from the edited content', () => {
    const facts = factsFor(fromDispatch('messageUpdate'));

    expect(facts.actorId).toBe('100000000000000001');
    expect(facts.channelId).toBe('500000000000000001');
    expect(facts.content).toContain('discord-nitro-gift');
  });

  test("the member's roles come through when the dispatch carries them", () => {
    const event = fromDispatch('messageCreate');
    (event.payload as Record<string, unknown>).member = { roles: ['700000000000000001'] };

    expect(factsFor(event).roleIds).toEqual(['700000000000000001']);
  });

  /**
   * Discord sends `content: ''` for every message when the Message Content
   * intent is not granted. Resolving that as *no* content is what lets
   * `content-pattern` answer with the intent instead of "does not match", which
   * is the difference between an admin fixing it and an admin giving up.
   */
  test('empty content is resolved as absent, so the condition names the intent', () => {
    const event = fromDispatch('messageCreate');
    (event.payload as Record<string, unknown>).content = '';

    expect(factsFor(event).content).toBeUndefined();

    const result = evaluateFactCondition(
      { kind: 'content-pattern', pattern: 'scam' },
      factsFor(event),
      Date.now(),
    );
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.humanReason).toContain('Message Content');
  });

  test('a webhook message with no author resolves no actor rather than a guess', () => {
    const event = fromDispatch('messageCreate');
    delete (event.payload as Record<string, unknown>).author;

    expect(factsFor(event).actorId).toBeUndefined();
    expect(factsFor(event).channelId).toBe('500000000000000001');
  });
});

describe('member events', () => {
  /**
   * A fresh join carries `roles: []`. Recording that as an empty list rather than
   * dropping it is what makes `role-has` answer "does not hold any of them" — the
   * true statement — instead of "this member's roles are unknown".
   */
  test('a recorded GUILD_MEMBER_ADD resolves the joiner and an empty role list', () => {
    expect(factsFor(fromDispatch('guildMemberAdd'))).toEqual({
      actorId: '100000000000000002',
      roleIds: [],
    });
  });

  test('a recorded GUILD_MEMBER_UPDATE resolves the member and their current roles', () => {
    const facts = factsFor(fromDispatch('guildMemberUpdate'));

    expect(facts.actorId).toBeDefined();
    expect(Array.isArray(facts.roleIds)).toBe(true);
  });

  /**
   * `accountCreatedAt` is deliberately never set: `account-age` derives it from
   * the actor's snowflake, and a second derivation here would be a second place
   * to get the Discord epoch wrong.
   */
  test('the account age is left for the condition to derive from the snowflake', () => {
    const facts = factsFor(fromDispatch('guildMemberAdd'));
    expect(facts.accountCreatedAt).toBeUndefined();

    const result = evaluateFactCondition(
      { kind: 'account-age', operator: 'older-than', duration: '1s' },
      facts,
      Date.now(),
    );
    // Resolvable purely from `actorId`, which is the property being asserted.
    expect(result.passed).toBe(true);
  });
});

describe('audit-derived events', () => {
  test('the actor is the person the audit entry names, not the target', () => {
    expect(factsFor(fromDispatch('auditLogChannelDelete'))).toEqual({
      actorId: '200000000000000009',
    });
  });

  /**
   * Discord omits `user_id` for entries with nobody behind them. No actor is the
   * honest answer; a rule that needs one is then skipped with a named reason
   * rather than acting on whoever was convenient.
   */
  test('an entry with no actor resolves no facts at all', () => {
    const raw = dispatch('auditLogChannelDelete');
    raw.d.user_id = null;
    const event = normalise(raw);

    expect(factsFor(event as ProtonEvent)).toEqual({});
  });
});

describe('internal events', () => {
  /**
   * The warned member, never the moderator. Counting the moderator would point
   * the escalation ladder at staff — the one way to get this exactly backwards.
   */
  test('moderation.warned resolves the warned member as the actor', () => {
    const facts = factsFor(
      internal('moderation.warned', { userId: '100000000000000003', caseId: 'case_1' }),
    );

    expect(facts.actorId).toBe('100000000000000003');
  });

  test('xp.level_gained carries the channel to answer in when it has one', () => {
    expect(
      factsFor(
        internal('xp.level_gained', {
          userId: '100000000000000004',
          channelId: '500000000000000009',
          level: 5,
        }),
      ),
    ).toEqual({ actorId: '100000000000000004', channelId: '500000000000000009' });
  });

  test('a payload that does not match the contract resolves nothing, and does not throw', () => {
    expect(factsFor(internal('moderation.warned', { user: 'not-a-snowflake' }))).toEqual({});
    expect(factsFor(internal('xp.level_gained', null))).toEqual({});
  });
});

describe('everything else', () => {
  /**
   * An unhandled type is not an error — it is a type no rule can meaningfully act
   * on yet. With no facts, every condition needing one refuses by name, so the
   * rule does nothing loudly rather than acting on a guess.
   */
  test('an event with no arm resolves no facts', () => {
    expect(factsFor(fromDispatch('voiceStateJoin'))).toEqual({});
    expect(factsFor(fromDispatch('messageReactionAdd'))).toEqual({});
    expect(factsFor(fromDispatch('guildCreate'))).toEqual({});
  });

  test('a payload that is not an object at all is survivable', () => {
    expect(factsFor(internal('message.created', 'nonsense'))).toEqual({});
    expect(factsFor(internal('member.joined', undefined))).toEqual({});
  });
});
