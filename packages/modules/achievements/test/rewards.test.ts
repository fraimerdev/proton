import { describe, expect, test } from 'bun:test';
import type { AchievementRetryOutcome } from '@proton/core';
import type { AchievementInput } from '../src/config.ts';
import { MAX_REWARD_ATTEMPTS, XP_CONFIRM_TIMEOUT_MS } from '../src/constants.ts';
import { handleRetryRequest, handleXpGranted, processRecords } from '../src/engine.ts';
import { createScheduledHandlers } from '../src/jobs.ts';
import {
  levelingOffReason,
  RANKED_TARGET,
  ROLE_UNCONFIRMED,
  retryReward,
  XP_UNCONFIRMED,
} from '../src/rewards.ts';
import { CANCELLED_BY_RESET, xpGrantId } from '../src/store.ts';
import { ACTOR, audit, CHANNEL, GUILD, ROLE, T0, USER } from './contracts.ts';
import { event, failure, guildState, harness, ROLE_2, subjects } from './fakes.ts';

const LADDER: AchievementInput = {
  id: 'ladder',
  name: 'Ladder',
  kind: 'tiered',
  status: 'active',
  requirements: [{ id: 'xp', trigger: 'leveling.activity_xp' }],
  tiers: [
    { id: 'bronze', targets: { xp: 10 }, rewards: [{ kind: 'add_role', roleId: ROLE }] },
    {
      id: 'silver',
      targets: { xp: 50 },
      rewards: [
        { kind: 'remove_role', roleId: ROLE },
        { kind: 'add_role', roleId: ROLE_2 },
      ],
    },
  ],
};

const GIFTED: AchievementInput = {
  id: 'gifted',
  name: 'Gifted',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'messages', trigger: 'messages.sent' }],
  tiers: [
    { id: 'single', targets: { messages: 1 }, rewards: [{ kind: 'add_role', roleId: ROLE }] },
  ],
};

const GENEROUS: AchievementInput = {
  ...GIFTED,
  id: 'generous',
  name: 'Generous',
  tiers: [{ id: 'single', targets: { messages: 1 }, rewards: [{ kind: 'xp', amount: 250 }] }],
};

const SUMMARY_MESSAGE = {
  content: '{user.mention} earned {achievement.name}: {rewards.summary}',
  embeds: [],
  components: [],
  mentions: { everyone: false, roles: false, users: true },
  v2: [],
};

type Harness = ReturnType<typeof harness>;

function xpRecord(h: Harness, index: number, amount: number) {
  return h.message(index, {
    metric: 'activity_xp',
    sourceKey: `xp-${index}`,
    amount,
    xpSource: 'message',
    sourceModule: 'leveling',
  });
}

async function run(h: Harness, records: ReturnType<Harness['message']>[]): Promise<void> {
  await processRecords(h.ctx, h.deps, { records, subjects: subjects(), originChannelId: CHANNEL });
}

function sweep(h: Harness): Promise<void> {
  return createScheduledHandlers(h.deps).sweep({}, h.ctx);
}

function contentOf(h: Harness): string {
  const [send] = h.executor.of('send');
  return (send?.payload as { content?: string } | undefined)?.content ?? '';
}

function roleCalls(h: Harness): string[] {
  return h.executor.requests
    .filter(({ kind }) => kind === 'add_role' || kind === 'remove_role')
    .map(({ kind, payload }) => `${kind}:${(payload as { roleId: string }).roleId}`);
}

