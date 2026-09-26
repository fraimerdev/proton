import { describe, expect, test } from 'bun:test';
import type { BadgeCard } from '@proton/cards/design';
import { renderBadgePng } from '../src/badge.ts';
import type { AchievementInput } from '../src/config.ts';
import { ACHIEVEMENTS_ACTOR, DEADLINE_GRACE_MS, MAX_CAUSATION_DEPTH } from '../src/constants.ts';
import {
  evaluateMember,
  maybeCheckState,
  processRecords,
  type SubjectFacts,
} from '../src/engine.ts';
import { CHANNEL, GUILD, HOUR, MINUTE, ROLE, T0, USER, USER_2 } from './contracts.ts';
import { harness, MEMBER, ROLE_2, subjects } from './fakes.ts';

const FIRST_WORDS: AchievementInput = {
  id: 'first-words',
  name: 'First Words',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'messages', trigger: 'messages.sent' }],
  tiers: [
    { id: 'single', targets: { messages: 1 }, rewards: [{ kind: 'add_role', roleId: ROLE }] },
  ],
};

const WORDSMITH: AchievementInput = {
  id: 'wordsmith',
  name: 'Wordsmith',
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
    { id: 'gold', targets: { xp: 100 } },
  ],
};

const RISING_STAR: AchievementInput = {
  id: 'rising-star',
  name: 'Rising Star',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'level', trigger: 'leveling.level' }],
  tiers: [{ id: 'single', targets: { level: 5 } }],
};

function contentOf(payload: unknown): string {
  return (payload as { content?: string }).content ?? '';
}

