import { describe, expect, test } from 'bun:test';
import {
  ACTION_KINDS,
  type ActionKind,
  CHANNEL_SCOPED,
  hierarchyApplies,
  isChannelScoped,
  isLedgerOnly,
  isNeverRecorded,
  NEVER_RECORDED_KINDS,
  PAYLOAD_PERMISSIONS,
  REQUIRED_PERMISSIONS,
  requiredPermissionsFor,
  reversalOf,
  TARGETS_MEMBER,
  THREAD_PERMISSION_SUBSTITUTIONS,
  targetsMember,
} from '../../src/actions/kinds.ts';
import { THREAD_TYPE_PRIVATE, THREAD_TYPE_PUBLIC } from '../../src/actions/payloads.ts';
import { type PayloadResult, type RestCall, toRestCall } from '../../src/actions/rest-mapping.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import { ALL_PERMISSIONS, has, Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';
const CHANNEL = '500000000000000001';
const MESSAGE = '700000000000000001';

function request(kind: ActionKind, payload: unknown, reason?: string): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'moderation',
    kind,
    actorId: USER,
    dryRun: false,
    idempotencyKey: 'k',
    payload,
    ...(reason ? { reason } : {}),
  };
}

function callOf(result: PayloadResult): RestCall {
  if ('error' in result) throw new Error(result.error);
  if ('ledgerOnly' in result) throw new Error('expected a REST call, got a ledger-only kind');
  return result.call;
}

describe('every action kind is fully wired', () => {
  test('declares a required permission', () => {
    for (const kind of ACTION_KINDS) {
      expect(REQUIRED_PERMISSIONS).toHaveProperty(kind);
      expect(typeof requiredPermissionsFor(kind)).toBe('bigint');
    }
  });

  test('declares whether it targets a member', () => {
    for (const kind of ACTION_KINDS) {
      expect(TARGETS_MEMBER).toHaveProperty(kind);
      expect(typeof targetsMember(kind)).toBe('boolean');
    }
  });

  test('declares whether it is scoped to a channel', () => {
    for (const kind of ACTION_KINDS) {
      expect(CHANNEL_SCOPED).toHaveProperty(kind);
      expect(typeof isChannelScoped(kind)).toBe('boolean');
    }
  });

  test('rejects a malformed payload rather than mapping it', () => {
    for (const kind of ACTION_KINDS) {
      const result = toRestCall(request(kind, { nonsense: true }));
      expect('error' in result).toBe(true);
    }
  });
});

describe('permission requirements', () => {
  test('moderation kinds require their Discord counterpart', () => {
    expect(requiredPermissionsFor('ban')).toBe(Permissions.BanMembers);
    expect(requiredPermissionsFor('kick')).toBe(Permissions.KickMembers);
    expect(requiredPermissionsFor('timeout')).toBe(Permissions.ModerateMembers);
    expect(requiredPermissionsFor('slowmode')).toBe(Permissions.ManageChannels);
  });

  test('channel overwrites need MANAGE_ROLES, not MANAGE_CHANNELS', () => {
    expect(requiredPermissionsFor('lockdown')).toBe(Permissions.ManageRoles);
    expect(requiredPermissionsFor('unlock')).toBe(Permissions.ManageRoles);
  });

  test('purge needs history access as well as MANAGE_MESSAGES', () => {
    expect(requiredPermissionsFor('purge')).toBe(
      Permissions.ManageMessages | Permissions.ReadMessageHistory,
    );
  });

  test('replying to an interaction requires nothing', () => {
    expect(requiredPermissionsFor('interaction_reply')).toBe(0n);
  });
});

describe('targeting stance', () => {
  test('member-affecting kinds get the hierarchy checks', () => {
    for (const kind of ['ban', 'kick', 'timeout', 'add_role'] as const) {
      expect(targetsMember(kind)).toBe(true);
    }
  });

  test('unban does not, because a banned user has no roles', () => {
    expect(targetsMember('unban')).toBe(false);
  });

  test('channel-affecting kinds do not', () => {
    for (const kind of ['purge', 'slowmode', 'lockdown', 'unlock'] as const) {
      expect(targetsMember(kind)).toBe(false);
    }
  });
});

