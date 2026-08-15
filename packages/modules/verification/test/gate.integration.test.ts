import { describe, expect, test } from 'bun:test';
import { verificationDefaultConfig } from '../src/config.ts';
import { handleJoin } from '../src/gate.ts';
import {
  ABOVE_BOT_ROLE,
  EVERYONE_ROLE,
  GATED,
  GUILD,
  harness,
  JOINER,
  joinPayload,
  MODERATOR,
  UNVERIFIED_ROLE,
  VERIFIED_ROLE,
} from './harness.ts';

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe('the join gate (§10.5 — use, don’t rebuild)', () => {
  test('does nothing when the invite already granted the unverified role', async () => {
    // A role-granting invite applies it at the instant of joining, with no bot
    // round trip for a script to race. Re-applying it would be a redundant REST
    // call, and treating "Proton applied it" as the only valid path would make a
    // correctly configured server look broken.
    const h = harness();

    const outcome = await h.join(joinPayload(JOINER, [UNVERIFIED_ROLE]), GATED);

    expect(outcome).toEqual({ action: 'invite_granted', roleId: UNVERIFIED_ROLE });
    expect(h.discordCalls()).toEqual([]);
    expect(h.logs.some((l) => l.message.includes('the invite granted it'))).toBe(true);
  });

  test('falls back to applying the role for a join no invite covered', async () => {
    const h = harness();

    const outcome = await h.join(joinPayload(JOINER, []), GATED);

    expect(outcome).toEqual({ action: 'applied', roleId: UNVERIFIED_ROLE });
    expect(h.discordCalls()).toHaveLength(1);
    expect(h.discordCalls()[0]?.method).toBe('PUT');
    expect(h.rolesOf(JOINER)).toContain(UNVERIFIED_ROLE);
  });

  test('reports an ungated join rather than papering over it when the fallback is off', async () => {
    const h = harness();

    const outcome = await h.join(joinPayload(JOINER, []), {
      ...GATED,
      applyUnverifiedOnJoin: false,
    });

    expect(outcome.action).toBe('ungated');
    expect(h.discordCalls()).toEqual([]);
    // Named loudly: the guild believes its invites gate people and they do not.
    const warning = h.logs.find((l) => l.level === 'warn');
    expect(warning?.message).toContain('NOT gated');
    expect(warning?.message).toContain('Server Settings → Invites');
  });

  test('refuses, loudly, when the unverified role sits above the bot (I8 hierarchy)', async () => {
    const h = harness();

    const outcome = await h.join(joinPayload(JOINER, []), {
      ...GATED,
      unverifiedRoleId: ABOVE_BOT_ROLE,
    });

    expect(outcome.action).toBe('refused');
    expect(h.discordCalls()).toEqual([]);

    const error = h.logs.find((l) => l.level === 'error');
    expect(error?.message).toContain('position 9');
    expect(error?.message).toContain('position 6');
    expect(error?.message).toContain('everyone who joins this server has full access');
  });

  test('leaves bots alone', async () => {
    const h = harness();
    const payload = { ...joinPayload(JOINER, []), user: { id: JOINER, bot: true, avatar: null } };

    const outcome = await h.join(payload, GATED);

    expect(outcome).toEqual({ action: 'ignored', reason: 'the member is a bot' });
    expect(h.discordCalls()).toEqual([]);
  });

  test('does nothing when the module is off, or when no unverified role is set', async () => {
    const h = harness();

    expect((await h.join(joinPayload(JOINER, []), { ...GATED, enabled: false })).action).toBe(
      'ignored',
    );
    expect((await h.join(joinPayload(JOINER, []), { enabled: true })).action).toBe('ignored');
    expect(h.discordCalls()).toEqual([]);
  });

  test('says so instead of silently dropping a join it cannot read', async () => {
    const h = harness();

    const outcome = await h.join({ guild_id: '900000000000000001' }, GATED);

    expect(outcome).toEqual({ action: 'ignored', reason: 'unreadable join payload' });
    expect(h.logs.some((l) => l.level === 'error')).toBe(true);
  });

  test('an unbound port means an ungated member and a named port, never silence', async () => {
    // The manifest as the registry and dashboard load it: no ports bound. A guild
    // that has enabled verification must be told exactly which construction is
    // missing, not left with a gate that quietly opens.
    const logs: string[] = [];
    const outcome = await handleJoin(
      {
        id: 'event-1',
        type: 'member.joined',
        guildId: GUILD,
        occurredAt: 0,
        payload: joinPayload(JOINER, []),
      },
      {
        guildId: GUILD,
        config: { ...verificationDefaultConfig, ...GATED },
        executor: { execute: async () => ({ status: 'executed' }) },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: (message) => logs.push(message),
        },
      },
      {},
    );

    expect(outcome.action).toBe('ungated');
    expect(logs[0]).toContain('guildState');
    expect(logs[0]).toContain('createVerificationModule');
  });
});

describe('/verify', () => {
  test('grants the member role and clears the unverified one', async () => {
    const h = harness();
    h.memberRoles.set(MODERATOR, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));

    await h.run('verify', [], { config: GATED });

    expect(sorted(h.rolesOf(MODERATOR))).toEqual(sorted([EVERYONE_ROLE, VERIFIED_ROLE]));
    expect(h.replyContent()).toContain("You're verified");
  });

  test('grants before it clears, so a failed grant leaves the member where they were', async () => {
    const h = harness();
    h.memberRoles.set(MODERATOR, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));
    h.rest.failures.set(`/guilds/900000000000000001/members/${MODERATOR}/roles/${VERIFIED_ROLE}`, {
      status: 500,
      body: { message: 'Internal Server Error' },
    });

    await h.run('verify', [], { config: GATED });

    // Still gated. The alternative ordering removes the unverified role, fails
    // to grant the member role, and reports success to somebody staring at an
    // empty server.
    expect(sorted(h.rolesOf(MODERATOR))).toEqual(sorted([EVERYONE_ROLE, UNVERIFIED_ROLE]));
    expect(h.replyContent()).toContain('nothing has changed');
  });

  test('refuses when the member role sits above the bot, naming the role and the fix', async () => {
    // The gap core's prechecks do not cover: the target member holds nothing but
    // @everyone, so I8's member-hierarchy check passes comfortably, and Discord
    // would still refuse the grant with a bare 403.
    const h = harness();

    await h.run('verify', [], { config: { ...GATED, verifiedRoleId: ABOVE_BOT_ROLE } });

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('position 9');
    expect(h.replyContent()).toContain('position 6');
    expect(h.replyContent()).toContain("Drag Proton's role above it");
  });

  test('refuses when the unverified role sits above the bot, before touching anything', async () => {
    const h = harness();

    await h.run('verify', [], { config: { ...GATED, unverifiedRoleId: ABOVE_BOT_ROLE } });

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain(ABOVE_BOT_ROLE);
  });

  test('says what is unfinished when neither role is configured', async () => {
    const h = harness();

    await h.run('verify', [], { config: { enabled: true } });

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain("hasn't finished setting up verification");
  });

  test('answers even when verification is switched off', async () => {
    const h = harness();

    await h.run('verify', [], { config: { enabled: false } });

    expect(h.replyContent()).toContain('switched off');
  });
});
