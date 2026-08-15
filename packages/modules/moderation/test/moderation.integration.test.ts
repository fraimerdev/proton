import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import {
  ABOVE_BOT,
  BOT_PERMISSIONS,
  CHANNEL,
  GUILD,
  harness,
  integerOption,
  MEMBER,
  OWNER,
  stringOption,
  userOption,
} from './harness.ts';

/**
 * Moderation end to end, against the real ActionExecutor.
 *
 * No container: the seam is the REST proxy client, which is the only thing
 * faked. Everything the invariants live in — I8's prechecks, I4's dedupe, I12's
 * dry-run — is the production code path.
 *
 * I12 makes destructive kinds dry-run outside production, so tests that assert a
 * real Discord call must say they are production. One test pins the opposite.
 */
const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = 'production';
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
});

describe('/ban', () => {
  test('bans a member, records the case and confirms it', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER), stringOption('reason', 'raiding')]);

    expect(h.discordCalls()).toHaveLength(1);
    expect(h.discordCalls()[0]?.method).toBe('PUT');
    expect(h.discordCalls()[0]?.path).toBe(`/guilds/${GUILD}/bans/${MEMBER}`);
    // The audit-log reason is what makes the server's own log explain itself.
    expect(h.discordCalls()[0]?.headers?.['x-audit-log-reason']).toBe('raiding');
    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('ban');
    expect(h.cases()[0]?.targetId).toBe(MEMBER);
    expect(h.replyContent()).toContain('Banned');
  });

  /**
   * The Gate 0 stub reported `guildOwnerId: ''`, so this ban went through and
   * every test stayed green. It is the first of the two regression guards.
   */
  test('refuses to ban the guild owner, and says why', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', OWNER)]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.cases()).toHaveLength(0);
    expect(h.replyContent()).toContain('server owner');
  });

  /**
   * The second guard: the stub claimed `botHighestRolePosition:
   * MAX_SAFE_INTEGER`, which made every hierarchy check pass.
   */
  test('refuses a member whose top role outranks the bot, and says how to fix it', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', ABOVE_BOT)]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.cases()).toHaveLength(0);
    expect(h.replyContent()).toContain('above or equal to mine');
    // Naming the fix, not just the failure (§1).
    expect(h.replyContent()).toContain('Server Settings');
  });

  test('names the missing permission when the bot cannot ban', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER)], {
      appPermissions: BOT_PERMISSIONS & ~Permissions.BanMembers,
    });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('BanMembers');
    expect(h.replyContent()).toContain(CHANNEL);
  });

  test('a duration makes the ban temporary and schedules the unban', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER), stringOption('duration', '2h')]);

    expect(h.discordCalls()).toHaveLength(1);
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]?.request.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(h.replyContent()).toContain('2h');
    expect(h.replyContent()).toContain('lifts automatically');
  });

  /**
   * The ban happened; the reversal did not. Reporting only the success would
   * leave a "temporary" ban that never lifts and nobody looking for it.
   */
  test('reports a reversal that could not be scheduled', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER), stringOption('duration', '2h')], {
      scheduleReversal: async () => {
        throw new Error('database unavailable');
      },
    });

    expect(h.discordCalls()).toHaveLength(1);
    expect(h.replyContent()).toContain('will not lift on its own');
    expect(h.replyContent()).toContain('database unavailable');
  });

  test('passes the delete window through and defaults it from config', async () => {
    const explicit = harness();
    await explicit.run('ban', [
      userOption('user', MEMBER),
      integerOption('delete_message_days', 7),
    ]);
    expect(explicit.discordCalls()[0]?.body).toEqual({ delete_message_seconds: 604_800 });

    const fromConfig = harness();
    await fromConfig.run('ban', [userOption('user', MEMBER)], {
      config: { defaultBanDeleteDays: 1 },
    });
    expect(fromConfig.discordCalls()[0]?.body).toEqual({ delete_message_seconds: 86_400 });
  });

  test('an unreadable duration is refused before Discord is touched', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER), stringOption('duration', 'a fortnight')]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.cases()).toHaveLength(0);
    expect(h.replyContent()).toContain('not a valid duration');
    expect(h.replyContent()).toContain('30m');
  });

  test('a zero duration is refused rather than banning until this instant', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER), stringOption('duration', '0s')]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('longer than zero');
  });

  /** I12. */
  test('outside production the ban is recorded but never sent to Discord', async () => {
    process.env.NODE_ENV = 'development';
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER)]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.dryRun).toBe(true);
    expect(h.replyContent()).toContain('Dry run');
    // The invoker is told it did not happen — a silent no-op is the bug.
    expect(h.replyContent()).toContain('nothing changed');
  });

  /** I4: the gateway redelivers, and the second delivery must change nothing. */
  test('a redelivered interaction bans once', async () => {
    const h = harness();
    const options = [userOption('user', MEMBER)];

    await h.run('ban', options, { idempotencyKey: 'event-1' });
    await h.run('ban', options, { idempotencyKey: 'event-1' });

    expect(h.discordCalls()).toHaveLength(1);
    expect(h.cases()).toHaveLength(1);
  });
});