describe('REST mapping', () => {
  test('ban maps to PUT with the message-purge window', () => {
    const call = callOf(toRestCall(request('ban', { userId: USER, deleteMessageSeconds: 3600 })));

    expect(call.method).toBe('PUT');
    expect(call.path).toBe(`/guilds/${GUILD}/bans/${USER}`);
    expect(call.body).toEqual({ delete_message_seconds: 3600 });
  });

  test('untimeout clears the field rather than setting a past date', () => {
    const call = callOf(toRestCall(request('untimeout', { userId: USER })));

    expect(call.body).toEqual({ communication_disabled_until: null });
  });

  test('a reason becomes Discord’s audit-log header', () => {
    const call = callOf(toRestCall(request('kick', { userId: USER }, 'spamming')));

    expect(call.headers?.['x-audit-log-reason']).toBe('spamming');
  });

  test('timeout beyond Discord’s 28-day cap is refused with an explanation', () => {
    const result = toRestCall(
      request('timeout', { userId: USER, until: new Date(Date.now() + 40 * 86_400_000) }),
    );

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('28 days');
  });

  test('a timeout already in the past is refused', () => {
    const result = toRestCall(
      request('timeout', { userId: USER, until: new Date(Date.now() - 1000) }),
    );

    expect('error' in result).toBe(true);
  });

  test('purge refuses more than Discord’s 100-message bulk limit', () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(10000000000000000n + BigInt(i)));
    const result = toRestCall(request('purge', { channelId: CHANNEL, messageIds: ids }));

    expect('error' in result).toBe(true);
  });

  test('lockdown preserves existing overwrites and adds SEND_MESSAGES to deny', () => {
    const call = callOf(
      toRestCall(
        request('lockdown', {
          channelId: CHANNEL,
          roleId: GUILD,
          previousAllow: '0',
          previousDeny: String(Permissions.AddReactions),
        }),
      ),
    );

    const body = call.body as { deny: string };
    const deny = BigInt(body.deny);

    expect(deny & Permissions.SendMessages).toBe(Permissions.SendMessages);
    expect(deny & Permissions.AddReactions).toBe(Permissions.AddReactions);
  });

  test('unlock restores exactly what lockdown recorded', () => {
    const call = callOf(
      toRestCall(
        request('unlock', {
          channelId: CHANNEL,
          roleId: GUILD,
          restoreAllow: '1024',
          restoreDeny: '64',
        }),
      ),
    );

    expect(call.body).toEqual({ type: 0, allow: '1024', deny: '64' });
  });

  test('warn maps to no REST call at all', () => {
    const result = toRestCall(request('warn', { userId: USER }));

    expect(result).toEqual({ ledgerOnly: true });
  });

  test('warn still validates its payload', () => {
    const result = toRestCall(request('warn', { userId: 'not-a-snowflake' }));

    expect('error' in result).toBe(true);
  });

  test('a message with nothing in it is refused before Discord sees it', () => {
    const result = toRestCall(request('send', { channelId: CHANNEL }));

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('content, an embed, a component, a file or a poll');
  });

  test('send with a file produces matching parts and attachment descriptors', () => {
    const call = callOf(
      toRestCall(
        request('send', {
          channelId: CHANNEL,
          embeds: [{ image: { url: 'attachment://rank.png' } }],
          files: [{ filename: 'rank.png', contentType: 'image/png', data: new Uint8Array([1, 2]) }],
        }),
      ),
    );

    expect(call.files?.[0]?.name).toBe('files[0]');
    expect(call.files?.[0]?.filename).toBe('rank.png');
    expect((call.body as { attachments: unknown[] }).attachments).toEqual([
      { id: 0, filename: 'rank.png' },
    ]);
  });

  test('a deferral carries no message body', () => {
    const call = callOf(
      toRestCall(
        request('interaction_reply', {
          interactionId: USER,
          interactionToken: 'tok',
          callbackType: 5,
          ephemeral: true,
        }),
      ),
    );

    expect(call.body).toEqual({ type: 5, data: { flags: 64 } });
  });
});

describe('reversal pairing', () => {
  test('temporary kinds know how to undo themselves', () => {
    expect(reversalOf('ban')).toBe('unban');
    expect(reversalOf('timeout')).toBe('untimeout');
    expect(reversalOf('add_role')).toBe('remove_role');
    expect(reversalOf('lockdown')).toBe('unlock');
  });

  test('kinds with no meaningful reversal report none', () => {
    expect(reversalOf('purge')).toBeUndefined();
    expect(reversalOf('kick')).toBeUndefined();
  });
});

