import { describe, expect, test } from 'bun:test';
import { type AuditLogEventPayload, snowflakeCreatedAt } from '@proton/core';
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
    const event = normalise(dispatch('interactionCreatePing'));

    expect(event?.type).toBe('interaction.command');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps GUILD_CREATE to guild.available', () => {
    const event = normalise(dispatch('guildCreate'));

    expect(event?.type).toBe('guild.available');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps GUILD_MEMBER_ADD to member.joined with the payload timestamp', () => {
    const event = normalise(dispatch('guildMemberAdd'));

    expect(event?.type).toBe('member.joined');
    expect(event?.occurredAt).toBe(Date.parse('2026-08-14T09:00:00.000000+00:00'));
  });

  test('maps MESSAGE_CREATE to message.created', () => {
    const event = normalise(dispatch('messageCreate'));

    expect(event?.type).toBe('message.created');
  });

  test('maps MESSAGE_UPDATE to message.updated, timed by the edit', () => {
    const event = normalise(dispatch('messageUpdate'));

    expect(event?.type).toBe('message.updated');
    expect(event?.guildId).toBe('900000000000000001');
    expect(event?.occurredAt).toBe(Date.parse('2026-08-14T09:02:30.000000+00:00'));
  });

  test('maps MESSAGE_DELETE to message.deleted', () => {
    const event = normalise(dispatch('messageDelete'));

    expect(event?.type).toBe('message.deleted');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps MESSAGE_DELETE_BULK to message.bulk_deleted', () => {
    const event = normalise(dispatch('messageDeleteBulk'));

    expect(event?.type).toBe('message.bulk_deleted');
    expect((event?.payload as { ids: string[] } | undefined)?.ids).toHaveLength(3);
  });

  test('ignores a bulk delete carrying no ids — there is nothing to report', () => {
    const raw = dispatch('messageDeleteBulk');
    raw.d.ids = [];

    expect(normalise(raw)).toBeNull();
  });

  test('ignores READY — it carries no internal meaning', () => {
    expect(normalise(dispatch('ready'))).toBeNull();
  });

  test('ignores an unknown dispatch without throwing', () => {
    const unknown: RawDispatch = { t: 'SOMETHING_NEW', s: 1, op: 0, d: { id: '1' } };

    expect(() => normalise(unknown)).not.toThrow();
    expect(normalise(unknown)).toBeNull();
  });

  /**
   * Types 2 and 3 are the two Proton dispatches on; everything else is still
   * dropped. Asserted per type rather than as "not null", because routing a
   * component press to `interaction.command` would send it to the command
   * runtime, which would look up a command named after a `custom_id` and log
   * "no module owns the command" forever.
   */
  test('separates command interactions from component ones', () => {
    expect(normalise(dispatch('interactionCreatePing'))?.type).toBe('interaction.command');
    expect(normalise(dispatch('interactionCreateComponent'))?.type).toBe('interaction.component');
  });

  test('ignores interaction types no phase consumes yet', () => {
    for (const type of [1, 4, 5]) {
      const raw = dispatch('interactionCreatePing');
      raw.d.type = type;

      expect(normalise(raw)).toBeNull();
    }
  });

  /**
   * A reaction dispatch carries no id of its own, so the key is built from who
   * reacted with what, where. The emoji has to be in it: two different emoji on
   * one message by one member are two distinct facts, and a key without it would
   * silently treat the second as a redelivery of the first — which for a role
   * menu means the second binding never applies.
   */
  test('reaction ids distinguish emoji on the same message', () => {
    const first = dispatch('messageReactionAdd');
    const second = dispatch('messageReactionAdd');
    second.d.emoji = { id: null, name: '🎉' };

    expect(normalise(first)?.id).not.toBe(normalise(second)?.id);
  });

  test('a reaction add and its removal are different events', () => {
    expect(normalise(dispatch('messageReactionAdd'))?.id).not.toBe(
      normalise(dispatch('messageReactionRemove'))?.id,
    );
  });

  /**
   * `channel_id: null` is the disconnect, and it must not collide with joining a
   * channel — otherwise leaving voice would dedupe against the join and the
   * session would never be closed or paid out.
   */
  test('a voice join and a voice disconnect are different events', () => {
    const join = normalise(dispatch('voiceStateJoin'));
    const leave = normalise(dispatch('voiceStateLeave'));

    expect(join?.type).toBe('voice.state_updated');
    expect(leave?.type).toBe('voice.state_updated');
    expect(join?.id).not.toBe(leave?.id);
  });

  /**
   * GUILD_MEMBER_UPDATE fires for changes Proton does not model — avatar, banner,
   * boost status. Keying on the resulting roles/nick/timeout means those collapse
   * onto one id and dedupe, instead of rewriting an identical sticky-role snapshot
   * on every avatar change in the guild.
   */
  test('member updates key on the resulting state, not the dispatch', () => {
    const unchanged = dispatch('guildMemberUpdate');
    const sameAgain = dispatch('guildMemberUpdate');
    sameAgain.s = 999;

    expect(normalise(unchanged)?.id).toBe(normalise(sameAgain)?.id);

    const roleAdded = dispatch('guildMemberUpdate');
    roleAdded.d.roles = ['700000000000000001'];

    expect(normalise(roleAdded)?.id).not.toBe(normalise(unchanged)?.id);
  });

  test('member update ids do not depend on the order Discord lists roles in', () => {
    const forward = dispatch('guildMemberUpdate');
    const reversed = dispatch('guildMemberUpdate');
    reversed.d.roles = ['700000000000000002', '700000000000000001'];

    expect(normalise(forward)?.id).toBe(normalise(reversed)?.id);
  });

  /**
   * The property the whole dedupe story rests on. Gateway RESUME redelivers the
   * identical dispatch; if the normaliser minted a fresh id each time, the same
   * Discord event would be handled twice and I4 would be unenforceable.
   */
  describe('event ids are deterministic across redelivery', () => {
    test('the same interaction dispatch always yields the same id', () => {
      const first = normalise(dispatch('interactionCreatePing'));
      const second = normalise(dispatch('interactionCreatePing'));

      expect(first?.id).toBe(second?.id);
      expect(first?.id).toContain('1300000000000000001');
    });

    test('the id is stable even when the sequence number differs', () => {
      // A RESUME can replay the same event under a different `s`.
      const replayed = dispatch('interactionCreatePing');
      replayed.s = 9999;

      expect(normalise(replayed)?.id).toBe(normalise(dispatch('interactionCreatePing'))?.id);
    });

    test('different messages get different ids', () => {
      const other = dispatch('messageCreate');
      other.d.id = '1400000000000000002';

      expect(normalise(dispatch('messageCreate'))?.id).not.toBe(normalise(other)?.id);
    });

    /**
     * An edit must not collide with the post it edits. They share a message id,
     * so a key built from that alone would have the first edit dedupe against
     * the original — and phishing would never inspect the edited content, which
     * is the entire reason MESSAGE_UPDATE is watched.
     */
    test('an edit does not dedupe against the message it edits', () => {
      const created = normalise(dispatch('messageCreate'));
      const updated = normalise(dispatch('messageUpdate'));

      expect(created?.id).not.toBe(updated?.id);
    });

    test('two edits of the same message get different ids', () => {
      const later = dispatch('messageUpdate');
      later.d.edited_timestamp = '2026-08-14T09:05:00.000000+00:00';

      expect(normalise(dispatch('messageUpdate'))?.id).not.toBe(normalise(later)?.id);
    });

    /**
     * A RESUME can replay a bulk delete with `ids` in a different order. Keyed
     * off the raw array that would read as a second, unrelated purge.
     */
    test('a bulk delete id is independent of the order Discord listed the ids', () => {
      const shuffled = dispatch('messageDeleteBulk');
      shuffled.d.ids = [...(shuffled.d.ids as string[])].reverse();

      expect(normalise(shuffled)?.id).toBe(normalise(dispatch('messageDeleteBulk'))?.id);
    });

    /**
     * Two purges in one channel that share their lowest id, highest id and count
     * are still different purges. A `{first, last, count}` digest would collide
     * them onto one event id and silently drop the second.
     */
    test('two different purges with the same bounds and count get different ids', () => {
      const first = dispatch('messageDeleteBulk');
      first.d.ids = ['1400000000000000001', '1400000000000000002', '1400000000000000009'];

      const second = dispatch('messageDeleteBulk');
      second.d.ids = ['1400000000000000001', '1400000000000000007', '1400000000000000009'];

      expect(normalise(first)?.id).not.toBe(normalise(second)?.id);
    });

    /** 100 ids is Discord's limit; the key must not carry all of them verbatim. */
    test('the bulk delete id stays short regardless of how many messages went', () => {
      const raw = dispatch('messageDeleteBulk');
      raw.d.ids = Array.from({ length: 100 }, (_, i) =>
        String(1_400_000_000_000_000_000n + BigInt(i)),
      );

      expect((normalise(raw)?.id ?? '').length).toBeLessThan(80);
    });
  });

  /**
   * The contract `packages/modules/registry` asserts every listener against.
   * An arm added to the switch without a line in the constant makes the guard a
   * lie, so it is checked here, at the source.
   */
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
        .map((name) => normalise(dispatch(name))?.type)
        .filter((type): type is NonNullable<typeof type> => type !== undefined);

      expect(seen.filter((type) => !emitted.has(type))).toEqual([]);
    });

    /**
     * The direction that actually caused the bug, and the one a subset check
     * cannot catch.
     *
     * `packages/modules/registry` asserts that every listener names a type in
     * this constant. That guard is only worth anything if the constant is true —
     * delete the MESSAGE_UPDATE arm and the constant still lists
     * `message.updated`, the registry guard still passes, and `logging` and
     * `phishing` go back to receiving nothing forever with a green suite. Which
     * is exactly what had already happened.
     *
     * So every entry is *produced*, not merely declared: a dispatch is built for
     * each one and pushed through the real switch. The audit types come from one
     * fixture with its `action_type` varied, since that is the only field that
     * distinguishes them.
     */
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
      ] as const) {
        const type = normalise(dispatch(name))?.type;
        if (type) produced.add(type);
      }

      // Two dispatches have no fixture of their own — both are a couple of
      // fields, and this check found `member.left` missing the first time it
      // ran, which is the point of writing it.
      for (const raw of [
        { t: 'GUILD_DELETE', s: 1, op: 0, d: { id: '900000000000000001' } },
        {
          t: 'GUILD_MEMBER_REMOVE',
          s: 2,
          op: 0,
          d: { guild_id: '900000000000000001', user: { id: '400000000000000001' } },
        },
      ] satisfies RawDispatch[]) {
        const type = normalise(raw)?.type;
        if (type) produced.add(type);
      }

      // Every audit action the map knows, driven through the real arm.
      for (const actionType of AUDIT_LOG_ACTIONS.keys()) {
        const raw = dispatch('auditLogChannelDelete');
        raw.d.action_type = actionType;
        const type = normalise(raw)?.type;
        if (type) produced.add(type);
      }

      expect(NORMALISED_EVENT_TYPES.filter((type) => !produced.has(type))).toEqual([]);
    });

    test('has no duplicates', () => {
      expect(new Set(NORMALISED_EVENT_TYPES).size).toBe(NORMALISED_EVENT_TYPES.length);
    });
  });
});

