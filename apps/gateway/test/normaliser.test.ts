import { describe, expect, test } from 'bun:test';
import {
  type AuditEntry,
  type AuditLogEventPayload,
  type ProtonEvent,
  snowflakeCreatedAt,
} from '@proton/core';
import { dispatch, dispatchSequence } from '@proton/fixtures';
import {
  AUDIT_LOG_ACTIONS,
  CHANNEL_OBFUSCATED,
  isObfuscatedChannel,
  NORMALISED_EVENT_TYPES,
  normalise,
  type RawDispatch,
} from '../src/normaliser.ts';

describe('normalise', () => {
  test('maps INTERACTION_CREATE (application command) to interaction.command', () => {
    const event = normalise(dispatch('interactionCreatePing'))[0];

    expect(event?.type).toBe('interaction.command');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps GUILD_CREATE to guild.available', () => {
    const event = normalise(dispatch('guildCreate'))[0];

    expect(event?.type).toBe('guild.available');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps GUILD_MEMBER_ADD to member.joined with the payload timestamp', () => {
    const event = normalise(dispatch('guildMemberAdd'))[0];

    expect(event?.type).toBe('member.joined');
    expect(event?.occurredAt).toBe(Date.parse('2026-08-14T09:00:00.000000+00:00'));
  });

  test('maps MESSAGE_CREATE to message.created', () => {
    const event = normalise(dispatch('messageCreate'))[0];

    expect(event?.type).toBe('message.created');
  });

  test('maps MESSAGE_UPDATE to message.updated, timed by the edit', () => {
    const event = normalise(dispatch('messageUpdate'))[0];

    expect(event?.type).toBe('message.updated');
    expect(event?.guildId).toBe('900000000000000001');
    expect(event?.occurredAt).toBe(Date.parse('2026-08-14T09:02:30.000000+00:00'));
  });

  test('maps MESSAGE_DELETE to message.deleted', () => {
    const event = normalise(dispatch('messageDelete'))[0];

    expect(event?.type).toBe('message.deleted');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps MESSAGE_DELETE_BULK to message.bulk_deleted', () => {
    const event = normalise(dispatch('messageDeleteBulk'))[0];

    expect(event?.type).toBe('message.bulk_deleted');
    expect((event?.payload as { ids: string[] } | undefined)?.ids).toHaveLength(3);
  });

  test('ignores a bulk delete carrying no ids — there is nothing to report', () => {
    const raw = dispatch('messageDeleteBulk');
    raw.d.ids = [];

    expect(normalise(raw)[0]).toBeUndefined();
  });

  test('ignores READY — it carries no internal meaning', () => {
    expect(normalise(dispatch('ready'))[0]).toBeUndefined();
  });

  test('ignores an unknown dispatch without throwing', () => {
    const unknown: RawDispatch = { t: 'SOMETHING_NEW', s: 1, op: 0, d: { id: '1' } };

    expect(() => normalise(unknown)[0]).not.toThrow();
    expect(normalise(unknown)[0]).toBeUndefined();
  });

  test('separates command interactions from component ones', () => {
    expect(normalise(dispatch('interactionCreatePing'))[0]?.type).toBe('interaction.command');
    expect(normalise(dispatch('interactionCreateComponent'))[0]?.type).toBe(
      'interaction.component',
    );
  });

  test('ignores interaction types no phase consumes yet', () => {
    for (const type of [1, 4, 5]) {
      const raw = dispatch('interactionCreatePing');
      raw.d.type = type;

      expect(normalise(raw)[0]).toBeUndefined();
    }
  });

  test('reaction ids distinguish emoji on the same message', () => {
    const first = dispatch('messageReactionAdd');
    const second = dispatch('messageReactionAdd');
    second.d.emoji = { id: null, name: '🎉' };

    expect(normalise(first)[0]?.id).not.toBe(normalise(second)[0]?.id);
  });

  test('a reaction add and its removal are different events', () => {
    expect(normalise(dispatch('messageReactionAdd'))[0]?.id).not.toBe(
      normalise(dispatch('messageReactionRemove'))[0]?.id,
    );
  });

  test('an automod execution keys on the message it acted on', () => {
    const first = dispatch('automodExecution');
    const again = dispatch('automodExecution');
    again.s = 999;

    expect(normalise(first)[0]?.type).toBe('automod.executed');
    expect(normalise(first)[0]?.id).toBe(normalise(again)[0]?.id);
  });

  test('a blocked message has no id, so it keys on what matched', () => {
    const blocked = dispatch('automodExecutionBlocked');
    const other = dispatch('automodExecutionBlocked');
    other.d.matched_content = 'something else entirely';

    expect(normalise(blocked)[0]?.id).not.toBe(normalise(other)[0]?.id);
  });

  test('two members tripping the same rule are two events', () => {
    const first = dispatch('automodExecution');
    const second = dispatch('automodExecution');
    second.d.user_id = '100000000000000009';

    expect(normalise(first)[0]?.id).not.toBe(normalise(second)[0]?.id);
  });

  test('a voice join and a voice disconnect are different events', () => {
    const join = normalise(dispatch('voiceStateJoin'))[0];
    const leave = normalise(dispatch('voiceStateLeave'))[0];

    expect(join?.type).toBe('voice.state_updated');
    expect(leave?.type).toBe('voice.state_updated');
    expect(join?.id).not.toBe(leave?.id);
  });

  test('member updates key on the resulting state, not the dispatch', () => {
    const unchanged = dispatch('guildMemberUpdate');
    const sameAgain = dispatch('guildMemberUpdate');
    sameAgain.s = 999;

    expect(normalise(unchanged)[0]?.id).toBe(normalise(sameAgain)[0]?.id);

    const roleAdded = dispatch('guildMemberUpdate');
    roleAdded.d.roles = ['700000000000000001'];

    expect(normalise(roleAdded)[0]?.id).not.toBe(normalise(unchanged)[0]?.id);
  });

  test('member update ids do not depend on the order Discord lists roles in', () => {
    const forward = dispatch('guildMemberUpdate');
    const reversed = dispatch('guildMemberUpdate');
    reversed.d.roles = ['700000000000000002', '700000000000000001'];

    expect(normalise(forward)[0]?.id).toBe(normalise(reversed)[0]?.id);
  });

  describe('event ids are deterministic across redelivery', () => {
    test('the same interaction dispatch always yields the same id', () => {
      const first = normalise(dispatch('interactionCreatePing'))[0];
      const second = normalise(dispatch('interactionCreatePing'))[0];

      expect(first?.id).toBe(second?.id);
      expect(first?.id).toContain('1300000000000000001');
    });

    test('the id is stable even when the sequence number differs', () => {
      const replayed = dispatch('interactionCreatePing');
      replayed.s = 9999;

      expect(normalise(replayed)[0]?.id).toBe(normalise(dispatch('interactionCreatePing'))[0]?.id);
    });

    test('different messages get different ids', () => {
      const other = dispatch('messageCreate');
      other.d.id = '1400000000000000002';

      expect(normalise(dispatch('messageCreate'))[0]?.id).not.toBe(normalise(other)[0]?.id);
    });

    test('an edit does not dedupe against the message it edits', () => {
      const created = normalise(dispatch('messageCreate'))[0];
      const updated = normalise(dispatch('messageUpdate'))[0];

      expect(created?.id).not.toBe(updated?.id);
    });

    test('two edits of the same message get different ids', () => {
      const later = dispatch('messageUpdate');
      later.d.edited_timestamp = '2026-08-14T09:05:00.000000+00:00';

      expect(normalise(dispatch('messageUpdate'))[0]?.id).not.toBe(normalise(later)[0]?.id);
    });

    test('a bulk delete id is independent of the order Discord listed the ids', () => {
      const shuffled = dispatch('messageDeleteBulk');
      shuffled.d.ids = [...(shuffled.d.ids as string[])].reverse();

      expect(normalise(shuffled)[0]?.id).toBe(normalise(dispatch('messageDeleteBulk'))[0]?.id);
    });

    test('two different purges with the same bounds and count get different ids', () => {
      const first = dispatch('messageDeleteBulk');
      first.d.ids = ['1400000000000000001', '1400000000000000002', '1400000000000000009'];

      const second = dispatch('messageDeleteBulk');
      second.d.ids = ['1400000000000000001', '1400000000000000007', '1400000000000000009'];

      expect(normalise(first)[0]?.id).not.toBe(normalise(second)[0]?.id);
    });

    test('the bulk delete id stays short regardless of how many messages went', () => {
      const raw = dispatch('messageDeleteBulk');
      raw.d.ids = Array.from({ length: 100 }, (_, i) =>
        String(1_400_000_000_000_000_000n + BigInt(i)),
      );

      expect((normalise(raw)[0]?.id ?? '').length).toBeLessThan(80);
    });
  });

  describe('NORMALISED_EVENT_TYPES', () => {
    test('lists every type the switch can actually return', () => {
      const emitted = new Set(NORMALISED_EVENT_TYPES);
      const seen = (
        [
          'guildCreate',
          'guildMemberAdd',
          'messageCreate',
          'messageUpdate',
          'messageDelete',
          'messageDeleteBulk',
          'interactionCreatePing',
          'interactionCreateComponent',
          'auditLogChannelDelete',
          'guildMemberUpdate',
          'messageReactionAdd',
          'messageReactionRemove',
          'voiceStateJoin',
          'voiceStateLeave',
        ] as const
      )
        .map((name) => normalise(dispatch(name))[0]?.type)
        .filter((type): type is NonNullable<typeof type> => type !== undefined);

      expect(seen.filter((type) => !emitted.has(type))).toEqual([]);
    });

    test('every listed type is one some dispatch really produces', () => {
      const produced = new Set<string>();

      for (const name of [
        'guildCreate',
        'guildMemberAdd',
        'messageCreate',
        'messageUpdate',
        'messageDelete',
        'messageDeleteBulk',
        'interactionCreatePing',
        'interactionCreateComponent',
        'guildMemberUpdate',
        'messageReactionAdd',
        'messageReactionRemove',
        'voiceStateJoin',

        'guildUpdate',
        'channelCreate',
        'channelUpdate',
        'channelDelete',
        'channelPinsUpdate',
        'threadCreate',
        'threadUpdate',
        'threadDelete',
        'guildRoleCreate',
        'guildRoleUpdate',
        'guildRoleDelete',
        'guildBanAdd',
        'guildBanRemove',
        'inviteCreate',
        'inviteDelete',
        'automodExecution',
      ] as const) {
        for (const event of normalise(dispatch(name))) produced.add(event.type);
      }

      for (const raw of [
        { t: 'GUILD_DELETE', s: 1, op: 0, d: { id: '900000000000000001' } },
        {
          t: 'GUILD_MEMBER_REMOVE',
          s: 2,
          op: 0,
          d: { guild_id: '900000000000000001', user: { id: '400000000000000001' } },
        },
      ] satisfies RawDispatch[]) {
        for (const event of normalise(raw)) produced.add(event.type);
      }

      for (const actionType of AUDIT_LOG_ACTIONS.keys()) {
        const raw = dispatch('auditLogChannelDelete');
        raw.d.action_type = actionType;
        for (const event of normalise(raw)) produced.add(event.type);
      }

      expect(NORMALISED_EVENT_TYPES.filter((type) => !produced.has(type))).toEqual([]);
    });

    test('has no duplicates', () => {
      expect(new Set(NORMALISED_EVENT_TYPES).size).toBe(NORMALISED_EVENT_TYPES.length);
    });
  });
});