describe('/kick', () => {
  test('kicks a member below the bot', async () => {
    const h = harness();

    await h.run('kick', [userOption('user', MEMBER)]);

    expect(h.discordCalls()[0]?.method).toBe('DELETE');
    expect(h.discordCalls()[0]?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}`);
    expect(h.replyContent()).toContain('Kicked');
  });

  test('refuses a member above the bot', async () => {
    const h = harness();

    await h.run('kick', [userOption('user', ABOVE_BOT)]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('above or equal to mine');
  });

  test('names KickMembers when it is missing', async () => {
    const h = harness();

    await h.run('kick', [userOption('user', MEMBER)], {
      appPermissions: BOT_PERMISSIONS & ~Permissions.KickMembers,
    });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('KickMembers');
  });
});

describe('/timeout and /untimeout', () => {
  test('times a member out until a point in the future', async () => {
    const h = harness();

    await h.run('timeout', [userOption('user', MEMBER), stringOption('duration', '30m')]);

    const [call] = h.discordCalls();
    expect(call?.method).toBe('PATCH');
    expect(call?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}`);

    const body = call?.body as { communication_disabled_until: string } | undefined;
    expect(new Date(body?.communication_disabled_until ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(h.replyContent()).toContain('30m');

    // Discord lifts a timeout itself, so nothing may be queued to lift it again.
    expect(h.scheduled).toHaveLength(0);
  });

  test('falls back to the configured default duration', async () => {
    const h = harness();

    await h.run('timeout', [userOption('user', MEMBER)], {
      config: { defaultTimeoutDuration: '15m' },
    });

    expect(h.replyContent()).toContain('15m');
  });

  test('refuses a timeout past the 28 day cap, naming the cap', async () => {
    const h = harness();

    await h.run('timeout', [userOption('user', MEMBER), stringOption('duration', '30d')]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('28 days');
  });

  test('untimeout clears the timeout', async () => {
    const h = harness();

    await h.run('untimeout', [userOption('user', MEMBER)]);

    expect(h.discordCalls()[0]?.body).toEqual({ communication_disabled_until: null });
    expect(h.replyContent()).toContain('can talk again');
  });
});

describe('/unban', () => {
  test('lifts a ban by user id', async () => {
    const h = harness();

    await h.run('unban', [stringOption('user_id', MEMBER)]);

    expect(h.discordCalls()[0]?.method).toBe('DELETE');
    expect(h.discordCalls()[0]?.path).toBe(`/guilds/${GUILD}/bans/${MEMBER}`);
    expect(h.replyContent()).toContain('Unbanned');
  });

  /**
   * A banned user is not a member, so there is no hierarchy to check and the
   * bot's own roles are irrelevant. Refusing here would make every unban fail.
   */
  test('does not apply the hierarchy check to a user who is not a member', async () => {
    const h = harness();

    await h.run('unban', [stringOption('user_id', '400000000000000777')]);

    expect(h.discordCalls()).toHaveLength(1);
  });

  test('explains how to find a user id when the option is not one', async () => {
    const h = harness();

    await h.run('unban', [stringOption('user_id', 'that guy')]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('Developer Mode');
  });
});

describe('/slowmode', () => {
  test('sets the per-user rate limit on the invoking channel', async () => {
    const h = harness();

    await h.run('slowmode', [stringOption('duration', '5m')]);

    expect(h.discordCalls()[0]?.method).toBe('PATCH');
    expect(h.discordCalls()[0]?.path).toBe(`/channels/${CHANNEL}`);
    expect(h.discordCalls()[0]?.body).toEqual({ rate_limit_per_user: 300 });
  });

  test('zero turns slowmode off rather than being refused as a duration', async () => {
    const h = harness();

    await h.run('slowmode', [stringOption('duration', '0s')]);

    expect(h.discordCalls()[0]?.body).toEqual({ rate_limit_per_user: 0 });
    expect(h.replyContent()).toContain('off');
  });

  test('refuses more than the 6 hour cap Discord enforces', async () => {
    const h = harness();

    await h.run('slowmode', [stringOption('duration', '1d')]);

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('6h');
  });

  test('names ManageChannels when it is missing', async () => {
    const h = harness();

    await h.run('slowmode', [stringOption('duration', '5m')], {
      appPermissions: BOT_PERMISSIONS & ~Permissions.ManageChannels,
    });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('ManageChannels');
  });
});

describe('/lockdown and /unlock', () => {
  test('denies SendMessages to everyone in the invoking channel', async () => {
    const h = harness();

    await h.run('lockdown', []);

    const call = h.discordCalls()[0];
    expect(call?.method).toBe('PUT');
    // The @everyone role id is the guild id.
    expect(call?.path).toBe(`/channels/${CHANNEL}/permissions/${GUILD}`);
    expect(call?.body).toEqual({ type: 0, allow: '0', deny: String(Permissions.SendMessages) });
  });

  test('a duration schedules the unlock', async () => {
    const h = harness();

    await h.run('lockdown', [stringOption('duration', '30m')]);

    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]?.request.kind).toBe('lockdown');
    expect(h.replyContent()).toContain('30m');
  });

  test('unlock clears the overwrite', async () => {
    const h = harness();

    await h.run('unlock', []);

    expect(h.discordCalls()[0]?.body).toEqual({ type: 0, allow: '0', deny: '0' });
    expect(h.replyContent()).toContain('Unlocked');
  });

  /** Channel overwrites are governed by MANAGE_ROLES, not MANAGE_CHANNELS. */
  test('names ManageRoles when it is missing', async () => {
    const h = harness();

    await h.run('lockdown', [], {
      appPermissions: BOT_PERMISSIONS & ~Permissions.ManageRoles,
    });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('ManageRoles');
  });
});

describe('module policy', () => {
  test('requireReason refuses an action with no reason and says what to do', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER)], { config: { requireReason: true } });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('reason');
  });

  test('requireReason is satisfied by the reason option', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER), stringOption('reason', 'spam')], {
      config: { requireReason: true },
    });

    expect(h.discordCalls()).toHaveLength(1);
  });

  test('a disabled module answers instead of leaving the interaction hanging', async () => {
    const h = harness();

    await h.run('ban', [userOption('user', MEMBER)], { config: { enabled: false } });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('switched off');
  });

  test('replies are ephemeral unless the guild asks for announcements', async () => {
    const quiet = harness();
    await quiet.run('unlock', []);
    expect(
      (
        quiet.rest.calls.find((c) => c.path.startsWith('/interactions/'))?.body as
          | { data?: { flags?: number } }
          | undefined
      )?.data?.flags,
    ).toBe(64);

    const loud = harness();
    await loud.run('unlock', [], { config: { publicReplies: true } });
    expect(
      (
        loud.rest.calls.find((c) => c.path.startsWith('/interactions/'))?.body as
          | { data?: { flags?: number } }
          | undefined
      )?.data?.flags,
    ).toBeUndefined();
  });

  /**
   * Whatever the outcome, the moderator hears about it. An unanswered
   * interaction shows "This interaction failed" and teaches nobody anything.
   */
  test('every command acknowledges the interaction', async () => {
    for (const [command, options] of [
      ['ban', [userOption('user', ABOVE_BOT)]],
      ['unban', [stringOption('user_id', MEMBER)]],
      ['kick', [userOption('user', MEMBER)]],
      ['timeout', [userOption('user', MEMBER)]],
      ['untimeout', [userOption('user', MEMBER)]],
      ['slowmode', [stringOption('duration', '5s')]],
      ['lockdown', []],
      ['unlock', []],
    ] as const) {
      const h = harness();

      await h.run(command, [...options]);

      expect(h.replyContent()).not.toBeNull();
    }
  });
});
