import { describe, expect, test } from 'bun:test';
import {
  ACTION_KINDS,
  type ActionKind,
  isDestructive,
  REQUIRED_PERMISSIONS,
  requiredPermissionsFor,
  reversalOf,
  TARGETS_MEMBER,
  targetsMember,
} from '../../src/actions/kinds.ts';
import { toRestCall } from '../../src/actions/rest-mapping.ts';
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
    const result = toRestCall(request('ban', { userId: USER, deleteMessageSeconds: 3600 }));
    if ('error' in result) throw new Error(result.error);

    expect(result.call.method).toBe('PUT');
    expect(result.call.path).toBe(`/guilds/${GUILD}/bans/${USER}`);
    expect(result.call.body).toEqual({ delete_message_seconds: 3600 });
  });

  test('untimeout clears the field rather than setting a past date', () => {
    const result = toRestCall(request('untimeout', { userId: USER }));
    if ('error' in result) throw new Error(result.error);

    expect(result.call.body).toEqual({ communication_disabled_until: null });
  });

  test('a reason becomes Discord’s audit-log header', () => {
    const result = toRestCall(request('kick', { userId: USER }, 'spamming'));
    if ('error' in result) throw new Error(result.error);

    // Without this the server's own audit log shows the bot acting for no
    // stated reason.
    expect(result.call.headers?.['x-audit-log-reason']).toBe('spamming');
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
    const result = toRestCall(
      request('lockdown', {
        channelId: CHANNEL,
        roleId: GUILD,
        previousAllow: '0',
        previousDeny: String(Permissions.AddReactions),
      }),
    );
    if ('error' in result) throw new Error(result.error);

    const body = result.call.body as { deny: string };
    const deny = BigInt(body.deny);

    expect(deny & Permissions.SendMessages).toBe(Permissions.SendMessages);
    expect(deny & Permissions.AddReactions).toBe(Permissions.AddReactions);
  });

  test('unlock restores exactly what lockdown recorded', () => {
    const result = toRestCall(
      request('unlock', {
        channelId: CHANNEL,
        roleId: GUILD,
        restoreAllow: '1024',
        restoreDeny: '64',
      }),
    );
    if ('error' in result) throw new Error(result.error);

    expect(result.call.body).toEqual({ type: 0, allow: '1024', deny: '64' });
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