const VALID_PAYLOADS = {
  delete_channel: { channelId: CHANNEL },
  edit_channel: { channelId: CHANNEL, name: 'general' },
  create_thread: { channelId: CHANNEL, name: 'ticket-0007', type: THREAD_TYPE_PUBLIC },
  move_member: { userId: USER, channelId: CHANNEL },
  end_poll: { channelId: CHANNEL, messageId: MESSAGE },
  pin_message: { channelId: CHANNEL, messageId: MESSAGE },
} satisfies Partial<Record<ActionKind, unknown>>;

const CHANNEL_AND_POLL_KINDS: Array<keyof typeof VALID_PAYLOADS> = [
  'delete_channel',
  'edit_channel',
  'create_thread',
  'move_member',
  'end_poll',
  'pin_message',
];

describe('the tables every action kind is read out of', () => {
  test('flags exactly the kinds that act on a member, so hierarchy is checked once', () => {
    expect(ACTION_KINDS.filter((kind) => targetsMember(kind))).toEqual([
      'warn',
      'ban',
      'kick',
      'timeout',
      'untimeout',
      'add_role',
      'remove_role',
      'move_member',
    ]);
  });

  test('leaves only the interaction replies, the ledger-only kinds and the bot’s own profile requiring no permission', () => {
    expect(ACTION_KINDS.filter((kind) => requiredPermissionsFor(kind) === 0n)).toEqual([
      'interaction_reply',
      'interaction_followup',
      'warn',
      'giveaway_draw',
      'create_dm',
      // Modify Current Member lists a permission against `nick` and none against avatar, banner or
      // bio, which is the whole reason branding splits its push into two kinds.
      'set_bot_profile',
    ]);
  });

  test('builds every requirement out of bits Discord actually defines', () => {
    for (const kind of ACTION_KINDS) {
      expect(requiredPermissionsFor(kind) & ~ALL_PERMISSIONS).toBe(0n);
    }
  });

  test('names the interaction acknowledgements, the DM lookup and the branding pushes as never recorded', () => {
    expect(ACTION_KINDS.filter((kind) => NEVER_RECORDED_KINDS.has(kind))).toEqual([
      'interaction_reply',
      'interaction_followup',
      'create_dm',
      // Not for noise: their payload carries an image as a data URI, and cases.payload is jsonb.
      'set_bot_nickname',
      'set_bot_profile',
      // Proton putting its own colour role on and off itself, on every reconnect. The role's own
      // creation is recorded; wearing it is bookkeeping.
      'add_bot_role',
      'remove_bot_role',
    ]);
  });

  test('keeps ledger-only and never-recorded kinds disjoint, so warn is still a case', () => {
    expect(ACTION_KINDS.filter((k) => isLedgerOnly(k) && isNeverRecorded(k))).toEqual([]);
    expect(isNeverRecorded('warn')).toBe(false);
    expect(isNeverRecorded('ban')).toBe(false);
    expect(isNeverRecorded('send')).toBe(false);
  });

  test.each(CHANNEL_AND_POLL_KINDS)('%s appears in both tables the prechecks read', (kind) => {
    expect(REQUIRED_PERMISSIONS).toHaveProperty(kind);
    expect(TARGETS_MEMBER).toHaveProperty(kind);
  });

  test('names exactly the kinds addressed to a channel, so the rest are judged guild-wide', () => {
    expect(ACTION_KINDS.filter(isChannelScoped)).toEqual([
      'send',
      'edit_message',
      'delete_message',
      'add_reaction',
      'purge',
      'slowmode',
      'lockdown',
      'unlock',
      'delete_channel',
      'edit_channel',
      'set_channel_overwrite',
      'delete_channel_overwrite',
      'create_thread',
      'move_member',
      'end_poll',
      'pin_message',
    ]);
  });

  test('keeps every guild-wide permission off the channel scope that cannot grant it', () => {
    for (const kind of [
      'ban',
      'unban',
      'kick',
      'timeout',
      'untimeout',
      'add_role',
      'remove_role',
      'create_role',
      'create_channel',
      'warn',
      'automod_rule_create',
      'automod_rule_update',
      'automod_rule_delete',
    ] as const) {
      expect(isChannelScoped(kind)).toBe(false);
    }
  });

  test('judges move_member in the destination channel, and asks to be able to join it', () => {
    // Discord refuses the move unless the bot could connect to the destination itself, so the
    // channel the precheck must judge is the one in the payload, not the one the command was
    // typed in.
    expect(isChannelScoped('move_member')).toBe(true);
    expect(has(REQUIRED_PERMISSIONS.move_member, Permissions.MoveMembers)).toBe(true);
    expect(has(REQUIRED_PERMISSIONS.move_member, Permissions.Connect)).toBe(true);
  });

  test('routes only move_member of the six new kinds through the hierarchy check', () => {
    expect(CHANNEL_AND_POLL_KINDS.filter((kind) => targetsMember(kind))).toEqual(['move_member']);
  });
});