describe('processRecords', () => {
  test('a counted message unlocks, publishes, gives the role and announces in the channel', async () => {
    const h = harness({ achievements: [FIRST_WORDS] });

    const unlock = h.store.unlock.bind(h.store);
    let armedBeforeUnlock = false;
    h.store.unlock = async (input) => {
      armedBeforeUnlock = h.scheduled.some(
        ({ jobId, key }) => jobId === 'sweep' && key === `sweep:${T0 + 60_000}`,
      );
      return unlock(input);
    };

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    expect(armedBeforeUnlock).toBe(true);

    const [row, ...others] = await h.store.unlocksOf(GUILD, USER);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      achievementId: 'first-words',
      tierId: 'single',
      originChannelId: CHANNEL,
      publishedAt: T0,
      announceStatus: 'sent',
      cause: { metric: 'messages', sourceModule: 'discord', depth: 0 },
    });

    expect(h.published).toEqual([
      {
        type: 'achievements.unlocked',
        key: `${USER}:first-words:single:0`,
        payload: expect.objectContaining({
          userId: USER,
          tierId: 'single',
          final: true,
          originChannelId: CHANNEL,
          causation: expect.objectContaining({ kind: 'achievement', depth: 0 }),
        }),
      },
    ]);

    expect(h.executor.of('add_role')).toEqual([
      expect.objectContaining({
        targetId: USER,
        actorId: ACHIEVEMENTS_ACTOR,
        reason: 'Earned First Words.',
        record: true,
        payload: { userId: USER, roleId: ROLE },
        idempotencyKey: `achievements:${GUILD}:${USER}:first-words:single:0:add_role:${ROLE}:1`,
      }),
    ]);

    const [send] = h.executor.of('send');
    expect(send).toMatchObject({
      record: false,
      actorId: ACHIEVEMENTS_ACTOR,
      idempotencyKey: `achievements:${GUILD}:announce:${row?.announceGroup}:1`,
      payload: { channelId: CHANNEL },
    });
    expect(contentOf(send?.payload)).toContain('**First Words**');

    const rewards = await h.store.rewardsFor(GUILD, USER, 'first-words', 0);
    expect(rewards.map(({ status }) => status)).toEqual(['delivered']);
  });

  test('a redelivered message is evaluated again and unlocks exactly once', async () => {
    const h = harness({ achievements: [FIRST_WORDS] });

    const unlock = h.store.unlock.bind(h.store);
    let calls = 0;
    h.store.unlock = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('connection reset');
      return unlock(input);
    };

    const input = { records: [h.message(1)], subjects: subjects(), originChannelId: CHANNEL };

    await expect(processRecords(h.ctx, h.deps, input)).rejects.toThrow('connection reset');
    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);

    await processRecords(h.ctx, h.deps, input);
    await processRecords(h.ctx, h.deps, input);

    const [state] = await h.store.memberStates(GUILD, USER, ['first-words']);
    expect(state?.values.messages?.value).toBe(1);
    expect(await h.store.unlocksOf(GUILD, USER)).toHaveLength(1);
    expect(h.published.filter(({ type }) => type === 'achievements.unlocked')).toHaveLength(1);
    expect(h.executor.of('add_role')).toHaveLength(1);
    expect(h.executor.of('send')).toHaveLength(1);
  });

  test('crossing several tiers at once makes one combined announcement', async () => {
    const h = harness({ achievements: [WORDSMITH] });

    await processRecords(h.ctx, h.deps, {
      records: [
        h.message(1, {
          metric: 'activity_xp',
          sourceKey: 'xp-1',
          amount: 150,
          xpSource: 'message',
          sourceModule: 'leveling',
        }),
      ],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    const unlocks = await h.store.unlocksOf(GUILD, USER);
    expect(unlocks.map(({ tierId }) => tierId)).toEqual(['bronze', 'silver', 'gold']);
    expect(new Set(unlocks.map(({ announceGroup }) => announceGroup)).size).toBe(1);
    expect(unlocks.every(({ announceStatus }) => announceStatus === 'sent')).toBe(true);

    const sends = h.executor.of('send');
    expect(sends).toHaveLength(1);
    expect(contentOf(sends[0]?.payload)).toContain('**Wordsmith** (Gold)');

    expect(
      h.published
        .filter(({ type }) => type === 'achievements.unlocked')
        .map(({ key, payload }) => [key, (payload as { final: boolean }).final]),
    ).toEqual([
      [`${USER}:wordsmith:bronze:0`, false],
      [`${USER}:wordsmith:silver:0`, false],
      [`${USER}:wordsmith:gold:0`, true],
    ]);
  });

  test('skips a tier when the subject is a bot, not a member, or lacks the eligible role', async () => {
    const guarded: AchievementInput = { ...FIRST_WORDS, roleIds: [ROLE_2] };
    const refused: SubjectFacts[] = [
      { roleIds: [ROLE_2], isMember: true, isBot: true },
      { roleIds: [ROLE_2], isMember: false, isBot: false },
      { roleIds: [ROLE], isMember: true, isBot: false },
    ];

    for (const facts of refused) {
      const h = harness({ achievements: [guarded] });
      await processRecords(h.ctx, h.deps, {
        records: [h.message(1)],
        subjects: subjects(facts),
        originChannelId: CHANNEL,
      });
      expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);
    }

    const h = harness({ achievements: [guarded] });
    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects({ roleIds: [ROLE_2], isMember: true, isBot: false }),
      originChannelId: CHANNEL,
    });
    expect(await h.store.unlocksOf(GUILD, USER)).toHaveLength(1);
  });

  test('excluded roles, module-wide or per achievement, keep a tier locked', async () => {
    const perAchievement = harness({
      achievements: [{ ...FIRST_WORDS, excludedRoleIds: [ROLE_2] }],
    });
    const moduleWide = harness({ excludedRoleIds: [ROLE_2], achievements: [FIRST_WORDS] });

    for (const h of [perAchievement, moduleWide]) {
      await processRecords(h.ctx, h.deps, {
        records: [h.message(1)],
        subjects: subjects({ roleIds: [ROLE_2], isMember: true, isBot: false }),
        originChannelId: CHANNEL,
      });
      expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);
    }
  });

  test('an unknown subject is looked up, and an unknown or departed member is skipped', async () => {
    const lookups: string[] = [];
    const answers = [
      null,
      undefined,
      { roleIds: [], bot: false, joinedAt: T0 - 1000, premiumSince: null },
    ];

    for (const answer of answers) {
      const h = harness(
        { achievements: [FIRST_WORDS] },
        answer === undefined
          ? {}
          : {
              memberFacts: async (_guildId, userId) => {
                lookups.push(userId);
                return answer;
              },
            },
      );

      await processRecords(h.ctx, h.deps, { records: [h.message(1)], originChannelId: CHANNEL });
      expect(await h.store.unlocksOf(GUILD, USER)).toHaveLength(answer ? 1 : 0);
    }

    expect(lookups).toHaveLength(2);
  });

  test('a blocked member earns nothing, and a failing blocklist is ignored', async () => {
    const blocked = harness(
      { achievements: [FIRST_WORDS] },
      { blocked: { find: async () => ({}) as never } },
    );
    await processRecords(blocked.ctx, blocked.deps, {
      records: [blocked.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });
    expect(await blocked.store.unlocksOf(GUILD, USER)).toEqual([]);

    const broken = harness(
      { achievements: [FIRST_WORDS] },
      {
        blocked: {
          find: async () => {
            throw new Error('database unavailable');
          },
        },
      },
    );
    await processRecords(broken.ctx, broken.deps, {
      records: [broken.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });
    expect(await broken.store.unlocksOf(GUILD, USER)).toHaveLength(1);
  });

  test(`a chain deeper than ${MAX_CAUSATION_DEPTH} steps unlocks nothing`, async () => {
    const h = harness({ achievements: [FIRST_WORDS] });

    await processRecords(h.ctx, h.deps, {
      records: [
        h.message(1, {
          causation: { kind: 'reward', rootId: 'root', depth: MAX_CAUSATION_DEPTH + 1 },
        }),
      ],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);
    expect(h.logs.some((line) => line.includes('past the limit'))).toBe(true);

    await processRecords(h.ctx, h.deps, {
      records: [
        h.message(2, { causation: { kind: 'reward', rootId: 'root', depth: MAX_CAUSATION_DEPTH } }),
      ],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row?.cause.depth).toBe(MAX_CAUSATION_DEPTH);
  });

  test('activity outside the achievement’s dates counts for nothing', async () => {
    const h = harness({
      achievements: [{ ...FIRST_WORDS, startsAt: new Date(T0 + 60_000).toISOString() }],
    });

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    const [state] = await h.store.memberStates(GUILD, USER, ['first-words']);
    expect(state?.values.messages).toBeUndefined();
    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);
  });

  test('a fresh record runs the state check once per window for state achievements', async () => {
    const levels: string[] = [];
    const h = harness(
      { achievements: [RISING_STAR] },
      {
        levelOf: async (_guildId, userId) => {
          levels.push(userId);
          return 6;
        },
      },
    );

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });
    await processRecords(h.ctx, h.deps, {
      records: [h.message(2)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    expect(levels).toEqual([USER]);
    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row).toMatchObject({ achievementId: 'rising-star', progress: { level: 6 } });

    const [state] = await h.store.memberStates(GUILD, USER, ['rising-star']);
    expect(state?.values.level?.value).toBe(6);
  });

  test('onRecorded runs as soon as the row is committed, before anything is evaluated', async () => {
    const h = harness({ achievements: [FIRST_WORDS] });
    const order: string[] = [];

    h.store.unlock = async () => {
      order.push('unlock');
      throw new Error('connection reset');
    };

    await expect(
      processRecords(h.ctx, h.deps, {
        records: [h.message(1)],
        subjects: subjects(),
        originChannelId: CHANNEL,
        onRecorded: async (record) => {
          order.push(`recorded:${record.metric}`);
        },
      }),
    ).rejects.toThrow('connection reset');

    expect(order).toEqual(['recorded:messages', 'unlock']);

    const [state] = await h.store.memberStates(GUILD, USER, ['first-words']);
    expect(state?.values.messages?.value).toBe(1);
  });

  test('a redelivered record runs the state check again and unlocks exactly once', async () => {
    const h = harness({ achievements: [RISING_STAR] }, { levelOf: async () => 10 });

    const unlock = h.store.unlock.bind(h.store);
    let calls = 0;
    h.store.unlock = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('connection reset');
      return unlock(input);
    };

    const input = { records: [h.message(1)], subjects: subjects(), originChannelId: CHANNEL };

    await expect(processRecords(h.ctx, h.deps, input)).rejects.toThrow('connection reset');
    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);

    await processRecords(h.ctx, h.deps, input);
    await processRecords(h.ctx, h.deps, input);

    expect((await h.store.unlocksOf(GUILD, USER)).map(({ tierId }) => tierId)).toEqual(['single']);
  });
});

