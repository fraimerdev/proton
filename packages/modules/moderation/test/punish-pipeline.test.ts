import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import { punish } from '../src/punish/pipeline.ts';
import {
  ABOVE_BOT,
  baseGuildState,
  CHANNEL,
  GUILD,
  LEFT_MEMBER,
  LOW_ROLE,
  MEMBER,
  MESSAGE,
  MOD_ROLE,
  MODERATOR,
  OWNER,
} from './harness.ts';
import { automation, callsTo, executed, FULL_BOT, kit, moderator, request } from './punish-kit.ts';

const PEER = '400000000000000009';

const PROOF = {
  channelId: CHANNEL,
  messageId: MESSAGE,
  authorId: MEMBER,
  content: 'join my server discord.gg/scam',
  createdAt: null,
  attachments: [],
  url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
};

function auditHeader(k: ReturnType<typeof kit>, pattern: RegExp): string | null {
  const call = k.h.rest.calls.find((entry) => pattern.test(`${entry.method} ${entry.path}`));
  const header = call?.headers?.['x-audit-log-reason'];
  return header === undefined ? null : decodeURIComponent(header);
}

describe('immunity (I10)', () => {
  test('without hierarchy, a moderator is refused on a member holding an immune role', async () => {
    const k = kit({ config: { punish: { immunity: { warn: [LOW_ROLE] } } } });

    const outcome = await k.run(request('warn'));

    expect(outcome).toEqual({
      status: 'refused',
      code: 'immune_role',
      message: expect.stringContaining(`<@&${LOW_ROLE}>`),
    });
    expect(k.h.cases()).toHaveLength(0);
  });

  test('the global list covers every kind, and a kind list covers only its own kind', async () => {
    const global = kit({ config: { punish: { immunity: { global: [LOW_ROLE] } } } });
    expect((await global.run(request('kick'))).status).toBe('refused');

    const other = kit({ config: { punish: { immunity: { ban: [LOW_ROLE] } } } });
    expect((await other.run(request('kick'))).status).toBe('executed');
  });

  test('with hierarchy on, the role lists stop applying to a moderator who outranks the member', async () => {
    const k = kit({
      config: { punish: { immunity: { useHierarchy: true, global: [LOW_ROLE] } } },
    });

    expect((await k.run(request('warn'))).status).toBe('executed');
  });

  test('with hierarchy on, a member ranked at or above the moderator is refused', async () => {
    const k = kit({ config: { punish: { immunity: { useHierarchy: true } } } });
    k.lookups.set(PEER, {
      state: 'member',
      roleIds: [MOD_ROLE],
      timeoutUntil: null,
      joinedAt: null,
    });

    const outcome = await k.run(request('timeout', { targetId: PEER }));

    expect(outcome).toEqual({
      status: 'refused',
      code: 'hierarchy',
      message: expect.stringContaining('Moderation → Immunity'),
    });
    expect(k.h.discordCalls()).toHaveLength(0);
  });

  test('the owner is exempt from the hierarchy rule', async () => {
    const k = kit({ config: { punish: { immunity: { useHierarchy: true } } } });
    k.lookups.set(PEER, {
      state: 'member',
      roleIds: [MOD_ROLE],
      timeoutUntil: null,
      joinedAt: null,
    });

    const outcome = await k.run(
      request('timeout', { targetId: PEER, actor: moderator({ id: OWNER, roleIds: [] }) }),
    );

    expect(outcome.status).toBe('executed');
  });

  test('automation always respects the role lists, even with hierarchy on', async () => {
    const k = kit({
      config: { punish: { immunity: { useHierarchy: true, timeout: [LOW_ROLE] } } },
    });

    const outcome = await k.run(request('timeout', { actor: automation() }));

    expect(outcome).toMatchObject({ status: 'refused', code: 'immune_role' });
  });

  test('hierarchy never applies to automation', async () => {
    const k = kit({ config: { punish: { immunity: { useHierarchy: true } } } });
    k.lookups.set(PEER, {
      state: 'member',
      roleIds: [MOD_ROLE],
      timeoutUntil: null,
      joinedAt: null,
    });

    const outcome = await k.run(request('timeout', { targetId: PEER, actor: automation() }));

    expect(outcome.status).toBe('executed');
  });
});