describe('role rewards', () => {
  test('a higher tier’s role change replaces a lower tier’s in the same unlock', async () => {
    const h = harness({ achievements: [LADDER] });
    await run(h, [xpRecord(h, 1, 60)]);

    expect(roleCalls(h)).toEqual([`remove_role:${ROLE}`, `add_role:${ROLE_2}`]);

    const rewards = await h.store.rewardsFor(GUILD, USER, 'ladder', 0);
    expect(
      rewards.map(({ tierId, rewardKey, status, error }) => [tierId, rewardKey, status, error]),
    ).toEqual([
      ['bronze', `add_role:${ROLE}`, 'skipped', 'Replaced by Silver’s reward.'],
      ['silver', `add_role:${ROLE_2}`, 'delivered', null],
      ['silver', `remove_role:${ROLE}`, 'delivered', null],
    ]);
  });

  test('a retried lower-tier role never undoes what a higher tier did since', async () => {
    const h = harness({ achievements: [LADDER] });
    h.executor.on(
      ({ kind, idempotencyKey }) => kind === 'add_role' && idempotencyKey.includes(':bronze:'),
      failure('discord_503', 'Discord had a problem.'),
      1,
    );

    await run(h, [xpRecord(h, 1, 20)]);
    const [bronze] = await h.store.rewardsFor(GUILD, USER, 'ladder', 0);
    expect(bronze).toMatchObject({ status: 'failed', transient: true, nextAttemptAt: T0 + 30_000 });

    await run(h, [xpRecord(h, 2, 40)]);
    h.advance(31_000);
    await sweep(h);

    expect(roleCalls(h)).toEqual([`add_role:${ROLE}`, `remove_role:${ROLE}`, `add_role:${ROLE_2}`]);
    const rewards = await h.store.rewardsFor(GUILD, USER, 'ladder', 0);
    expect(rewards.find(({ tierId }) => tierId === 'bronze')).toMatchObject({
      status: 'skipped',
      error: 'Replaced by Silver’s reward.',
    });
  });

  test('a transient failure waits for its backoff and the next try uses a new key', async () => {
    const h = harness({ achievements: [GIFTED] });
    h.executor.on(({ kind }) => kind === 'add_role', failure('discord_429', 'Slow down.'), 2);

    await run(h, [h.message(1)]);
    let [row] = await h.store.rewardsFor(GUILD, USER, 'gifted', 0);
    expect(row).toMatchObject({
      status: 'failed',
      transient: true,
      errorCode: 'discord_429',
      nextAttemptAt: T0 + 30_000,
    });
    expect(h.executor.of('send')).toEqual([]);

    h.advance(10_000);
    await sweep(h);
    expect(h.executor.of('add_role')).toHaveLength(1);

    h.advance(21_000);
    await sweep(h);
    [row] = await h.store.rewardsFor(GUILD, USER, 'gifted', 0);
    expect(row).toMatchObject({ attempts: 2, nextAttemptAt: T0 + 31_000 + 120_000 });

    h.advance(121_000);
    await sweep(h);
    [row] = await h.store.rewardsFor(GUILD, USER, 'gifted', 0);
    expect(row?.status).toBe('delivered');
    expect(
      h.executor.of('add_role').map(({ idempotencyKey }) => idempotencyKey.split(':').at(-1)),
    ).toEqual(['1', '2', '3']);

    h.advance(31_000);
    await sweep(h);
    expect(h.executor.of('send')).toHaveLength(1);
  });

  test('the owner and higher-ranked members get Proton’s own wording', async () => {
    for (const refusal of [
      failure(
        'target_is_owner',
        "I can't perform this action on the server owner — Discord forbids it.",
      ),
      failure(
        'role_hierarchy',
        "That member's highest role is above or equal to mine, so I can't act on them.",
      ),
    ]) {
      const h = harness({ achievements: [GIFTED] });
      h.executor.on(({ kind }) => kind === 'add_role', refusal);
      await run(h, [h.message(1)]);

      const [row] = await h.store.rewardsFor(GUILD, USER, 'gifted', 0);
      expect(row).toMatchObject({ status: 'failed', transient: false, error: RANKED_TARGET });
    }
  });

  test('a missing permission fails with the executor’s reason and completion stands', async () => {
    const h = harness({ achievements: [GIFTED] });
    h.executor.on(
      ({ kind }) => kind === 'add_role',
      failure('missing_permission', "I'm missing the Manage Roles permission in this server."),
    );
    await run(h, [h.message(1)]);

    const [row] = await h.store.rewardsFor(GUILD, USER, 'gifted', 0);
    expect(row).toMatchObject({
      status: 'failed',
      transient: false,
      error: "I'm missing the Manage Roles permission in this server.",
    });
    expect(await h.store.unlocksOf(GUILD, USER)).toHaveLength(1);
    expect(h.executor.of('send')).toHaveLength(1);
  });

  test('a managed role or @everyone is refused locally without calling Discord', async () => {
    const state = guildState();
    state.roles.set(ROLE, { id: ROLE, permissions: 0n, position: 2, managed: true });

    const h = harness({ achievements: [GIFTED] }, { guildState: { get: async () => state } });
    await run(h, [h.message(1)]);

    expect(roleCalls(h)).toEqual([]);
    const [row] = await h.store.rewardsFor(GUILD, USER, 'gifted', 0);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'managed' });
    expect(row?.error).toContain('Proton can’t give this role: it is managed by Discord');
    expect(row?.error).not.toContain('<@&');
  });

  test('a duplicate claim is confirmed against the member’s roles', async () => {
    const present = harness(
      { achievements: [GIFTED] },
      {
        memberFacts: async () => ({
          roleIds: [ROLE],
          bot: false,
          joinedAt: null,
          premiumSince: null,
        }),
      },
    );
    present.executor.on(({ kind }) => kind === 'add_role', { status: 'skipped_duplicate' });
    await run(present, [present.message(1)]);
    expect((await present.store.rewardsFor(GUILD, USER, 'gifted', 0))[0]?.status).toBe('delivered');

    const absent = harness(
      { achievements: [GIFTED] },
      {
        memberFacts: async () => ({ roleIds: [], bot: false, joinedAt: null, premiumSince: null }),
      },
    );
    absent.executor.on(({ kind }) => kind === 'add_role', { status: 'skipped_duplicate' });
    await run(absent, [absent.message(1)]);
    expect((await absent.store.rewardsFor(GUILD, USER, 'gifted', 0))[0]).toMatchObject({
      status: 'failed',
      transient: true,
      error: ROLE_UNCONFIRMED,
    });
  });
});