describe('audit log ingestion', () => {
  function auditPayload(event: ProtonEvent | undefined): AuditLogEventPayload {
    return event?.payload as AuditLogEventPayload;
  }

  test('action_type numbers match Discord published values', () => {
    expect([...AUDIT_LOG_ACTIONS.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [10, 'channel.created'],
      [12, 'channel.deleted'],
      [20, 'member.kicked'],
      [22, 'member.banned'],
      [23, 'member.unbanned'],
      [30, 'role.created'],
      [32, 'role.deleted'],
      [52, 'webhook.deleted'],
      [62, 'emoji.deleted'],
    ]);
  });

  test('maps a CHANNEL_DELETE entry to channel.deleted with its actor', () => {
    const event = normalise(dispatch('auditLogChannelDelete'))[0];

    expect(event?.type).toBe('channel.deleted');
    expect(event?.guildId).toBe('900000000000000001');
    expect(auditPayload(event)).toEqual({
      entryId: '1537750759112835075',
      guildId: '900000000000000001',
      actionType: 12,
      actorId: '200000000000000009',
      targetId: '500000000000000042',
      reason: 'spring cleaning',
    });
  });

  test.each([...AUDIT_LOG_ACTIONS.entries()])(
    'action_type %i maps to %s and keeps the actor',
    (actionType, expected) => {
      const raw = dispatch('auditLogChannelDelete');
      raw.d.action_type = actionType;

      const event = normalise(raw)[0];

      expect(event?.type).toBe(expected);
      expect(auditPayload(event).actorId).toBe('200000000000000009');
      expect(auditPayload(event).actionType).toBe(actionType);
    },
  );

  test.each([25, 50, 60, 9999])(
    'action_type %i yields only the generic audit.entry, never a narrow type',
    (actionType) => {
      const raw = dispatch('auditLogChannelDelete');
      raw.d.action_type = actionType;

      expect(normalise(raw).map((e) => e.type)).toEqual(['audit.entry']);
    },
  );

  test('a mapped action_type yields the narrow type first and audit.entry alongside it', () => {
    expect(normalise(dispatch('auditLogChannelDelete')).map((e) => e.type)).toEqual([
      'channel.deleted',
      'audit.entry',
    ]);
  });

  test('audit.entry carries the changes and options the narrow payload drops', () => {
    const raw = dispatch('auditLogChannelDelete');
    raw.d.changes = [{ key: 'name', old_value: 'general' }];
    raw.d.options = { count: '2' };

    const [narrow, generic] = normalise(raw);
    const entry = generic?.payload as AuditEntry | undefined;

    expect(narrow?.payload).not.toHaveProperty('changes');
    expect(entry?.changes).toEqual([{ key: 'name', old_value: 'general' }]);
    expect(entry?.options).toEqual({ count: '2' });
  });

  test('the same entry yields the same ids for both events on replay', () => {
    const first = normalise(dispatch('auditLogChannelDelete')).map((e) => e.id);
    const second = normalise(dispatch('auditLogChannelDelete')).map((e) => e.id);

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
  });

  test('ignores an entry with a missing or non-numeric action_type', () => {
    const missing = dispatch('auditLogChannelDelete');

    delete missing.d.action_type;
    const wrongType = dispatch('auditLogChannelDelete');
    wrongType.d.action_type = '12';

    expect(normalise(missing)).toEqual([]);
    expect(normalise(wrongType)).toEqual([]);
  });

  test('emits an entry with no user_id, with a null actor', () => {
    const raw = dispatch('auditLogChannelDelete');

    delete raw.d.user_id;

    expect(auditPayload(normalise(raw)[0]).actorId).toBeNull();
  });

  test('drops an entry whose id or guild_id is unusable', () => {
    const noId = dispatch('auditLogChannelDelete');
    noId.d.id = 'not-a-snowflake';
    const noGuild = dispatch('auditLogChannelDelete');

    delete noGuild.d.guild_id;

    expect(normalise(noId)).toEqual([]);
    expect(normalise(noGuild)).toEqual([]);
  });

  test('reason and target are null when Discord sends neither', () => {
    const raw = dispatch('auditLogChannelDelete');

    delete raw.d.reason;

    delete raw.d.target_id;

    const payload = auditPayload(normalise(raw)[0]);

    expect(payload.reason).toBeNull();
    expect(payload.targetId).toBeNull();
  });

  test('occurredAt is the entry snowflake time, not the clock', () => {
    const event = normalise(dispatch('auditLogChannelDelete'), { now: () => 1 })[0];

    expect(event?.occurredAt).toBe(snowflakeCreatedAt('1537750759112835075') ?? 0);
    expect(event?.occurredAt).toBe(Date.parse('2026-08-14T09:12:31.000Z'));
  });

  describe('ids stay deterministic across redelivery', () => {
    test('the same entry always yields the same id and time', () => {
      const first = normalise(dispatch('auditLogChannelDelete'), { now: () => 1 })[0];
      const second = normalise(dispatch('auditLogChannelDelete'), { now: () => 999_999 })[0];

      expect(first?.id).toBe('channel.deleted:1537750759112835075');
      expect(second?.id).toBe(first?.id);
      expect(second?.occurredAt).toBe(first?.occurredAt);
    });

    test('the id is stable even when the sequence number differs', () => {
      const replayed = dispatch('auditLogChannelDelete');
      replayed.s = 9999;

      expect(normalise(replayed)[0]?.id).toBe(normalise(dispatch('auditLogChannelDelete'))[0]?.id);
    });

    test('two entries for the same channel get different ids', () => {
      const other = dispatch('auditLogChannelDelete');
      other.d.id = '1537750759112835076';

      expect(normalise(other)[0]?.id).not.toBe(normalise(dispatch('auditLogChannelDelete'))[0]?.id);
    });
  });

  describe('the Gate 2 burst', () => {
    const events = dispatchSequence('auditLogChannelDeleteBurst').map((raw) => normalise(raw)[0]);

    test('yields twenty channel.deleted events', () => {
      expect(events).toHaveLength(20);
      expect(events.every((e) => e?.type === 'channel.deleted')).toBe(true);
    });

    test('attributes every one of them to the same actor', () => {
      const actors = new Set(events.map((e) => auditPayload(e).actorId));

      expect([...actors]).toEqual(['200000000000000009']);
    });

    test('spans under five seconds by the entries own timestamps', () => {
      const times = events.map((e) => e?.occurredAt ?? 0);

      expect(Math.max(...times) - Math.min(...times)).toBeLessThan(5000);
    });

    test('gives every deletion a distinct id, and the same ids on replay', () => {
      const ids = events.map((e) => e?.id);
      const replayed = dispatchSequence('auditLogChannelDeleteBurst').map(
        (raw) => normalise(raw)[0],
      );

      expect(new Set(ids).size).toBe(20);
      expect(replayed.map((e) => e?.id)).toEqual(ids);
    });

    test('targets twenty distinct channels', () => {
      expect(new Set(events.map((e) => auditPayload(e).targetId)).size).toBe(20);
    });
  });
});

