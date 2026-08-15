import { describe, expect, test } from 'bun:test';
import {
  ACTION_KINDS,
  type ActionKind,
  DESTRUCTIVE_KINDS,
  dryRunFor,
  isDestructive,
  REQUIRED_PERMISSIONS,
  requiredPermissionsFor,
  reversalOf,
  TARGETS_MEMBER,
  targetsMember,
} from '../../src/actions/kinds.ts';
import { type PayloadResult, type RestCall, toRestCall } from '../../src/actions/rest-mapping.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';
const CHANNEL = '500000000000000001';

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

/**
 * Narrow a mapping result to the REST call it produced, failing the test with
 * the actual reason otherwise.
 *
 * `PayloadResult` grew a third arm when `warn` arrived — a kind that validates
 * and then deliberately produces no call — so `if ('error' in result)` no longer
 * narrows all the way to `{ call }`.
 */
function callOf(result: PayloadResult): RestCall {
  if ('error' in result) throw new Error(result.error);
  if ('ledgerOnly' in result) throw new Error('expected a REST call, got a ledger-only kind');
  return result.call;
}

/**
 * These are the guards that make widening ActionKind safe. Every kind must
 * declare a permission, a targeting stance, and a REST mapping — a kind missing
 * any of them would ship as a command that either never precheck-fails or fails
 * at Discord with a bare 403.
 */
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
    // A common and confusing Discord detail: editing a channel's permission
    // overwrites is governed by MANAGE_ROLES.
    expect(requiredPermissionsFor('lockdown')).toBe(Permissions.ManageRoles);
    expect(requiredPermissionsFor('unlock')).toBe(Permissions.ManageRoles);
  });

  test('purge needs history access as well as MANAGE_MESSAGES', () => {
    expect(requiredPermissionsFor('purge')).toBe(
      Permissions.ManageMessages | Permissions.ReadMessageHistory,
    );
  });

  /**
   * Discord always permits an app to answer its own interaction. Requiring
   * SendMessages would refuse legitimate replies — including the reply that
   * explains why some other action was refused.
   */
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

  /**
   * A banned user is not a member: no roles, no hierarchy. Marking unban as
   * member-targeting would make every unban fail closed on an unresolvable
   * member — you could ban someone and never get them back.
   */
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

    // Without this the server's own audit log shows the bot acting for no
    // stated reason.
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

  /**
   * R4: unlock can only restore faithfully because lockdown recorded what it
   * replaced. Lockdown also ORs its deny onto the existing one rather than
   * overwriting, so it cannot silently clear unrelated restrictions.
   */
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

  /**
   * The one kind that validates and then deliberately produces no call. Asserted
   * because the alternative failure — a `warn` that quietly mapped to some
   * endpoint — would ban or kick somebody.
   */
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
    expect(result.error).toContain('content, an embed, a component or a file');
  });

  /**
   * The multipart contract: part `files[0]` is described by the descriptor with
   * `id: 0`, and an embed refers to it by filename. Out of step, the bytes upload
   * and the embed renders a broken image.
   */
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

  test('destructive kinds are flagged for the I12 dry-run default', () => {
    expect(isDestructive('ban')).toBe(true);
    expect(isDestructive('purge')).toBe(true);
    expect(isDestructive('send')).toBe(false);
  });
});

/**
 * I12 as a single rule rather than one per module.
 *
 * Six modules had copied these three lines by the end of Phase 2 (I3 forbids
 * importing across modules, so each had to). They agreed, but only by luck —
 * nothing made them agree, and the point of I12 is that it is uniform. Pinned
 * here so the next module inherits the policy instead of retyping it.
 */
describe('dryRunFor', () => {
  test('withholds destructive kinds outside production', () => {
    expect(dryRunFor('ban', 'development')).toBe(true);
    expect(dryRunFor('kick', 'test')).toBe(true);
    expect(dryRunFor('purge', undefined)).toBe(true);
  });

  test('performs destructive kinds in production', () => {
    expect(dryRunFor('ban', 'production')).toBe(false);
    expect(dryRunFor('lockdown', 'production')).toBe(false);
  });

  /**
   * The half that matters to anti-nuke and verification: a role strip and a
   * quarantine run for real in development. Withholding them would leave the
   * reversible, restore-exactness half of both modules untested everywhere it
   * is safe to test.
   */
  test('never withholds a non-destructive kind, whatever the environment', () => {
    for (const env of ['development', 'test', 'production', undefined]) {
      expect(dryRunFor('remove_role', env)).toBe(false);
      expect(dryRunFor('add_role', env)).toBe(false);
      expect(dryRunFor('timeout', env)).toBe(false);
    }
  });

  test('covers exactly DESTRUCTIVE_KINDS, so a new destructive kind is caught here', () => {
    const withheld = ACTION_KINDS.filter((kind) => dryRunFor(kind, 'development'));

    expect(new Set(withheld)).toEqual(new Set(DESTRUCTIVE_KINDS));
  });
});