describe('XP rewards', () => {
  test('asks Leveling, waits for the answer, then announces it as given', async () => {
    const h = harness({
      announcement: { message: SUMMARY_MESSAGE },
      achievements: [GENEROUS],
    });
    await run(h, [h.message(1)]);

    const grantId = xpGrantId(GUILD, USER, 'generous', 'single', 0);
    const request = h.published.find(({ type }) => type === 'xp.grant_requested');
    expect(request).toMatchObject({
      key: grantId,
      payload: {
        guildId: GUILD,
        userId: USER,
        grantId,
        amount: 250,
        reason: 'Earned Generous.',
        sourceModule: 'achievements',
        originChannelId: CHANNEL,
        causation: { kind: 'achievement', depth: 0, grantId, sourceModule: 'achievements' },
      },
    });
    expect((await h.store.rewardsFor(GUILD, USER, 'generous', 0))[0]?.status).toBe('requested');
    expect(h.executor.of('send')).toEqual([]);

    await handleXpGranted(
      h.ctx,
      h.deps,
      event('xp.granted', {
        guildId: GUILD,
        userId: USER,
        grantId,
        sourceModule: 'achievements',
        status: 'granted',
        amount: 250,
        xp: 250,
        level: 1,
        previousLevel: 0,
      }),
    );

    expect((await h.store.rewardsFor(GUILD, USER, 'generous', 0))[0]?.status).toBe('delivered');
    expect(contentOf(h)).toContain('250 XP given');
  });

  test('Leveling being off fails the reward with the sentence to fix it', async () => {
    const h = harness(
      { announcement: { message: SUMMARY_MESSAGE }, achievements: [GENEROUS] },
      { availability: { isEnabled: async (_guildId, moduleId) => moduleId !== 'leveling' } },
    );
    await run(h, [h.message(1)]);

    const [row] = await h.store.rewardsFor(GUILD, USER, 'generous', 0);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'leveling_off' });
    expect(row?.error).toBe(
      'Leveling is off in this server, so the 250 XP reward wasn’t given. Turn Leveling on, then retry.',
    );
    expect(row?.error).toBe(levelingOffReason(250));
    expect(h.published.some(({ type }) => type === 'xp.grant_requested')).toBe(false);

    expect(contentOf(h)).toContain('Generous');
    expect(contentOf(h)).not.toContain('250 XP given');
  });

  test('a refusal from Leveling is recorded with its reason', async () => {
    const h = harness({ achievements: [GENEROUS] });
    await run(h, [h.message(1)]);

    await handleXpGranted(
      h.ctx,
      h.deps,
      event('xp.granted', {
        guildId: GUILD,
        userId: USER,
        grantId: xpGrantId(GUILD, USER, 'generous', 'single', 0),
        sourceModule: 'achievements',
        status: 'refused',
        amount: 0,
        reason: 'Leveling is off in this server.',
      }),
    );

    expect((await h.store.rewardsFor(GUILD, USER, 'generous', 0))[0]).toMatchObject({
      status: 'failed',
      error: 'Leveling refused the XP reward: Leveling is off in this server.',
    });
    expect(h.executor.of('send')).toHaveLength(1);
  });

  test('the sweep asks again under the same grant id and gives up after the last try', async () => {
    const h = harness({ achievements: [GENEROUS] });
    await run(h, [h.message(1)]);

    for (let attempt = 2; attempt <= MAX_REWARD_ATTEMPTS + 1; attempt++) {
      h.advance(XP_CONFIRM_TIMEOUT_MS + 1);
      await sweep(h);
    }

    const requests = h.published.filter(({ type }) => type === 'xp.grant_requested');
    expect(requests).toHaveLength(MAX_REWARD_ATTEMPTS);
    expect(new Set(requests.map(({ key }) => key)).size).toBe(1);

    const [row] = await h.store.rewardsFor(GUILD, USER, 'generous', 0);
    expect(row).toMatchObject({ status: 'failed', error: XP_UNCONFIRMED });

    await handleXpGranted(
      h.ctx,
      h.deps,
      event('xp.granted', {
        guildId: GUILD,
        userId: USER,
        grantId: xpGrantId(GUILD, USER, 'generous', 'single', 0),
        sourceModule: 'achievements',
        status: 'granted',
        amount: 250,
      }),
    );
    expect((await h.store.rewardsFor(GUILD, USER, 'generous', 0))[0]?.status).toBe('delivered');
  });
});