describe('the requirement a thread changes', () => {
  const IN_THREAD = true;

  test('substitutes SendMessagesInThreads, bit 38, for the SendMessages a thread ignores', () => {
    const required = requiredPermissionsFor(
      'send',
      { channelId: CHANNEL, content: 'hi' },
      IN_THREAD,
    );

    expect(Permissions.SendMessagesInThreads).toBe(1n << 38n);
    expect(has(required, Permissions.SendMessagesInThreads)).toBe(true);
    expect(has(required, Permissions.SendMessages)).toBe(false);
  });

  test('keeps the rest of the requirement, so a poll in a thread still needs SendPolls', () => {
    const required = requiredPermissionsFor('send', POLL_SEND, IN_THREAD);

    expect(has(required, Permissions.ViewChannel)).toBe(true);
    expect(has(required, Permissions.SendPolls)).toBe(true);
    expect(has(required, Permissions.SendMessagesInThreads)).toBe(true);
  });

  test('leaves a send outside a thread asking for SendMessages', () => {
    const required = requiredPermissionsFor('send', { channelId: CHANNEL, content: 'hi' });

    expect(has(required, Permissions.SendMessages)).toBe(true);
    expect(has(required, Permissions.SendMessagesInThreads)).toBe(false);
  });

  test('leaves no kind at all asking for SendMessages inside a thread', () => {
    for (const kind of ACTION_KINDS) {
      expect(
        has(requiredPermissionsFor(kind, undefined, IN_THREAD), Permissions.SendMessages),
      ).toBe(false);
    }
  });

  test('changes nothing for a kind that never needed SendMessages', () => {
    for (const kind of ['purge', 'add_reaction', 'pin_message', 'ban'] as const) {
      expect(requiredPermissionsFor(kind, undefined, IN_THREAD)).toBe(requiredPermissionsFor(kind));
    }
  });

  test('only ever changes a kind that resolves a channel in the first place', () => {
    const changed = ACTION_KINDS.filter(
      (kind) => requiredPermissionsFor(kind, undefined, IN_THREAD) !== requiredPermissionsFor(kind),
    );

    expect(changed.every(isChannelScoped)).toBe(true);
  });

  test('still asks only for bits Discord defines', () => {
    for (const kind of ACTION_KINDS) {
      expect(requiredPermissionsFor(kind, undefined, IN_THREAD) & ~ALL_PERMISSIONS).toBe(0n);
    }
  });

  test('substitutes one pair only, because SendMessages is the one bit threads carve out', () => {
    expect(THREAD_PERMISSION_SUBSTITUTIONS).toEqual([
      [Permissions.SendMessages, Permissions.SendMessagesInThreads],
    ]);
  });
});

const PUBLIC_THREAD = { channelId: CHANNEL, name: 'spoilers', type: THREAD_TYPE_PUBLIC };
const PRIVATE_THREAD = { channelId: CHANNEL, name: 'ticket-0007', type: THREAD_TYPE_PRIVATE };
const POLL_SEND = {
  channelId: CHANNEL,
  poll: { question: { text: 'Which map?' }, answers: [{ poll_media: { text: 'Dust' } }] },
};
const OVERWRITE_EDIT = {
  channelId: CHANNEL,
  permissionOverwrites: [{ id: GUILD, type: 0, deny: '1024' }],
};

const PRIVATE_CREATE = {
  name: 'ticket-0007',
  type: 0,
  permissionOverwrites: [{ id: GUILD, type: 0, deny: '1024' }],
};

const PUBLIC_CREATE = { name: 'general', type: 0 };