describe('audit log ingestion', () => {
  function auditPayload(event: ReturnType<typeof normalise>): AuditLogEventPayload {
    return event?.payload as AuditLogEventPayload;
  }

  /**
   * The one failure in the normaliser nothing downstream can detect. A wrong
   * action_type number does not throw and does not log — the entry simply falls
   * through to `default`, the breaker never fires, and the guild is nuked while
   * every test still passes. So the numbers are pinned to the values published
   * at docs.discord.com/developers/resources/audit-log rather than only to the
   * `discord-api-types` enum they are read from, which would make this test
   * agree with the source it is meant to check.
   */
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
    const event = normalise(dispatch('auditLogChannelDelete'));

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

      const event = normalise(raw);

      expect(event?.type).toBe(expected);
      expect(auditPayload(event).actorId).toBe('200000000000000009');
      expect(auditPayload(event).actionType).toBe(actionType);
    },
  );

  /**
   * Discord ships around fifty action types and adds more without warning. An
   * unmapped one — here MEMBER_ROLE_UPDATE (25) and WEBHOOK_CREATE (50), both
   * real and both deliberately not consumed — must be as uneventful as any other
   * dispatch we have no meaning for.
   */
  test.each([25, 50, 60, 9999, -1])('ignores unmapped action_type %i', (actionType) => {
    const raw = dispatch('auditLogChannelDelete');
    raw.d.action_type = actionType;

    expect(() => normalise(raw)).not.toThrow();
    expect(normalise(raw)).toBeNull();
  });

  test('ignores an entry with a missing or non-numeric action_type', () => {
    const missing = dispatch('auditLogChannelDelete');
    // Discord omits the field entirely rather than sending null.
    delete missing.d.action_type;
    const wrongType = dispatch('auditLogChannelDelete');
    wrongType.d.action_type = '12';

    expect(normalise(missing)).toBeNull();
    expect(normalise(wrongType)).toBeNull();
  });

  /**
   * Discord omits `user_id` on entries with no human behind them. The event is
   * still worth logging, so it is emitted with a null actor — anti-nuke skips
   * what it cannot attribute rather than inventing an actor to blame.
   */
  test('emits an entry with no user_id, with a null actor', () => {
    const raw = dispatch('auditLogChannelDelete');
    // Discord omits the field entirely rather than sending null.
    delete raw.d.user_id;

    expect(auditPayload(normalise(raw)).actorId).toBeNull();
  });

  test('drops an entry whose id or guild_id is unusable', () => {
    const noId = dispatch('auditLogChannelDelete');
    noId.d.id = 'not-a-snowflake';
    const noGuild = dispatch('auditLogChannelDelete');
    // An entry with no guild_id has nothing for a guild-scoped consumer to act on.
    delete noGuild.d.guild_id;

    expect(normalise(noId)).toBeNull();
    expect(normalise(noGuild)).toBeNull();
  });

  test('reason and target are null when Discord sends neither', () => {
    const raw = dispatch('auditLogChannelDelete');
    // Both fields are optional on an audit entry.
    delete raw.d.reason;
    // Both fields are optional on an audit entry.
    delete raw.d.target_id;

    const payload = auditPayload(normalise(raw));

    expect(payload.reason).toBeNull();
    expect(payload.targetId).toBeNull();
  });

  /**
   * `occurredAt` comes from the entry snowflake, not the clock. Audit-log
   * delivery lags reality and arrives unordered (§15), so timing a burst by
   * arrival would compress one that was actually spread out — and would differ
   * between the first delivery and the RESUME replay of the same entry.
   */
  test('occurredAt is the entry snowflake time, not the clock', () => {
    const event = normalise(dispatch('auditLogChannelDelete'), { now: () => 1 });

    expect(event?.occurredAt).toBe(snowflakeCreatedAt('1537750759112835075') ?? 0);
    expect(event?.occurredAt).toBe(Date.parse('2026-08-14T09:12:31.000Z'));
  });

  describe('ids stay deterministic across redelivery', () => {
    test('the same entry always yields the same id and time', () => {
      const first = normalise(dispatch('auditLogChannelDelete'), { now: () => 1 });
      const second = normalise(dispatch('auditLogChannelDelete'), { now: () => 999_999 });

      expect(first?.id).toBe('channel.deleted:1537750759112835075');
      expect(second?.id).toBe(first?.id);
      expect(second?.occurredAt).toBe(first?.occurredAt);
    });

    test('the id is stable even when the sequence number differs', () => {
      const replayed = dispatch('auditLogChannelDelete');
      replayed.s = 9999;

      expect(normalise(replayed)?.id).toBe(normalise(dispatch('auditLogChannelDelete'))?.id);
    });

    test('two entries for the same channel get different ids', () => {
      const other = dispatch('auditLogChannelDelete');
      other.d.id = '1537750759112835076';

      expect(normalise(other)?.id).not.toBe(normalise(dispatch('auditLogChannelDelete'))?.id);
    });
  });

  /**
   * PLAN.md §12's Gate 2 input, ingested. This proves only what the normaliser
   * owes the breaker: twenty distinct, attributed, deterministically identified
   * events whose own timestamps span under five seconds. Tripping on them is
   * anti-nuke's job.
   */
  describe('the Gate 2 burst', () => {
    const events = dispatchSequence('auditLogChannelDeleteBurst').map((raw) => normalise(raw));

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
      const replayed = dispatchSequence('auditLogChannelDeleteBurst').map((raw) => normalise(raw));

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

  /**
   * A guild may legitimately name a real channel `___hidden___`. Detecting by
   * string would then hide a channel the bot can actually see — and Discord's
   * docs explicitly warn against inspecting the name.
   */
  test('a real channel named ___hidden___ is NOT treated as obfuscated', () => {
    expect(isObfuscatedChannel({ flags: 0 })).toBe(false);
  });

  test('unobfuscated fields survive on an obfuscated channel', () => {
    const raw = dispatch('channelObfuscated');
    const channels = raw.d.channels as Array<Record<string, unknown>>;
    const hidden = channels.find((c) => c.id === '500000000000000002');

    // id, type, position and parent_id are never obfuscated — a backup module
    // can still record that the channel exists and where it sits.
    expect(hidden?.id).toBe('500000000000000002');
    expect(hidden?.type).toBe(0);
    expect(hidden?.position).toBe(1);
    expect(hidden?.name).toBe('___hidden___');
  });
});