describe('channel obfuscation', () => {
  test('detects an obfuscated channel by flag, not by name', () => {
    const raw = dispatch('channelObfuscated');
    const channels = raw.d.channels as Array<{ id: string; name: string; flags: number }>;

    const visible = channels.find((c) => c.id === '500000000000000001') ?? { flags: -1 };
    const hidden = channels.find((c) => c.id === '500000000000000002') ?? { flags: -1 };

    expect(isObfuscatedChannel(visible)).toBe(false);
    expect(isObfuscatedChannel(hidden)).toBe(true);
    expect(CHANNEL_OBFUSCATED).toBe(131072);
  });

  test('a real channel named ___hidden___ is NOT treated as obfuscated', () => {
    expect(isObfuscatedChannel({ flags: 0 })).toBe(false);
  });

  test('unobfuscated fields survive on an obfuscated channel', () => {
    const raw = dispatch('channelObfuscated');
    const channels = raw.d.channels as Array<Record<string, unknown>>;
    const hidden = channels.find((c) => c.id === '500000000000000002');

    expect(hidden?.id).toBe('500000000000000002');
    expect(hidden?.type).toBe(0);
    expect(hidden?.position).toBe(1);
    expect(hidden?.name).toBe('___hidden___');
  });
});

describe('entity dispatches', () => {
  const cases = [
    ['guildUpdate', 'entity.guild_updated'],
    ['channelCreate', 'entity.channel_created'],
    ['channelUpdate', 'entity.channel_updated'],
    ['channelDelete', 'entity.channel_deleted'],
    ['channelPinsUpdate', 'entity.channel_pins_updated'],
    ['threadCreate', 'entity.thread_created'],
    ['threadUpdate', 'entity.thread_updated'],
    ['threadDelete', 'entity.thread_deleted'],
    ['guildRoleCreate', 'entity.role_created'],
    ['guildRoleUpdate', 'entity.role_updated'],
    ['guildRoleDelete', 'entity.role_deleted'],
    ['guildBanAdd', 'entity.ban_added'],
    ['guildBanRemove', 'entity.ban_removed'],
    ['inviteCreate', 'entity.invite_created'],
    ['inviteDelete', 'entity.invite_deleted'],
  ] as const;

  test.each(cases)('%s maps to %s and keeps its guild', (name, expected) => {
    const [event] = normalise(dispatch(name));

    expect(event?.type).toBe(expected);
    expect(event?.guildId).toBe('900000000000000001');
  });

  test.each(cases)('%s produces exactly one event', (name) => {
    expect(normalise(dispatch(name))).toHaveLength(1);
  });

  test.each(cases)('%s keeps its id across redelivery', (name) => {
    const replayed = dispatch(name);
    replayed.s = 9999;

    expect(normalise(replayed)[0]?.id).toBe(normalise(dispatch(name))[0]?.id);
  });

  test('the whole entity payload is passed through untouched', () => {
    const [event] = normalise(dispatch('channelCreate'));

    expect(event?.payload).toMatchObject({
      id: '500000000000000021',
      name: 'announcements',
      type: 0,
      parent_id: '500000000000000009',
    });
  });

  test('a renamed channel is a different event from its creation', () => {
    expect(normalise(dispatch('channelCreate'))[0]?.id).not.toBe(
      normalise(dispatch('channelUpdate'))[0]?.id,
    );
  });

  test('two different edits of the same channel get different ids', () => {
    const renamed = dispatch('channelUpdate');
    renamed.d.name = 'announcements-v3';

    expect(normalise(renamed)[0]?.id).not.toBe(normalise(dispatch('channelUpdate'))[0]?.id);
  });

  test('a role edit keys on the role, not on the dispatch envelope', () => {
    const resent = dispatch('guildRoleUpdate');
    resent.s = 4242;

    expect(normalise(resent)[0]?.id).toBe(normalise(dispatch('guildRoleUpdate'))[0]?.id);

    const recoloured = dispatch('guildRoleUpdate');
    (recoloured.d.role as Record<string, unknown>).color = 1;

    expect(normalise(recoloured)[0]?.id).not.toBe(normalise(dispatch('guildRoleUpdate'))[0]?.id);
  });

  test('a ban and its reversal are different events for the same user', () => {
    const added = normalise(dispatch('guildBanAdd'))[0];
    const removed = normalise(dispatch('guildBanRemove'))[0];

    expect(added?.id).not.toBe(removed?.id);
    expect(added?.id).toContain('100000000000000007');
  });

  test('drops an entity dispatch with no usable id', () => {
    const roleless = dispatch('guildRoleCreate');
    roleless.d.role = {};
    const codeless = dispatch('inviteDelete');

    delete codeless.d.code;

    expect(normalise(roleless)).toEqual([]);
    expect(normalise(codeless)).toEqual([]);
  });
});

describe('member updates that only screening changed', () => {
  test('accepting the rules is its own event, not a duplicate of the join-time state', () => {
    const pending = dispatch('guildMemberUpdateScreened');
    pending.d.pending = true;

    expect(normalise(pending)[0]?.id).not.toBe(
      normalise(dispatch('guildMemberUpdateScreened'))[0]?.id,
    );
  });
});