describe('member lookup (B1, B2)', () => {
  test('an unavailable lookup refuses and names what Discord answered', async () => {
    const k = kit();
    k.lookups.set(MEMBER, { state: 'unavailable', status: 503 });

    const outcome = await k.run(request('ban'));

    expect(outcome).toEqual({
      status: 'refused',
      code: 'lookup_unavailable',
      message: `I couldn't look up <@${MEMBER}> right now (Discord answered 503), so nothing was done. Try again.`,
    });
    expect(k.h.discordCalls()).toHaveLength(0);
  });

  test('an unavailable lookup is never read as immune-free: nothing is tried at all', async () => {
    const k = kit({ config: { punish: { immunity: { ban: [LOW_ROLE] } } } });
    k.lookups.set(MEMBER, { state: 'unavailable', status: 500 });

    expect((await k.run(request('ban'))).status).toBe('refused');
    expect(k.h.requests).toHaveLength(0);
  });

  test('no lookup bound refuses with a named reason instead of guessing', async () => {
    const k = kit();
    const { lookupMember: _unbound, ...deps } = k.deps;

    const outcome = await punish(k.ctx(), deps, request('warn'));

    expect(outcome).toMatchObject({ status: 'refused', code: 'unbound' });
  });

  test('a ban of someone who left goes through without a hierarchy check (hackban)', async () => {
    const k = kit({ config: { punish: { immunity: { useHierarchy: true } } } });

    const outcome = executed(
      await k.run(request('ban', { targetId: LEFT_MEMBER, reason: 'Raider' })),
    );

    expect(callsTo(k.h, /^PUT \/guilds\/\d+\/bans\//)).toEqual([
      `PUT /guilds/${GUILD}/bans/${LEFT_MEMBER}`,
    ]);
    expect(outcome.caseId).not.toBeNull();
    expect(outcome.summary).toContain("wasn't in the server");
  });

  test('kick, timeout and warn of someone who left are refused', async () => {
    for (const kind of ['kick', 'timeout', 'warn'] as const) {
      const k = kit();
      const outcome = await k.run(request(kind, { targetId: LEFT_MEMBER }));

      expect(outcome).toEqual({
        status: 'refused',
        code: 'not_member',
        message: expect.stringContaining(`<@${LEFT_MEMBER}> isn't in the server`),
      });
    }
  });
});

describe('authorization for report and message punishments (C1, C2)', () => {
  test('a moderator without Ban Members cannot ban from a report', async () => {
    const k = kit();
    const actor = moderator({ permissions: Permissions.ModerateMembers });

    const outcome = await k.run(
      request('ban', { actor, origin: { type: 'report', reportId: 'Xk3P9aQ' } }),
    );

    expect(outcome).toEqual({
      status: 'refused',
      code: 'missing_permission',
      message: expect.stringContaining('Ban Members'),
    });
    expect(k.h.requests).toHaveLength(0);
  });

  test('Administrator and the owner pass the per-kind check', async () => {
    const admin = kit();
    const actor = moderator({ permissions: Permissions.Administrator });
    expect((await admin.run(request('kick', { actor, origin: { type: 'message' } }))).status).toBe(
      'executed',
    );

    const owner = kit();
    const ownerActor = moderator({ id: OWNER, roleIds: [], permissions: 0n });
    expect(
      (await owner.run(request('kick', { actor: ownerActor, origin: { type: 'message' } }))).status,
    ).toBe('executed');
  });

  test('a slash command is not re-checked: Discord gated it by its default permissions', async () => {
    const k = kit();
    const actor = moderator({ permissions: 0n });

    expect((await k.run(request('warn', { actor }))).status).toBe('executed');
  });

  test('deleting the proof needs Manage Messages in the source channel', async () => {
    const k = kit();

    const outcome = await k.run(
      request('warn', { origin: { type: 'message' }, proof: PROOF, deleteProof: true }),
    );

    expect(outcome).toEqual({
      status: 'refused',
      code: 'proof_permission',
      message: expect.stringContaining(`Manage Messages in <#${CHANNEL}>`),
    });
    expect(k.h.requests).toHaveLength(0);
  });

  test('a channel overwrite granting Manage Messages is enough', async () => {
    const state = baseGuildState(FULL_BOT);
    state.channels.set(CHANNEL, {
      id: CHANNEL,
      parentId: null,
      overwrites: [{ id: MOD_ROLE, type: 0, allow: Permissions.ManageMessages, deny: 0n }],
    });
    const k = kit({ state });

    const outcome = executed(
      await k.run(
        request('warn', { origin: { type: 'message' }, proof: PROOF, deleteProof: true }),
      ),
    );

    expect(outcome.proofDeleted).toBe(true);
  });

  test('keeping the proof needs no Manage Messages', async () => {
    const k = kit({ config: { punish: { types: { warn: { deleteProof: true } } } } });

    const outcome = executed(
      await k.run(
        request('warn', { origin: { type: 'message' }, proof: PROOF, deleteProof: false }),
      ),
    );

    expect(outcome.proofDeleted).toBeNull();
  });

  test('the permissions module gate refuses with its own message', async () => {
    const k = kit();
    k.gate.result = { allowed: false, message: 'You may not use /ban in this server.' };

    const outcome = await k.run(
      request('ban', { origin: { type: 'report', reportId: 'Xk3P9aQ' } }),
    );

    expect(outcome).toEqual({
      status: 'refused',
      code: 'command_gated',
      message: 'You may not use /ban in this server.',
    });
    expect(k.gate.asked).toEqual([{ command: 'ban', roleIds: [MOD_ROLE] }]);
  });

  test('automation and slash commands never ask the gate', async () => {
    const k = kit();
    k.gate.result = { allowed: false, message: 'gated' };

    expect((await k.run(request('warn', { actor: automation() }))).status).toBe('executed');
    expect((await k.run(request('warn', { idempotencyRoot: 'evt-2' }))).status).toBe('executed');
    expect(k.gate.asked).toHaveLength(0);
  });
});