describe('manual retry', () => {
  test('retries a failed reward and always answers the mailbox', async () => {
    const answers: Array<{ id: string; value: AchievementRetryOutcome }> = [];
    const h = harness(
      { achievements: [GIFTED] },
      { mailbox: { answer: async (id, value) => void answers.push({ id, value }) } },
    );
    h.executor.on(
      ({ kind }) => kind === 'add_role',
      failure('missing_permission', "I'm missing the Manage Roles permission in this server."),
      1,
    );
    await run(h, [h.message(1)]);

    const ref = {
      userId: USER,
      achievementId: 'gifted',
      tierId: 'single' as const,
      generation: 0,
      rewardKey: `add_role:${ROLE}`,
    };
    const request = (rewards: unknown[]) =>
      event('achievements.reward_retry_requested', {
        requestId: 'request-0001',
        guildId: GUILD,
        actorId: ACTOR,
        rewards,
      });

    await handleRetryRequest(h.ctx, h.deps, request([ref, { ...ref, rewardKey: 'xp' }]));

    expect(answers).toEqual([
      {
        id: `${GUILD}:request-0001`,
        value: {
          results: [
            { ...ref, status: 'delivered', message: 'Given.' },
            {
              ...ref,
              rewardKey: 'xp',
              status: 'not_found',
              message: 'That reward isn’t on record any more.',
            },
          ],
        },
      },
    ]);
    expect(
      h.executor.of('add_role').map(({ idempotencyKey }) => idempotencyKey.split(':').at(-1)),
    ).toEqual(['1', '2']);

    await handleRetryRequest(h.ctx, h.deps, request([ref]));
    expect(answers[1]?.value.results).toEqual([
      { ...ref, status: 'delivered', message: 'Already given.' },
    ]);
  });

  test('a reward whose tier a reset voided is never given by a retry', async () => {
    const h = harness({ achievements: [GIFTED] });
    h.executor.on(
      ({ kind }) => kind === 'add_role',
      failure('missing_permission', "I'm missing the Manage Roles permission in this server."),
      1,
    );
    await run(h, [h.message(1)]);
    expect((await h.store.rewardsFor(GUILD, USER, 'gifted', 0))[0]).toMatchObject({
      status: 'failed',
      transient: false,
    });

    await h.store.resetMember({
      guildId: GUILD,
      achievementIds: ['gifted'],
      userId: USER,
      allowRewardsAgain: false,
      actorId: ACTOR,
      at: T0 + 1000,
      audit: audit('reset-before-retry'),
    });

    const result = await retryReward(h.ctx, h.deps, {
      userId: USER,
      achievementId: 'gifted',
      tierId: 'single',
      generation: 0,
      rewardKey: `add_role:${ROLE}`,
    });

    expect(result).toMatchObject({ status: 'not_retryable', message: CANCELLED_BY_RESET });
    expect(h.executor.of('add_role')).toHaveLength(1);
  });
});
