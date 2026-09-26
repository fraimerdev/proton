import { describe, expect, test } from 'bun:test';
import type { UnpunishKind } from '../src/punish/config.ts';
import { TIMEOUT_JOB } from '../src/punish/timeouts.ts';
import type { UnpunishRequest } from '../src/punish/types.ts';
import { unpunish } from '../src/punish/unpunish.ts';
import {
  baseGuildState,
  discordError,
  GRANT_ROLE,
  GUILD,
  LEFT_MEMBER,
  MEMBER,
  MODERATOR,
} from './harness.ts';
import { executed, FULL_BOT, kit, moderator, request } from './punish-kit.ts';

const DAY = 86_400_000;

function lift(kind: UnpunishKind, overrides: Partial<UnpunishRequest> = {}): UnpunishRequest {
  return {
    guildId: GUILD,
    kind,
    targetId: MEMBER,
    actor: moderator(),
    origin: { type: 'command' },
    idempotencyRoot: 'evt-lift',
    ...overrides,
  };
}

function lifted(outcome: Awaited<ReturnType<typeof unpunish>>) {
  if (outcome.status !== 'executed')
    throw new Error(`expected executed, got ${JSON.stringify(outcome)}`);
  return outcome;
}

describe('untimeout', () => {
  test('ends the timeout first, then closes its rows, reverts its case and cancels the job', async () => {
    const k = kit();
    const timed = executed(await k.run(request('timeout', { duration: '2h' })));

    const outcome = lifted(
      await unpunish(k.ctx(), k.deps, lift('untimeout', { reason: 'Appeal' })),
    );

    expect(k.h.rest.calls.at(-1)?.body).toEqual({ communication_disabled_until: null });
    expect(k.timeouts.rows.get(timed.caseId ?? '')).toMatchObject({
      closeReason: 'removed',
      closedBy: MODERATOR,
    });
    expect(outcome.revertedCaseIds).toEqual([timed.caseId ?? '']);
    expect((await k.ledger.find(GUILD, timed.caseId ?? ''))?.revertedBy).toBe(MODERATOR);
    expect(k.h.cancelled).toEqual([{ jobId: TIMEOUT_JOB, naturalKey: MEMBER }]);
    expect(outcome.summary).toBe(`<@${MEMBER}> can talk again.`);
  });

  test('only the timeouts it ends, and untracked ones from the last 28 days, are reverted', async () => {
    const k = kit();
    const now = k.h.now();
    k.ledger.seed({
      caseId: 'Kold001',
      guildId: GUILD,
      kind: 'timeout',
      targetId: MEMBER,
      createdAt: now - 60 * DAY,
    });
    k.ledger.seed({
      caseId: 'Kauto01',
      guildId: GUILD,
      kind: 'timeout',
      targetId: MEMBER,
      createdAt: now - DAY,
    });
    const ended = executed(
      await k.run(request('timeout', { duration: '1h', idempotencyRoot: 'evt-0' })),
    );
    await k.timeouts.close(GUILD, [ended.caseId ?? ''], {
      at: new Date(now),
      by: null,
      reason: 'expired',
    });
    const running = executed(await k.run(request('timeout', { duration: '2h' })));

    const outcome = lifted(await unpunish(k.ctx(), k.deps, lift('untimeout')));

    expect(outcome.revertedCaseIds.sort()).toEqual([running.caseId ?? '', 'Kauto01'].sort());
    expect((await k.ledger.find(GUILD, 'Kold001'))?.revertedAt).toBeNull();
    expect((await k.ledger.find(GUILD, ended.caseId ?? ''))?.revertedAt).toBeNull();
  });

  test('a failed untimeout leaves the rows open and the case standing', async () => {
    const k = kit();
    const timed = executed(await k.run(request('timeout', { duration: '2h' })));
    k.h.rest.respond(
      /^PATCH \/guilds\/\d+\/members\//,
      discordError(403, 50013, 'Missing Permissions'),
    );

    const outcome = await unpunish(k.ctx(), k.deps, lift('untimeout'));

    expect(outcome).toMatchObject({ status: 'failed', code: 'discord_403' });
    expect(k.timeouts.rows.get(timed.caseId ?? '')?.closedAt).toBeNull();
    expect((await k.ledger.find(GUILD, timed.caseId ?? ''))?.revertedAt).toBeNull();
    expect(k.h.cancelled).toHaveLength(0);
  });

  test('its lift actions run with their own keys, and the member is told afterwards', async () => {
    const state = baseGuildState(FULL_BOT);
    state.name = 'Proton HQ';
    const k = kit({
      state,
      config: {
        punish: {
          notifications: { onUnpunish: true },
          types: { untimeout: { actions: { addRoleIds: [GRANT_ROLE] } } },
        },
      },
    });

    const outcome = lifted(await unpunish(k.ctx(), k.deps, lift('untimeout')));

    expect(k.h.keysUsed()).toEqual([
      'evt-lift:action',
      'evt-lift:extra:0',
      'evt-lift:dm:open',
      'evt-lift:dm:send',
    ]);
    expect(outcome.dm).toBe('sent');
    expect(k.h.dms()[0]?.message.embeds?.[0]?.title).toBe('Your timeout in Proton HQ has ended');
  });
});