describe('recent-case confirmation', () => {
  const CONFIRM = { punish: { confirmRecentCase: { enabled: true, window: '10m' } } };

  test('a second punishment inside the window asks first, naming the earlier case', async () => {
    const k = kit({ config: CONFIRM });
    const first = executed(await k.run(request('timeout', { idempotencyRoot: 'evt-1' })));

    const second = await k.run(request('timeout', { idempotencyRoot: 'evt-2' }));

    expect(second).toEqual({
      status: 'needs_confirmation',
      code: 'recent_case',
      recentCaseId: first.caseId ?? '',
      message: expect.stringContaining(`case \`${first.caseId}\``),
    });

    const confirmed = await k.run(
      request('timeout', { idempotencyRoot: 'evt-2', confirmedRecentCase: true }),
    );
    expect(confirmed.status).toBe('executed');
  });

  test('outside the window, or a different kind, nothing is asked', async () => {
    const k = kit({ config: CONFIRM });
    await k.run(request('warn', { idempotencyRoot: 'evt-1' }));

    expect((await k.run(request('kick', { idempotencyRoot: 'evt-2' }))).status).toBe('executed');

    k.h.advance(11 * 60_000);
    expect((await k.run(request('warn', { idempotencyRoot: 'evt-3' }))).status).toBe('executed');
  });

  test('automation is asked too, so it can record the skip', async () => {
    const k = kit({ config: CONFIRM });
    await k.run(request('warn', { idempotencyRoot: 'evt-1' }));

    const outcome = await k.run(request('warn', { idempotencyRoot: 'evt-2', actor: automation() }));

    expect(outcome.status).toBe('needs_confirmation');
  });
});