describe('evaluateMember', () => {
  test('uses the level it is given and records the state value', async () => {
    const h = harness(
      { achievements: [RISING_STAR] },
      {
        memberFacts: async () => ({ roleIds: [], bot: false, joinedAt: null, premiumSince: null }),
      },
    );

    await evaluateMember(h.ctx, h.deps, {
      userId: USER,
      stateValues: { level: 4 },
      originChannelId: null,
      causation: { kind: 'organic', rootId: 'xp.level_gained:1', depth: 1 },
    });
    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);

    await evaluateMember(h.ctx, h.deps, {
      userId: USER,
      stateValues: { level: 5 },
      originChannelId: CHANNEL,
      causation: { kind: 'organic', rootId: 'xp.level_gained:2', depth: 1 },
    });

    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row).toMatchObject({ cause: { metric: 'level', depth: 1 }, originChannelId: CHANNEL });
  });

  test('a state unlock inside the grace is judged on the event time, not the processing time', async () => {
    const deadline = T0 + HOUR;
    const h = harness(
      { achievements: [{ ...RISING_STAR, endsAt: new Date(deadline).toISOString() }] },
      {
        memberFacts: async () => ({ roleIds: [], bot: false, joinedAt: null, premiumSince: null }),
      },
    );

    const reach = (userId: string, occurredAt?: number) =>
      evaluateMember(h.ctx, h.deps, {
        userId,
        stateValues: { level: 5 },
        originChannelId: null,
        ...(occurredAt === undefined ? {} : { occurredAt }),
        causation: { kind: 'organic', rootId: `xp.level_gained:${userId}`, depth: 1 },
      });

    h.advance(HOUR + 10 * MINUTE);
    await reach(USER);
    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);

    await reach(USER, deadline);
    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row).toMatchObject({ achievementId: 'rising-star', cause: { occurredAt: deadline } });

    h.advance(DEADLINE_GRACE_MS);
    await reach(USER_2, deadline);
    expect(await h.store.unlocksOf(GUILD, USER_2)).toEqual([]);
  });

  test('a prerequisite and the earned count come from unlock rows', async () => {
    const collector: AchievementInput = {
      id: 'collector',
      name: 'Collector',
      kind: 'single',
      status: 'active',
      requirements: [{ id: 'earned', trigger: 'achievements.earned' }],
      tiers: [{ id: 'single', targets: { earned: 1 } }],
    };
    const follower: AchievementInput = {
      id: 'follower',
      name: 'Follower',
      kind: 'single',
      status: 'active',
      requirements: [
        {
          id: 'first',
          trigger: 'achievements.unlocked',
          achievementId: 'first-words',
          tierId: 'single',
        },
      ],
      tiers: [{ id: 'single', targets: { first: 1 } }],
    };

    const h = harness({ achievements: [FIRST_WORDS, collector, follower] });

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });
    await evaluateMember(h.ctx, h.deps, {
      userId: USER,
      achievementIds: ['collector', 'follower'],
      subject: MEMBER,
      originChannelId: CHANNEL,
      causation: { kind: 'achievement', rootId: 'achievements.unlocked:1', depth: 1 },
    });

    const unlocked = (await h.store.unlocksOf(GUILD, USER)).map(
      ({ achievementId }) => achievementId,
    );
    expect(unlocked.sort()).toEqual(['collector', 'first-words', 'follower']);
  });
});