describe('unban', () => {
  test('stamps the open ban cases and cancels their pending automatic unban', async () => {
    const cancelled: string[] = [];
    const k = kit({ deps: { reversals: { cancel: async (key) => void cancelled.push(key) } } });
    const banned = executed(await k.run(request('ban', { duration: '7d' })));

    const outcome = lifted(await unpunish(k.ctx(), k.deps, lift('unban')));

    expect(cancelled).toEqual(['reversal:evt-1:action']);
    expect(outcome.revertedCaseIds).toEqual([banned.caseId ?? '']);
    expect(k.h.rest.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/guilds/${GUILD}/bans/${MEMBER}`,
    });
  });

  test('a new ban supersedes an earlier temporary one, so its automatic unban never fires', async () => {
    const cancelled: string[] = [];
    const k = kit({ deps: { reversals: { cancel: async (key) => void cancelled.push(key) } } });
    const temporary = executed(
      await k.run(request('ban', { targetId: LEFT_MEMBER, duration: '7d' })),
    );

    const permanent = executed(
      await k.run(request('ban', { targetId: LEFT_MEMBER, idempotencyRoot: 'evt-2' })),
    );

    expect(cancelled).toEqual(['reversal:evt-1:action']);
    expect(await k.ledger.find(GUILD, temporary.caseId ?? '')).toMatchObject({
      revertedBy: MODERATOR,
    });
    expect((await k.ledger.find(GUILD, permanent.caseId ?? ''))?.revertedAt).toBeNull();
    expect(permanent.summary).not.toContain('automatic unban');
  });

  test('a replayed ban completes the supersede without touching its own case', async () => {
    const cancelled: string[] = [];
    const k = kit({ deps: { reversals: { cancel: async (key) => void cancelled.push(key) } } });
    k.ledger.seed({
      caseId: 'Ktemp01',
      guildId: GUILD,
      kind: 'ban',
      targetId: MEMBER,
      idempotencyKey: 'evt-0:action',
    });
    k.ledger.seed({
      caseId: 'Kperm01',
      guildId: GUILD,
      kind: 'ban',
      targetId: MEMBER,
      idempotencyKey: 'evt-2:action',
    });

    const again = executed(await k.run(request('ban', { idempotencyRoot: 'evt-2' })));

    expect(again.caseId).toBe('Kperm01');
    expect(cancelled).toEqual(['reversal:evt-0:action']);
    expect((await k.ledger.find(GUILD, 'Kperm01'))?.revertedAt).toBeNull();
    expect(k.h.discordCalls()).toHaveLength(0);
  });

  test('an automatic unban that cannot be cancelled is named in the reply', async () => {
    const k = kit({
      deps: {
        reversals: {
          cancel: async () => {
            throw new Error('redis down');
          },
        },
      },
    });
    const temporary = executed(await k.run(request('ban', { duration: '7d' })));

    const permanent = executed(await k.run(request('ban', { idempotencyRoot: 'evt-2' })));

    expect(permanent.summary).toContain(
      `Couldn't cancel the automatic unban of earlier ban \`${temporary.caseId}\``,
    );
  });

  test('a moderator must give a reason where the server forces one', async () => {
    const k = kit({ config: { punish: { types: { unban: { forceReason: true } } } } });

    expect(await unpunish(k.ctx(), k.deps, lift('unban'))).toMatchObject({
      status: 'refused',
      code: 'reason_required',
    });
  });
});

describe('unwarn', () => {
  test('withdraws the warning named by its case id', async () => {
    const k = kit();
    const warned = executed(await k.run(request('warn')));

    const outcome = lifted(
      await unpunish(k.ctx(), k.deps, lift('unwarn', { caseId: warned.caseId ?? '' })),
    );

    expect(outcome.revertedCaseIds).toEqual([warned.caseId ?? '']);
    expect(k.h.cases().map((entry) => entry.kind)).toEqual(['warn', 'unwarn']);
    expect(k.h.cases()[1]?.payload).toEqual({ userId: MEMBER, caseId: warned.caseId });
  });

  test('a replayed withdrawal reports the earlier case instead of calling it already withdrawn', async () => {
    const k = kit();
    const warned = executed(await k.run(request('warn')));
    const first = lifted(
      await unpunish(k.ctx(), k.deps, lift('unwarn', { caseId: warned.caseId ?? '' })),
    );

    const again = lifted(
      await unpunish(k.ctx(), k.deps, lift('unwarn', { caseId: warned.caseId ?? '' })),
    );

    expect(again.caseId).toBe(first.caseId);
    expect(again.summary).toContain('already went through');
  });

  test('refuses a case that is not a warning, or one already withdrawn', async () => {
    const k = kit();
    const kicked = executed(await k.run(request('kick')));
    const warned = executed(await k.run(request('warn', { idempotencyRoot: 'evt-2' })));

    expect(
      await unpunish(k.ctx(), k.deps, lift('unwarn', { caseId: kicked.caseId ?? '' })),
    ).toMatchObject({ status: 'refused', code: 'case_not_found' });

    lifted(await unpunish(k.ctx(), k.deps, lift('unwarn', { caseId: warned.caseId ?? '' })));
    expect(
      await unpunish(
        k.ctx(),
        k.deps,
        lift('unwarn', { caseId: warned.caseId ?? '', idempotencyRoot: 'evt-lift-2' }),
      ),
    ).toMatchObject({ status: 'refused', code: 'already_reverted' });
  });

  test('without the ledger it refuses and says nothing changed', async () => {
    const k = kit();
    const { ledger: _unbound, ...deps } = k.deps;

    expect(await unpunish(k.ctx(), deps, lift('unwarn', { caseId: 'K7f3M2q' }))).toMatchObject({
      status: 'refused',
      code: 'unbound',
    });
  });
});