const EMBED_SEND = { channelId: CHANNEL, embeds: [{ title: 'Rules' }] };

const PAYLOAD_AWARE_CASES: Array<[ActionKind, unknown]> = [
  ['create_thread', PUBLIC_THREAD],
  ['create_thread', PRIVATE_THREAD],
  ['create_thread', { nonsense: true }],
  ['send', POLL_SEND],
  ['send', EMBED_SEND],
  ['send', { channelId: CHANNEL, content: 'hi' }],
  ['edit_channel', OVERWRITE_EDIT],
  ['edit_channel', { channelId: CHANNEL, name: 'general' }],
  ['create_channel', PRIVATE_CREATE],
  ['create_channel', PUBLIC_CREATE],
];

describe('requirements the payload decides', () => {
  test('exactly five kinds read their payload, and no mechanism leaks to the rest', () => {
    expect(Object.keys(PAYLOAD_PERMISSIONS).sort()).toEqual([
      'create_channel',
      'create_thread',
      'edit_channel',
      'send',
      'set_channel_overwrite',
    ]);
  });

  test('granting a bit through a single overwrite asks the bot to hold that bit as well', () => {
    const granted = requiredPermissionsFor('set_channel_overwrite', {
      channelId: CHANNEL,
      overwriteId: CHANNEL,
      type: 1,
      allow: Permissions.AttachFiles.toString(),
      deny: '0',
    });

    expect(has(granted, Permissions.AttachFiles)).toBe(true);
    expect(has(granted, Permissions.ManageRoles)).toBe(true);
  });

  test('a message carrying an embed asks for EmbedLinks', () => {
    expect(has(requiredPermissionsFor('send', EMBED_SEND), Permissions.EmbedLinks)).toBe(true);
  });

  test('a plain message does not ask for EmbedLinks or AttachFiles', () => {
    const required = requiredPermissionsFor('send', { channelId: CHANNEL, content: 'hi' });

    expect(has(required, Permissions.EmbedLinks)).toBe(false);
    expect(has(required, Permissions.AttachFiles)).toBe(false);
  });

  test('a message carrying a file asks for AttachFiles', () => {
    const required = requiredPermissionsFor('send', {
      channelId: CHANNEL,
      files: [{ filename: 'card.png', data: new Uint8Array([1]) }],
    });

    expect(has(required, Permissions.AttachFiles)).toBe(true);
  });

  test('a channel created with overwrites also asks for every bit those overwrites hand out', () => {
    // Discord refuses to let a bot grant a permission it does not hold, so the ticket module's
    // overwrites are part of what create_channel requires.
    const required = requiredPermissionsFor('create_channel', {
      name: 'ticket-1',
      type: 0,
      permissionOverwrites: [
        { id: GUILD, type: 0, deny: Permissions.ViewChannel.toString() },
        {
          id: '100000000000000001',
          type: 1,
          allow: (Permissions.ViewChannel | Permissions.AttachFiles).toString(),
        },
      ],
    });

    expect(has(required, Permissions.AttachFiles)).toBe(true);
    expect(has(required, Permissions.ViewChannel)).toBe(true);
    expect(has(required, Permissions.ManageRoles)).toBe(true);
  });

  test('a deny-only overwrite asks for nothing beyond ManageRoles', () => {
    const required = requiredPermissionsFor('edit_channel', {
      channelId: CHANNEL,
      permissionOverwrites: [{ id: GUILD, type: 0, deny: Permissions.Connect.toString() }],
    });

    expect(has(required, Permissions.ManageRoles)).toBe(true);
    expect(has(required, Permissions.Connect)).toBe(false);
  });

  test('a channel created with overwrites asks for ManageRoles as well as ManageChannels', () => {
    const required = requiredPermissionsFor('create_channel', PRIVATE_CREATE);

    expect(has(required, Permissions.ManageRoles)).toBe(true);
    expect(has(required, Permissions.ManageChannels)).toBe(true);
  });

  test('a channel created without overwrites does not ask for ManageRoles', () => {
    expect(
      has(requiredPermissionsFor('create_channel', PUBLIC_CREATE), Permissions.ManageRoles),
    ).toBe(false);
  });

  test('still asks only for bits Discord defines, and never less than the flat table', () => {
    for (const [kind, payload] of PAYLOAD_AWARE_CASES) {
      const refined = requiredPermissionsFor(kind, payload);

      expect(refined & ~ALL_PERMISSIONS).toBe(0n);
      expect(refined & REQUIRED_PERMISSIONS[kind]).toBe(REQUIRED_PERMISSIONS[kind]);
    }
  });

  test('a public thread asks for CreatePublicThreads and not the disjoint private bit', () => {
    const required = requiredPermissionsFor('create_thread', PUBLIC_THREAD);

    expect(has(required, Permissions.CreatePublicThreads)).toBe(true);
    expect(has(required, Permissions.CreatePrivateThreads)).toBe(false);
  });

  test('a private thread asks for CreatePrivateThreads and not the public bit', () => {
    const required = requiredPermissionsFor('create_thread', PRIVATE_THREAD);

    expect(has(required, Permissions.CreatePrivateThreads)).toBe(true);
    expect(has(required, Permissions.CreatePublicThreads)).toBe(false);
  });

  test('a guild granting public threads but denying private ones can still open a public one', () => {
    const granted = Permissions.ViewChannel | Permissions.CreatePublicThreads;

    expect(has(granted, requiredPermissionsFor('create_thread', PUBLIC_THREAD))).toBe(true);
    expect(has(granted, requiredPermissionsFor('create_thread', PRIVATE_THREAD))).toBe(false);
  });

  test('with no payload to read, create_thread falls back to the private bit', () => {
    expect(has(requiredPermissionsFor('create_thread'), Permissions.CreatePrivateThreads)).toBe(
      true,
    );
  });

  test('a send carrying a poll additionally needs Send Polls, bit 49', () => {
    const required = requiredPermissionsFor('send', POLL_SEND);

    expect(has(required, Permissions.SendPolls)).toBe(true);
    expect(Permissions.SendPolls).toBe(1n << 49n);
  });

  test('a send with no poll on it does not', () => {
    const required = requiredPermissionsFor('send', { channelId: CHANNEL, content: 'hi' });

    expect(has(required, Permissions.SendPolls)).toBe(false);
    expect(required).toBe(REQUIRED_PERMISSIONS.send);
  });

  test('an edit_channel touching overwrites additionally needs Manage Roles', () => {
    const required = requiredPermissionsFor('edit_channel', OVERWRITE_EDIT);

    expect(has(required, Permissions.ManageRoles)).toBe(true);
    expect(has(required, Permissions.ManageChannels)).toBe(true);
  });

  test('an edit_channel that only renames does not', () => {
    const required = requiredPermissionsFor('edit_channel', {
      channelId: CHANNEL,
      name: 'general',
    });

    expect(has(required, Permissions.ManageRoles)).toBe(false);
    expect(required).toBe(Permissions.ManageChannels);
  });
});