describe('renderBadgePng', () => {
  const ASSET = 'asset00001';
  const PNG = 'iVBORw0KGgo=';

  async function drawn(base64: string): Promise<BadgeCard | undefined> {
    const cards: BadgeCard[] = [];
    const h = harness(
      { achievements: [{ ...FIRST_WORDS, badge: { icon: 'star', assetId: ASSET } }] },
      {
        renderBadge: async (card) => {
          cards.push(card);
          return new Uint8Array([1]);
        },
      },
    );
    await h.store.putBadge(GUILD, {
      assetId: ASSET,
      contentType: 'image/png',
      base64,
      byteSize: base64.length,
      uploadedBy: ACHIEVEMENTS_ACTOR,
      uploadedAt: T0,
    });

    const [achievement] = h.ctx.config.achievements;
    if (!achievement) throw new Error('the harness lost the achievement');
    expect(await renderBadgePng(h.deps, GUILD, achievement, 'single', 1000)).not.toBeNull();

    return cards[0];
  }

  test('draws a stored image, and falls back to the icon when it fails validation', async () => {
    expect(await drawn(PNG)).toMatchObject({ image: `data:image/png;base64,${PNG}` });

    const refused = await drawn('AAAAAAAAAAAA');
    expect(refused).toMatchObject({ icon: 'star' });
    expect(refused?.image).toBeUndefined();
  });
});

describe('maybeCheckState', () => {
  test('throttles per member but lets the same root through again', async () => {
    let reads = 0;
    const h = harness(
      { achievements: [RISING_STAR] },
      {
        levelOf: async () => {
          reads += 1;
          return 1;
        },
      },
    );

    const check = (rootId: string, userId = USER) =>
      maybeCheckState(h.ctx, h.deps, {
        userId,
        subject: MEMBER,
        originChannelId: null,
        causation: { kind: 'organic', rootId, depth: 0 },
      });

    await check('event-1');
    await check('event-1');
    await check('event-2');
    await check('event-3', USER_2);

    expect(reads).toBe(3);
  });
});
