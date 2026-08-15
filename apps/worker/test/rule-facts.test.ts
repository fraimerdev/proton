import { describe, expect, test } from 'bun:test';
import { evaluateFactCondition, type ProtonEvent } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { factsFor } from '../src/rule-facts.ts';

const GUILD = '900000000000000001';

function fromDispatch(name: Parameters<typeof dispatch>[0]): ProtonEvent {
  const event = normalise(dispatch(name));
  if (!event) throw new Error(`the normaliser produced nothing for ${name}`);
  return event;
}

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

  test('the account age is left for the condition to derive from the snowflake', () => {
    const facts = factsFor(fromDispatch('guildMemberAdd'));
    expect(facts.accountCreatedAt).toBeUndefined();

    const result = evaluateFactCondition(
      { kind: 'account-age', operator: 'older-than', duration: '1s' },
      facts,
      Date.now(),
    );

    expect(result.passed).toBe(true);
  });
});

describe('audit-derived events', () => {
  test('the actor is the person the audit entry names, not the target', () => {
    expect(factsFor(fromDispatch('auditLogChannelDelete'))).toEqual({
      actorId: '200000000000000009',
    });
  });

  test('an entry with no actor resolves no facts at all', () => {
    const raw = dispatch('auditLogChannelDelete');
    raw.d.user_id = null;
    const event = normalise(raw);

    expect(factsFor(event as ProtonEvent)).toEqual({});
  });
});

describe('internal events', () => {
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