describe('replays (D1, D2)', () => {
  test('the main action is keyed on the root, and a replay reuses the case without calling Discord', async () => {
    const k = kit();

    const first = executed(
      await k.run(request('ban', { idempotencyRoot: 'moderation:report:R1:accept' })),
    );
    const again = executed(
      await k.run(request('ban', { idempotencyRoot: 'moderation:report:R1:accept' })),
    );

    expect(k.h.keysUsed()).toContain('moderation:report:R1:accept:action');
    expect(again.caseId).toBe(first.caseId);
    expect(again.summary).toContain('already went through');
    expect(callsTo(k.h, /^PUT \/guilds\/\d+\/bans\//)).toHaveLength(1);
  });

  test('a replay of a kick is found before the lookup, which no longer finds the member', async () => {
    const k = kit();
    const first = executed(await k.run(request('kick')));
    k.lookups.set(MEMBER, { state: 'absent' });

    const again = executed(await k.run(request('kick')));

    expect(again.caseId).toBe(first.caseId);
  });

  test('a replay is never mistaken for a recent case needing confirmation', async () => {
    const k = kit({ config: { punish: { confirmRecentCase: { enabled: true } } } });
    const first = executed(await k.run(request('warn')));

    const again = await k.run(request('warn'));

    expect(again).toMatchObject({ status: 'executed', caseId: first.caseId });
    expect(k.h.cases()).toHaveLength(1);
  });

  test('a duplicate with no case yet is reported as still in progress, never as done', async () => {
    const k = kit();
    const { ledger: _ledger, ...deps } = k.deps;

    await punish(k.ctx(), deps, request('kick'));
    const again = await punish(k.ctx(), deps, request('kick'));

    expect(again).toEqual({
      status: 'duplicate',
      message: 'That punishment is still being carried out. Check again in a moment.',
    });
  });

  test('a request for another guild is refused', async () => {
    const k = kit();

    const outcome = await k.run(request('warn', { guildId: '900000000000000002' }));

    expect(outcome).toMatchObject({ status: 'refused', code: 'wrong_guild' });
  });
});

describe('what reaches Discord', () => {
  test('the audit-log reason is rendered from the template, apart from the case reason', async () => {
    const env: PlaceholderEnvironment = {
      applicationId: '300000000000000001',
      bot: async () => ({ id: '300000000000000001', supportUrl: 'https://prtn.xyz/support' }),
      server: async (guildId) => ({ id: guildId, name: 'Proton HQ' }),
      user: async (userId) => ({
        id: userId,
        username: 'kestrel',
        globalName: 'Kestrel',
        avatarHash: null,
      }),
      now: () => Date.now(),
    };
    const k = kit({
      config: {
        punish: {
          types: {
            ban: { auditReason: '{moderator.username} ({moderator.id}): {punishment.reason}' },
          },
        },
      },
      deps: { placeholders: env },
    });

    await k.run(request('ban', { reason: 'Spamming' }));

    expect(auditHeader(k, /^PUT \/guilds\/\d+\/bans\//)).toBe(`kestrel (${MODERATOR}): Spamming`);
    expect(k.h.cases()[0]?.reason).toBe('Spamming');
  });

  test('the default audit-log reason is the reason itself, as before', async () => {
    const k = kit();

    await k.run(request('kick', { reason: 'Spamming' }));
    await k.run(request('timeout', { idempotencyRoot: 'evt-2' }));

    expect(auditHeader(k, /^DELETE \/guilds\/\d+\/members\//)).toBe('Spamming');
    expect(auditHeader(k, /^PATCH \/guilds\/\d+\/members\//)).toBe('No reason given');
  });

  test('a temporary ban deletes the chosen days of messages and books its reversal', async () => {
    const k = kit({ config: { punish: { types: { ban: { deleteMessageDays: 2 } } } } });

    const outcome = executed(await k.run(request('ban', { duration: '7d' })));

    const call = k.h.rest.calls.find((entry) => entry.method === 'PUT');
    expect(call?.body).toEqual({ delete_message_seconds: 2 * 86_400 });
    expect(k.h.scheduled).toHaveLength(1);
    expect(outcome.expiresAt).toBe(k.h.now() + 7 * 86_400_000);
    expect(outcome.summary).toContain('The ban lifts automatically');
  });

  test('the default ban length applies when the moderator gives none', async () => {
    const k = kit({ config: { punish: { types: { ban: { defaultDuration: '3d' } } } } });

    executed(await k.run(request('ban')));
    executed(
      await k.run(request('ban', { idempotencyRoot: 'evt-2', targetId: PEER, duration: null })),
    );

    expect(k.h.scheduled).toHaveLength(1);
  });

  test('a warning announces moderation.warned for escalation, keyed on the root', async () => {
    const k = kit();

    await k.run(request('warn', { channelId: CHANNEL }));
    await k.run(request('warn', { idempotencyRoot: 'evt-2' }));

    expect(k.h.published).toEqual([
      {
        type: 'moderation.warned',
        naturalKey: 'evt-1:warn',
        payload: { userId: MEMBER, channelId: CHANNEL },
      },
      { type: 'moderation.warned', naturalKey: 'evt-2:warn', payload: { userId: MEMBER } },
    ]);
  });

  test('a member ranked above Proton fails at the executor and is reported as failed', async () => {
    const k = kit();

    const outcome = await k.run(request('kick', { targetId: ABOVE_BOT }));

    expect(outcome).toMatchObject({ status: 'failed', code: 'role_hierarchy' });
  });
});