describe('audit-log reasons on the channel and poll kinds', () => {
  test.each(CHANNEL_AND_POLL_KINDS)('%s maps a valid payload to a REST call', (kind) => {
    const call = callOf(toRestCall(request(kind, VALID_PAYLOADS[kind])));

    expect(['DELETE', 'PATCH', 'POST', 'PUT']).toContain(call.method);
    expect(call.path.startsWith('/')).toBe(true);
  });

  // end_poll is the exception on purpose: Discord documents no audit-log reason on the expire
  // endpoint, and ending a poll produces no audit entry for one to land on.
  test('carries the reason on every one of them except end_poll', () => {
    for (const kind of CHANNEL_AND_POLL_KINDS) {
      const call = callOf(toRestCall(request(kind, VALID_PAYLOADS[kind], 'raid cleanup')));

      expect(call.headers?.['x-audit-log-reason']).toBe(
        kind === 'end_poll' ? undefined : 'raid%20cleanup',
      );
    }
  });
});

describe('which kinds Discord ranks', () => {
  test('moving a member between voice channels is not ranked', () => {
    expect(targetsMember('move_member')).toBe(true);
    expect(hierarchyApplies('move_member')).toBe(false);
  });

  test('the moderation actions are', () => {
    for (const kind of ['ban', 'kick', 'timeout', 'add_role', 'remove_role'] as const) {
      expect(`${kind}: ${hierarchyApplies(kind)}`).toBe(`${kind}: true`);
    }
  });

  test('a kind that names no member is never ranked', () => {
    expect(hierarchyApplies('create_channel')).toBe(false);
    expect(hierarchyApplies('send')).toBe(false);
  });
});
