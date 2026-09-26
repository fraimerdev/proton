import { describe, expect, test } from 'bun:test';
import { Permissions, personFor, type SimulationScene, xpAwardedSchema } from '@proton/core';
import type { AchievementInput, AnnouncementMessage, Reward } from '../src/config.ts';
import { DEADLINE_GRACE_MS, REACTION_MAX_AGE_MS } from '../src/constants.ts';
import { instantiatePreset } from '../src/presets.ts';
import { achievementsSimulations } from '../src/simulation.ts';
import { ALREADY_GIVEN } from '../src/store.ts';
import type { TriggerId } from '../src/triggers.ts';
import {
  ANNOUNCE,
  BOT_PERMISSIONS,
  DAY,
  FOURTH,
  GUILD,
  type Harness,
  HOUR,
  harness,
  MEMBER,
  MEMBER_ROLE,
  type MessageOptions,
  MINUTE,
  OTHER,
  OTHER_GUILD,
  OTHER_TEXT,
  REWARD_ROLE,
  refOf,
  SECOND,
  SECOND_REWARD_ROLE,
  seededRandom,
  snapshotOf,
  snowflakeAt,
  T0,
  TEXT,
  THIRD,
  VOICE,
} from './harness.ts';

const REWARD_MESSAGE: AnnouncementMessage = {
  content: '{user.mention} earned **{achievement.name}**: {rewards.summary}',
  embeds: [],
  components: [],
  mentions: { everyone: false, roles: false, users: true },
  v2: [],
};

function single(
  id: string,
  name: string,
  trigger: TriggerId,
  target: number,
  rewards: Reward[] = [],
  extra: Partial<AchievementInput> = {},
): AchievementInput {
  return {
    id,
    name,
    kind: 'single',
    status: 'active',
    requirements: [{ id: 'goal', trigger }],
    tiers: [{ id: 'single', targets: { goal: target }, rewards }],
    ...extra,
  };
}

async function chat(h: Harness, count: number, options: MessageOptions = {}): Promise<void> {
  for (let index = 0; index < count; index++) {
    h.advance(SECOND);
    await h.emit(h.message(options));
  }
}

function ids(rows: ReadonlyArray<{ achievementId: string }>): string[] {
  return rows.map(({ achievementId }) => achievementId).sort();
}

describe('achievements over the real executor', () => {
  test('duplicate and out-of-order events', async () => {
    const h = harness();
    await h.configure({
      announcement: { destination: 'channel', channelId: ANNOUNCE },
      achievements: [
        single('chatterbox', 'Chatterbox', 'messages.sent', 3),
        single('rising-star', 'Rising Star', 'leveling.level', 5),
        single('voice-regular', 'Voice Regular', 'voice.minutes', 30),
      ],
    });

    const first = h.message();
    await h.emit(first);
    await h.emit(first);
    expect(await h.value(MEMBER, 'chatterbox', 'goal')).toBe(1);

    const second = h.message({ at: h.clock.now + SECOND });
    const third = h.message({ at: h.clock.now + 2 * SECOND });
    h.advance(3 * SECOND);
    await h.emit(third);
    await h.emit(second);
    await h.emit(second);
    expect(await h.value(MEMBER, 'chatterbox', 'goal')).toBe(3);

    await h.emit(h.levelGained({ level: 6 }));
    await h.emit(h.levelGained({ level: 5, at: h.clock.now - MINUTE }));

    const joined = h.voiceUpdate({ channelId: VOICE });
    const muted = h.voiceUpdate({
      channelId: VOICE,
      selfMute: true,
      at: h.clock.now + 10 * MINUTE,
    });
    await h.emit(joined);
    h.advance(30 * MINUTE);
    await h.emit(h.voiceUpdate({ channelId: null }));
    await h.emit(joined);
    await h.emit(muted);

    expect(await h.value(MEMBER, 'voice-regular', 'goal')).toBe(30);
    expect(await h.voice.list(GUILD)).toEqual([]);

    const retried = h.voiceUpdate({ userId: OTHER, channelId: VOICE });
    h.advance(5 * MINUTE);
    await h.emit(h.voiceUpdate({ userId: OTHER, channelId: null }));
    await h.emit(retried);
    await h.tick(HOUR, 10 * MINUTE);

    expect(await h.voice.list(GUILD)).toEqual([]);
    expect(await h.value(OTHER, 'voice-regular', 'goal')).toBe(0);

    expect(ids(await h.unlocks(MEMBER))).toEqual(['chatterbox', 'rising-star', 'voice-regular']);
    expect(h.ofType('achievements.unlocked')).toHaveLength(3);
    expect(h.sends(ANNOUNCE)).toHaveLength(3);
  });

  test('throw after record → redelivery unlocks once', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        single('first-words', 'First Words', 'messages.sent', 1, [
          { kind: 'add_role', roleId: REWARD_ROLE },
        ]),
      ],
    });

    h.crashAfter('record');
    const message = h.message();

    await expect(h.emit(message)).rejects.toThrow('the worker died right after record');
    expect(await h.value(MEMBER, 'first-words', 'goal')).toBe(1);
    expect(await h.unlocks(MEMBER)).toEqual([]);

    await h.emit(message);
    await h.emit(message);

    expect(await h.value(MEMBER, 'first-words', 'goal')).toBe(1);
    expect(await h.unlocks(MEMBER)).toHaveLength(1);
    expect(h.ofType('achievements.unlocked')).toHaveLength(1);
    expect(h.roleCalls()).toEqual([
      { method: 'PUT', guildId: GUILD, userId: MEMBER, roleId: REWARD_ROLE, status: 204 },
    ]);
    expect(h.sends(TEXT)).toHaveLength(1);
  });

  test('throw after unlock → sweep delivers and publishes once', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        single('first-words', 'First Words', 'messages.sent', 1, [
          { kind: 'add_role', roleId: REWARD_ROLE },
        ]),
      ],
    });

    h.crashAfter('unlock');
    const message = h.message();

    await expect(h.emit(message)).rejects.toThrow('the worker died right after unlock');
    expect(await h.unlocks(MEMBER)).toMatchObject([
      { achievementId: 'first-words', publishedAt: null, announceStatus: 'pending' },
    ]);
    expect(h.scheduler.pending('sweep', GUILD)).toHaveLength(1);

    await h.emit(message);
    expect(h.ofType('achievements.unlocked')).toEqual([]);
    expect(h.roleCalls()).toEqual([]);
    expect(h.sends()).toEqual([]);

    await h.tick(3 * MINUTE, 30 * SECOND);

    expect(h.ofType('achievements.unlocked')).toHaveLength(1);
    expect(h.roleCalls()).toHaveLength(1);
    expect(h.sends(TEXT)).toHaveLength(1);
    expect(await h.rewards(MEMBER, 'first-words')).toMatchObject([{ status: 'delivered' }]);
    expect(await h.unlocks(MEMBER)).toMatchObject([{ announceStatus: 'sent' }]);

    await h.tick(HOUR, 5 * MINUTE);
    await h.emit(message);

    expect(h.ofType('achievements.unlocked')).toHaveLength(1);
    expect(h.roleCalls()).toHaveLength(1);
    expect(h.sends()).toHaveLength(1);
    expect(h.scheduler.pending('sweep', GUILD)).toEqual([]);
  });

  test('concurrent tier completion', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        {
          id: 'chatterbox',
          name: 'Chatterbox',
          kind: 'tiered',
          status: 'active',
          requirements: [{ id: 'goal', trigger: 'messages.sent' }],
          tiers: [
            {
              id: 'bronze',
              targets: { goal: 3 },
              rewards: [{ kind: 'add_role', roleId: REWARD_ROLE }],
            },
            {
              id: 'silver',
              targets: { goal: 5 },
              rewards: [{ kind: 'add_role', roleId: SECOND_REWARD_ROLE }],
            },
          ],
        },
      ],
    });

    await chat(h, 2);
    for (let round = 0; round < 2; round++) {
      h.advance(SECOND);
      await Promise.all([h.emit(h.message()), h.emit(h.message(), { worker: 'second' })]);
    }

    expect(await h.value(MEMBER, 'chatterbox', 'goal')).toBe(6);
    expect((await h.unlocks(MEMBER)).map(({ tierId }) => tierId)).toEqual(['bronze', 'silver']);
    expect(h.ofType('achievements.unlocked').map(({ id }) => id)).toEqual([
      `achievements.unlocked:${GUILD}:${MEMBER}:chatterbox:bronze:0`,
      `achievements.unlocked:${GUILD}:${MEMBER}:chatterbox:silver:0`,
    ]);
    expect(h.roleCalls().map(({ roleId }) => roleId)).toEqual([REWARD_ROLE, SECOND_REWARD_ROLE]);
    expect(h.sends(TEXT)).toHaveLength(2);
  });

  test('multiple thresholds at once: one combined announcement, rewards once, net role intent', async () => {
    const h = harness();
    await h.configure({
      announcement: {
        destination: 'channel',
        channelId: ANNOUNCE,
        message: {
          ...REWARD_MESSAGE,
          content:
            '{user.mention} reached {achievement.tiers_unlocked} in **{achievement.name}**: {rewards.summary}',
        },
      },
      achievements: [
        {
          id: 'voice-regular',
          name: 'Voice Regular',
          kind: 'tiered',
          status: 'active',
          requirements: [{ id: 'minutes', trigger: 'voice.minutes' }],
          tiers: [
            {
              id: 'bronze',
              targets: { minutes: 10 },
              rewards: [{ kind: 'add_role', roleId: REWARD_ROLE }],
            },
            {
              id: 'silver',
              targets: { minutes: 30 },
              rewards: [
                { kind: 'remove_role', roleId: REWARD_ROLE },
                { kind: 'add_role', roleId: SECOND_REWARD_ROLE },
              ],
            },
            { id: 'gold', targets: { minutes: 60 }, rewards: [{ kind: 'xp', amount: 100 }] },
          ],
        },
      ],
    });

    await h.emit(h.voiceUpdate({ channelId: VOICE }));
    h.advance(60 * MINUTE);
    const left = h.voiceUpdate({ channelId: null });
    await h.emit(left);

    const unlocks = await h.unlocks(MEMBER);
    expect(unlocks.map(({ tierId }) => tierId)).toEqual(['bronze', 'silver', 'gold']);
    expect(new Set(unlocks.map(({ announceGroup }) => announceGroup)).size).toBe(1);

    expect(
      (await h.rewards(MEMBER, 'voice-regular')).map(({ tierId, rewardKey, status, error }) => [
        tierId,
        rewardKey,
        status,
        error,
      ]),
    ).toEqual([
      ['bronze', `add_role:${REWARD_ROLE}`, 'skipped', 'Replaced by Silver’s reward.'],
      ['silver', `add_role:${SECOND_REWARD_ROLE}`, 'delivered', null],
      ['silver', `remove_role:${REWARD_ROLE}`, 'delivered', null],
      ['gold', 'xp', 'delivered', null],
    ]);
    expect(h.roleCalls().map(({ method, roleId }) => [method, roleId])).toEqual([
      ['DELETE', REWARD_ROLE],
      ['PUT', SECOND_REWARD_ROLE],
    ]);
    expect(h.rest.member(GUILD, MEMBER)?.roles).toEqual([MEMBER_ROLE, SECOND_REWARD_ROLE]);
    expect(h.leveling.xpOf(GUILD, MEMBER)).toBe(100);

    const sent = h.sends(ANNOUNCE);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.content).toContain('Bronze, Silver and Gold');
    expect(sent[0]?.body.content).toContain(
      `<@&${SECOND_REWARD_ROLE}> and 100 XP given; <@&${REWARD_ROLE}> removed`,
    );

    await h.emit(left);
    await h.redeliver('achievements.unlocked');
    await h.tick(HOUR, 5 * MINUTE);

    expect(h.roleCalls()).toHaveLength(2);
    expect(h.leveling.requests).toHaveLength(1);
    expect(h.sends()).toHaveLength(1);
  });

  test('partial reward failure → retry only the failed role', async () => {
    const h = harness();
    await h.configure({
      announcement: { message: REWARD_MESSAGE },
      achievements: [
        single('helper', 'Helper', 'messages.sent', 1, [
          { kind: 'add_role', roleId: REWARD_ROLE },
          { kind: 'add_role', roleId: SECOND_REWARD_ROLE },
        ]),
      ],
    });
    h.rest.fail('PUT', `/guilds/${GUILD}/members/${MEMBER}/roles/${SECOND_REWARD_ROLE}`, 403, {
      code: 50013,
      message: 'Missing Permissions',
    });

    await h.emit(h.message());

    const rewards = await h.rewards(MEMBER, 'helper');
    expect(rewards.map(({ roleId, status, transient }) => [roleId, status, transient])).toEqual([
      [REWARD_ROLE, 'delivered', false],
      [SECOND_REWARD_ROLE, 'failed', false],
    ]);

    const [announced, ...more] = h.sends(TEXT);
    expect(more).toEqual([]);
    expect(announced?.body.content).toContain(`<@&${REWARD_ROLE}> given`);
    expect(announced?.body.content).not.toContain(SECOND_REWARD_ROLE);

    h.rest.heal();
    const failed = rewards.filter(({ status }) => status === 'failed').map(refOf);
    const retry = h.retryRequested(failed);
    await h.emit(retry);

    const { requestId } = retry.payload as { requestId: string };
    expect(h.mailbox.answers).toEqual([
      {
        id: `${GUILD}:${requestId}`,
        value: {
          results: failed.map((ref) => ({ ...ref, status: 'delivered', message: 'Given.' })),
        },
      },
    ]);
    expect(h.roleCalls().map(({ roleId, status }) => [roleId, status])).toEqual([
      [REWARD_ROLE, 204],
      [SECOND_REWARD_ROLE, 403],
      [SECOND_REWARD_ROLE, 204],
    ]);
    expect((await h.rewards(MEMBER, 'helper')).map(({ status }) => status)).toEqual([
      'delivered',
      'delivered',
    ]);
    expect(h.sends()).toHaveLength(1);
  });

  test('transient failure retried by the sweep without new activity', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        single('first-words', 'First Words', 'messages.sent', 1, [
          { kind: 'add_role', roleId: REWARD_ROLE },
        ]),
      ],
    });
    h.rest.fail('PUT', `/guilds/${GUILD}/members/${MEMBER}/roles/`, 503);

    await h.emit(h.message());

    expect(await h.rewards(MEMBER, 'first-words')).toMatchObject([
      { status: 'failed', transient: true, attempts: 1, nextAttemptAt: T0 + 30 * SECOND },
    ]);
    expect(h.sends()).toEqual([]);

    h.rest.heal();
    await h.tick(3 * MINUTE, 30 * SECOND);

    expect(await h.rewards(MEMBER, 'first-words')).toMatchObject([
      { status: 'delivered', attempts: 2, transient: false },
    ]);
    expect(h.roleCalls().map(({ status }) => status)).toEqual([503, 204]);
    expect(h.sends(TEXT)).toHaveLength(1);
    expect(await h.unlocks(MEMBER)).toMatchObject([{ announceStatus: 'sent' }]);
  });

  test('XP reward loop bounded: reward XP → level → level achievement → no repeat', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        single('chatter', 'Chatter', 'messages.sent', 1, [{ kind: 'xp', amount: 500 }]),
        single('rising-star', 'Rising Star', 'leveling.level', 5, [{ kind: 'xp', amount: 500 }]),
      ],
    });

    await h.emit(h.message());

    expect(
      (await h.unlocks(MEMBER)).map(({ achievementId, cause }) => [achievementId, cause.depth]),
    ).toEqual([
      ['chatter', 0],
      ['rising-star', 1],
    ]);
    expect(h.leveling.requests.map(({ amount }) => amount)).toEqual([500, 500]);
    expect(h.leveling.xpOf(GUILD, MEMBER)).toBe(1000);
    expect(
      h.ofType('xp.level_gained').map(({ payload }) => (payload as { level: number }).level),
    ).toEqual([5, 10]);
    expect(h.ofType('achievements.unlocked')).toHaveLength(2);
    expect((await h.rewards(MEMBER, 'chatter')).map(({ status }) => status)).toEqual(['delivered']);
    expect((await h.rewards(MEMBER, 'rising-star')).map(({ status }) => status)).toEqual([
      'delivered',
    ]);

    for (const type of [
      'achievements.unlocked',
      'xp.grant_requested',
      'xp.level_gained',
      'xp.awarded',
      'xp.granted',
    ] as const) {
      await h.redeliver(type);
    }

    expect(h.leveling.xpOf(GUILD, MEMBER)).toBe(1000);
    expect(h.ofType('achievements.unlocked')).toHaveLength(2);
    expect(await h.unlocks(MEMBER)).toHaveLength(2);
    expect(h.sends(TEXT)).toHaveLength(2);
  });

  test('historical progress with filters: a rebuild counts only its channels, and only with recorded activity included', async () => {
    const h = harness();
    await h.configure({ achievements: [] });

    h.advance(10 * MINUTE);
    await chat(h, 3, { channelId: TEXT });
    await chat(h, 2, { channelId: OTHER_TEXT });

    const limited = (id: string, name: string, includeRecorded: boolean): AchievementInput => ({
      ...single(id, name, 'messages.sent', 3),
      requirements: [{ id: 'goal', trigger: 'messages.sent', channelIds: [TEXT] }],
      includeRecorded,
    });

    h.advance(2 * HOUR);
    await h.configure({
      announcement: { destination: 'channel', channelId: ANNOUNCE },
      achievements: [
        limited('recorded-talk', 'Recorded Talk', true),
        limited('fresh-talk', 'Fresh Talk', false),
        single('collector', 'Collector', 'achievements.earned', 1),
      ],
    });
    await h.tick(MINUTE, 5 * SECOND);

    expect(await h.store.job(GUILD, 'recorded-talk')).toMatchObject({
      job: 'rebuild',
      status: 'done',
    });
    expect(await h.value(MEMBER, 'recorded-talk', 'goal')).toBe(3);
    expect(await h.value(MEMBER, 'fresh-talk', 'goal')).toBe(0);
    expect(ids(await h.unlocks(MEMBER))).toEqual(['collector', 'recorded-talk']);
    expect((await h.unlocks(MEMBER)).map(({ announceStatus }) => announceStatus)).toEqual([
      'suppressed',
      'suppressed',
    ]);
    expect(h.sends()).toEqual([]);

    await h.emit(h.jobRequested('fresh-talk', 'rebuild'));
    await h.tick(MINUTE, 5 * SECOND);

    expect(await h.store.job(GUILD, 'fresh-talk')).toMatchObject({
      job: 'rebuild',
      status: 'done',
    });
    expect(await h.value(MEMBER, 'fresh-talk', 'goal')).toBe(0);

    await chat(h, 1, { channelId: OTHER_TEXT });
    expect(await h.value(MEMBER, 'fresh-talk', 'goal')).toBe(0);
    await chat(h, 1, { channelId: TEXT });
    expect(await h.value(MEMBER, 'fresh-talk', 'goal')).toBe(1);
    expect(await h.value(MEMBER, 'recorded-talk', 'goal')).toBe(4);
  });

  test('module disable and re-enable: the paused interval is excluded and voice stays end without counting', async () => {
    const h = harness();
    const achievements = [
      single('chatter', 'Chatter', 'messages.sent', 5),
      single('voice-regular', 'Voice Regular', 'voice.minutes', 30),
    ];
    await h.configure({ achievements });

    h.advance(MINUTE);
    await h.emit(h.voiceUpdate({ channelId: VOICE }));
    h.advance(10 * MINUTE);
    await h.configure({ enabled: false, achievements });

    expect(await h.voice.list(GUILD)).toEqual([]);
    expect(await h.value(MEMBER, 'voice-regular', 'goal')).toBe(0);
    expect(h.logs.some(({ message }) => message.includes('without counting them'))).toBe(true);

    h.advance(9 * MINUTE);
    const paused = h.message();
    await h.emit(paused);
    expect(await h.value(MEMBER, 'chatter', 'goal')).toBe(0);

    h.advance(10 * MINUTE);
    await h.configure({ achievements });
    h.advance(MINUTE);
    await h.emit(paused);
    expect(await h.value(MEMBER, 'chatter', 'goal')).toBe(0);
    await h.emit(h.message());
    expect(await h.value(MEMBER, 'chatter', 'goal')).toBe(1);

    h.advance(MINUTE);
    await h.emit(h.voiceUpdate({ channelId: VOICE, selfMute: true }));
    h.advance(30 * MINUTE);
    await h.emit(h.voiceUpdate({ channelId: null }));

    expect(await h.value(MEMBER, 'voice-regular', 'goal')).toBe(30);
    expect(ids(await h.unlocks(MEMBER))).toEqual(['voice-regular']);
    expect((await h.store.runtime(GUILD)).modulePeriods).toEqual([
      { start: T0, end: T0 + 11 * MINUTE },
      { start: T0 + 30 * MINUTE, end: null },
    ]);
  });

  test('deadline boundaries and delayed events: inside the grace counts, after it does not, after the deadline never', async () => {
    const h = harness();
    const deadline = T0 + DAY;
    const endsAt = new Date(deadline).toISOString();
    await h.configure({
      achievements: [
        single('sprint', 'Sprint', 'messages.sent', 1, [], { endsAt }),
        single('marathon', 'Marathon', 'voice.minutes', 20, [], { endsAt }),
        {
          id: 'combo',
          name: 'Combo',
          kind: 'single',
          status: 'active',
          endsAt,
          requirements: [
            {
              id: 'goal',
              trigger: 'achievements.unlocked',
              achievementId: 'sprint',
              tierId: 'single',
            },
          ],
          tiers: [{ id: 'single', targets: { goal: 1 } }],
        },
      ],
    });

    h.clock.now = deadline - 25 * MINUTE;
    await h.emit(h.voiceUpdate({ channelId: VOICE }));
    h.clock.now = deadline + 10 * MINUTE;
    await h.emit(h.voiceUpdate({ channelId: null }));
    await h.emit(h.message({ authorId: THIRD, at: deadline + 1 }));

    h.clock.now = deadline + 30 * MINUTE;
    await h.emit(h.message({ authorId: FOURTH, at: deadline - 30 * MINUTE }));

    h.clock.now = deadline + DEADLINE_GRACE_MS;
    await h.emit(h.message({ authorId: MEMBER, at: deadline }));

    h.clock.now = deadline + DEADLINE_GRACE_MS + 1;
    await h.emit(h.message({ authorId: OTHER, at: deadline - MINUTE }));

    expect(await h.value(MEMBER, 'marathon', 'goal')).toBe(25);
    expect(ids(await h.unlocks(MEMBER))).toEqual(['combo', 'marathon', 'sprint']);
    expect(ids(await h.unlocks(FOURTH))).toEqual(['combo', 'sprint']);
    expect(await h.unlocks(OTHER)).toEqual([]);
    expect(await h.unlocks(THIRD)).toEqual([]);
    expect(await h.value(OTHER, 'sprint', 'goal')).toBe(0);
    expect(await h.value(THIRD, 'sprint', 'goal')).toBe(0);
  });

  test('a level-up delivered late is judged on the level-up, not on when the bus got to it', async () => {
    const h = harness();
    const deadline = T0 + DAY;
    const endsAt = new Date(deadline).toISOString();
    await h.configure({
      achievements: [single('climber', 'Climber', 'leveling.level', 5, [], { endsAt })],
    });

    h.clock.now = deadline + 10 * MINUTE;
    await h.emit(h.levelGained({ userId: MEMBER, level: 5, at: deadline - MINUTE }));

    h.clock.now = deadline + DEADLINE_GRACE_MS + 1;
    await h.emit(h.levelGained({ userId: OTHER, level: 5, at: deadline - MINUTE }));

    expect(ids(await h.unlocks(MEMBER))).toEqual(['climber']);
    expect(await h.unlocks(OTHER)).toEqual([]);
  });

  test('edits: a version bump restarts the requirement, a stale writer is ignored, a new target applies on re-check', async () => {
    const h = harness();
    const announcement = { destination: 'channel' as const, channelId: ANNOUNCE };
    const original = single('chatterbox', 'Chatterbox', 'messages.sent', 5);
    const before = await h.configure({ announcement, achievements: [original] });

    await chat(h, 3, { channelId: OTHER_TEXT });
    expect(await h.value(MEMBER, 'chatterbox', 'goal')).toBe(3);

    const refiltered: AchievementInput = {
      ...original,
      requirements: [{ id: 'goal', version: 2, trigger: 'messages.sent', channelIds: [TEXT] }],
    };
    await h.configure({ announcement, achievements: [refiltered] });
    await chat(h, 1, { channelId: TEXT });
    expect(await h.value(MEMBER, 'chatterbox', 'goal')).toBe(1);

    h.advance(SECOND);
    await h.emit(h.message({ channelId: OTHER_TEXT }), { config: before });
    const [state] = await h.store.memberStates(GUILD, MEMBER, ['chatterbox']);
    expect(state?.values.goal).toMatchObject({ value: 1, version: 2 });

    await chat(h, 1, { channelId: TEXT });
    await h.configure({
      announcement,
      achievements: [{ ...refiltered, tiers: [{ id: 'single', targets: { goal: 2 } }] }],
    });
    expect(await h.unlocks(MEMBER)).toEqual([]);

    await h.emit(h.jobRequested('chatterbox', 'recheck', { announce: true }));
    await h.tick(MINUTE, 5 * SECOND);

    expect(await h.store.job(GUILD, 'chatterbox')).toMatchObject({
      job: 'recheck',
      status: 'done',
    });
    expect(await h.unlocks(MEMBER)).toMatchObject([
      { achievementId: 'chatterbox', progress: { goal: 2 }, announceStatus: 'sent' },
    ]);
    expect(h.sends(ANNOUNCE)).toHaveLength(1);
  });

  test('resets: member, all and server; rewards are not given again; in-flight XP then re-earning credits once', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        single('first-words', 'First Words', 'messages.sent', 1, [
          { kind: 'add_role', roleId: REWARD_ROLE },
        ]),
        single('regular', 'Regular', 'messages.sent', 2, [
          { kind: 'add_role', roleId: SECOND_REWARD_ROLE },
        ]),
        single('bonus', 'Bonus', 'messages.sent', 1, [{ kind: 'xp', amount: 100 }]),
      ],
    });
    const grants = (userId: string) =>
      h
        .roleCalls()
        .filter((call) => call.userId === userId && call.status < 400)
        .map(({ roleId }) => roleId);

    await chat(h, 1, { authorId: MEMBER });
    await h.resetMember(MEMBER, ['first-words']);
    await chat(h, 1, { authorId: MEMBER });

    expect(await h.unlocks(MEMBER)).toMatchObject([
      { achievementId: 'bonus', generation: 0 },
      { achievementId: 'first-words', generation: 1 },
      { achievementId: 'regular', generation: 0 },
    ]);
    expect(await h.rewards(MEMBER, 'first-words')).toMatchObject([
      { generation: 1, status: 'skipped', error: ALREADY_GIVEN },
    ]);
    expect(grants(MEMBER)).toEqual([REWARD_ROLE, SECOND_REWARD_ROLE]);

    await chat(h, 2, { authorId: OTHER });
    await h.resetMember(OTHER, ['first-words', 'regular', 'bonus']);
    expect(await h.unlocks(OTHER)).toEqual([]);
    await chat(h, 2, { authorId: OTHER });

    expect(ids(await h.unlocks(OTHER))).toEqual(['bonus', 'first-words', 'regular']);
    for (const achievementId of ['first-words', 'regular', 'bonus']) {
      expect(await h.rewards(OTHER, achievementId)).toMatchObject([
        { generation: 1, status: 'skipped', error: ALREADY_GIVEN },
      ]);
    }
    expect(grants(OTHER)).toEqual([REWARD_ROLE, SECOND_REWARD_ROLE]);
    expect(h.leveling.xpOf(GUILD, OTHER)).toBe(100);

    h.advance(SECOND);
    await h.resetAchievement('first-words');
    expect(ids(await h.unlocks(MEMBER))).toEqual(['bonus', 'regular']);
    expect(ids(await h.unlocks(OTHER))).toEqual(['bonus', 'regular']);

    await chat(h, 1, { authorId: MEMBER });
    await chat(h, 1, { authorId: THIRD });

    expect(await h.rewards(MEMBER, 'first-words')).toMatchObject([
      { generation: 2, status: 'skipped', error: ALREADY_GIVEN },
    ]);
    expect(await h.rewards(THIRD, 'first-words')).toMatchObject([
      { generation: 1, status: 'delivered' },
    ]);
    expect(grants(MEMBER)).toEqual([REWARD_ROLE, SECOND_REWARD_ROLE]);
    expect(grants(THIRD)).toEqual([REWARD_ROLE]);

    h.hold();
    await chat(h, 1, { authorId: FOURTH });
    expect(await h.rewards(FOURTH, 'bonus')).toMatchObject([{ status: 'requested' }]);

    await h.resetMember(FOURTH, ['bonus']);
    await chat(h, 1, { authorId: FOURTH });
    expect(await h.rewards(FOURTH, 'bonus')).toMatchObject([
      { generation: 1, status: 'skipped', error: ALREADY_GIVEN },
    ]);

    await h.release();

    expect(h.leveling.xpOf(GUILD, FOURTH)).toBe(100);
    expect(h.leveling.grantsFor(FOURTH)).toHaveLength(1);
    expect(await h.store.rewardsFor(GUILD, FOURTH, 'bonus', 0)).toMatchObject([
      { status: 'delivered' },
    ]);
  });

  test('guild isolation', async () => {
    const h = harness();
    const achievements = [
      single('first-words', 'First Words', 'messages.sent', 1, [
        { kind: 'add_role', roleId: REWARD_ROLE },
      ]),
    ];
    await h.configure({ achievements });
    await h.configure({ achievements }, OTHER_GUILD);

    await h.emit(h.message());

    expect(await h.unlocks(MEMBER)).toHaveLength(1);
    expect(await h.unlocks(MEMBER, OTHER_GUILD)).toEqual([]);
    expect(await h.value(MEMBER, 'first-words', 'goal', OTHER_GUILD)).toBe(0);
    expect(h.roleCalls().map(({ guildId }) => guildId)).toEqual([GUILD]);
    expect(h.published.every(({ guildId }) => guildId === GUILD)).toBe(true);

    const [reward] = await h.rewards(MEMBER, 'first-words');
    if (!reward) throw new Error('the unlock created no reward');
    await h.emit({ ...h.retryRequested([refOf(reward)]), guildId: OTHER_GUILD });
    expect(h.mailbox.answers).toEqual([]);

    await h.emit({
      id: `xp.awarded:${OTHER_GUILD}:forged`,
      type: 'xp.awarded',
      guildId: OTHER_GUILD,
      occurredAt: h.clock.now,
      payload: xpAwardedSchema.parse({
        guildId: GUILD,
        userId: MEMBER,
        amount: 10,
        source: 'message',
        activityAt: h.clock.now,
        xp: 10,
        level: 0,
        causation: { kind: 'organic', rootId: 'forged', depth: 0 },
      }),
    });
    expect(h.logs.some(({ message }) => message.includes(`names server ${GUILD}`))).toBe(true);

    await h.emit(h.message({ guildId: OTHER_GUILD }));

    expect(await h.unlocks(MEMBER, OTHER_GUILD)).toHaveLength(1);
    expect(await h.unlocks(MEMBER)).toHaveLength(1);
    expect(h.roleCalls().map(({ guildId }) => guildId)).toEqual([GUILD, OTHER_GUILD]);
    expect(h.scheduler.pending('sweep', OTHER_GUILD)).toHaveLength(1);
  });

  test('combined requirements: progress per requirement, unlocked only when all are met', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        {
          id: 'socialite',
          name: 'Socialite',
          kind: 'single',
          status: 'active',
          requirements: [
            { id: 'talk', trigger: 'messages.sent' },
            { id: 'liked', trigger: 'reactions.received' },
          ],
          tiers: [{ id: 'single', targets: { talk: 3, liked: 2 } }],
        },
      ],
    });
    const progress = async () => [
      await h.value(MEMBER, 'socialite', 'talk'),
      await h.value(MEMBER, 'socialite', 'liked'),
    ];

    await chat(h, 3);
    expect(await progress()).toEqual([3, 0]);
    expect(await h.unlocks(MEMBER)).toEqual([]);

    const post = snowflakeAt(h.clock.now - MINUTE);
    await h.emit(h.reaction({ reactorId: OTHER, authorId: MEMBER, messageId: post }));
    expect(await progress()).toEqual([3, 1]);
    expect(await h.unlocks(MEMBER)).toEqual([]);

    await h.emit(h.reaction({ reactorId: THIRD, authorId: MEMBER, messageId: post }));
    expect(await h.unlocks(MEMBER)).toMatchObject([
      {
        achievementId: 'socialite',
        progress: { talk: 3, liked: 2 },
        cause: { metric: 'reactions_received' },
      },
    ]);
  });

  test('simulations leave data untouched', async () => {
    const h = harness();
    const config = await h.configure({
      announcement: { destination: 'channel', channelId: ANNOUNCE, message: REWARD_MESSAGE },
      almostThere: { destination: 'channel', channelId: ANNOUNCE },
      achievements: [
        single('first-words', 'First Words', 'messages.sent', 1, [
          { kind: 'add_role', roleId: REWARD_ROLE },
        ]),
        {
          id: 'chatterbox',
          name: 'Chatterbox',
          kind: 'tiered',
          status: 'active',
          requirements: [{ id: 'goal', trigger: 'messages.sent' }],
          tiers: [
            { id: 'bronze', targets: { goal: 2 } },
            { id: 'silver', targets: { goal: 10 }, rewards: [{ kind: 'xp', amount: 50 }] },
          ],
          almostThere: { enabled: true, percent: 50 },
        },
      ],
    });

    await chat(h, 5);
    await h.emit(h.voiceUpdate({ channelId: VOICE }));
    expect(ids(await h.unlocks(MEMBER))).toEqual(['chatterbox', 'first-words']);

    const before = snapshotOf(h.store);
    const voice = await h.voice.list(GUILD);
    const counts = [h.rest.exchanges.length, h.published.length, h.scheduler.booked.length];

    const subject = personFor(
      { id: MEMBER, username: 'member', globalName: 'Member', avatarHash: null },
      { nick: null, roleIds: [MEMBER_ROLE] },
    );
    const scene = (inputs: Record<string, string | number>): SimulationScene => ({
      guildId: GUILD,
      server: { id: GUILD, name: 'Proton test' },
      guildState: null,
      subject,
      actor: subject,
      destinationChannel: { id: ANNOUNCE, name: 'achievements', parentId: null },
      originChannel: { id: TEXT, name: 'general', parentId: null },
      bot: null,
      eventId: 'simulation:1',
      now: h.clock.now,
      tier: 'free',
      inputs,
    });

    let rendered = 0;
    for (const adapter of achievementsSimulations) {
      for (const achievement of ['', 'first-words', 'chatterbox', 'gone']) {
        for (const extra of [
          {},
          { tier: 'bronze', rewards: 'pending', percent: 60 },
          { tier: 'diamond', rewards: 'failed', percent: 99 },
        ]) {
          const inputs = { achievement, ...extra };
          adapter.destination?.(config, inputs);
          if (adapter.build(config, scene(inputs)).ok) rendered += 1;
        }
      }
    }

    expect(rendered).toBeGreaterThan(achievementsSimulations.length);
    expect(snapshotOf(h.store)).toBe(before);
    expect(await h.voice.list(GUILD)).toEqual(voice);
    expect([h.rest.exchanges.length, h.published.length, h.scheduler.booked.length]).toEqual(
      counts,
    );
  });

  test('permission failure: without Manage Roles the reward fails naming it, without Send Messages the announcement fails naming the channel, and the unlock stays', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageRoles });
    const achievements = [
      single('first-words', 'First Words', 'messages.sent', 1, [
        { kind: 'add_role', roleId: REWARD_ROLE },
      ]),
    ];
    await h.configure({ achievements });

    await h.emit(h.message());

    expect(await h.unlocks(MEMBER)).toMatchObject([
      { achievementId: 'first-words', announceStatus: 'sent' },
    ]);
    const [reward] = await h.rewards(MEMBER, 'first-words');
    expect(reward).toMatchObject({
      status: 'failed',
      transient: false,
      errorCode: 'missing_permission',
    });
    expect(reward?.error).toContain('Manage Roles');
    expect(h.roleCalls()).toEqual([]);
    expect(h.sends(TEXT)).toHaveLength(1);

    h.botPermissions = BOT_PERMISSIONS;
    h.deny(ANNOUNCE, Permissions.SendMessages);
    await h.configure({
      announcement: { destination: 'channel', channelId: ANNOUNCE },
      achievements,
    });

    await h.emit(h.message({ authorId: OTHER }));

    const [earned] = await h.unlocks(OTHER);
    expect(earned).toMatchObject({ achievementId: 'first-words', announceStatus: 'failed' });
    expect(earned?.announceError).toContain('Send Messages');
    expect(earned?.announceError).toContain(`<#${ANNOUNCE}>`);
    expect(await h.rewards(OTHER, 'first-words')).toMatchObject([{ status: 'delivered' }]);
    expect(
      h.rest.exchanges.some(({ request }) => request.path === `/channels/${ANNOUNCE}/messages`),
    ).toBe(false);
  });

  test('reactions farming: remove and re-add, self, old message and the pair cap', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        single('crowd-favourite', 'Crowd Favourite', 'reactions.received', 6),
        single('generous', 'Generous', 'reactions.given', 7),
      ],
    });

    const posts = Array.from({ length: 6 }, (_, index) =>
      snowflakeAt(h.clock.now - MINUTE, index + 1),
    );
    const react = (reactorId: string, messageId: string, emoji?: string) =>
      h.emit(h.reaction({ reactorId, authorId: MEMBER, messageId, ...(emoji ? { emoji } : {}) }));
    const [first = '', ...others] = posts;

    await react(OTHER, first);
    await react(OTHER, first);
    await react(OTHER, first, '🔥');
    await react(MEMBER, first);
    await react(OTHER, snowflakeAt(h.clock.now - REACTION_MAX_AGE_MS - MINUTE));

    expect(await h.value(MEMBER, 'crowd-favourite', 'goal')).toBe(1);
    expect(await h.value(OTHER, 'generous', 'goal')).toBe(1);
    expect(await h.value(MEMBER, 'generous', 'goal')).toBe(0);

    for (const post of others) await react(OTHER, post);

    expect(await h.value(MEMBER, 'crowd-favourite', 'goal')).toBe(5);
    expect(await h.value(OTHER, 'generous', 'goal')).toBe(6);
    expect(await h.unlocks(MEMBER)).toEqual([]);

    await react(THIRD, others.at(-1) ?? first);

    expect(await h.value(MEMBER, 'crowd-favourite', 'goal')).toBe(6);
    expect(ids(await h.unlocks(MEMBER))).toEqual(['crowd-favourite']);
    expect(await h.unlocks(OTHER)).toEqual([]);
  });

  test('a departed member does not unlock', async () => {
    const h = harness();
    await h.configure({
      achievements: [
        single('rising-star', 'Rising Star', 'leveling.level', 5, [
          { kind: 'add_role', roleId: REWARD_ROLE },
        ]),
      ],
    });

    await h.emit(h.message());
    h.rest.leave(GUILD, MEMBER);
    await h.emit(h.memberLeft(MEMBER));
    expect(await h.store.facts(GUILD, MEMBER)).toMatchObject({ joinedAt: null, leftAt: T0 });

    h.advance(MINUTE);
    await h.emit(h.levelGained({ level: 5 }));

    expect(await h.unlocks(MEMBER)).toEqual([]);
    expect(h.roleCalls()).toEqual([]);
    expect(h.ofType('achievements.unlocked')).toEqual([]);
    expect(
      h.rest.exchanges.some(
        ({ request, status }) =>
          request.path === `/guilds/${GUILD}/members/${MEMBER}` && status === 404,
      ),
    ).toBe(true);

    await h.emit(h.levelGained({ userId: OTHER, level: 5 }));
    expect(ids(await h.unlocks(OTHER))).toEqual(['rising-star']);
  });

  test('the All-Rounder demo: messages, voice and a level unlock it, and one announcement lists the role and the XP as given', async () => {
    const h = harness();
    const allRounder: AchievementInput = {
      ...instantiatePreset('all_rounder', { random: seededRandom(7), roleId: REWARD_ROLE }),
      status: 'active',
    };
    await h.configure({ announcement: { message: REWARD_MESSAGE }, achievements: [allRounder] });
    const [messages = '', minutes = '', level = ''] = allRounder.requirements.map(({ id }) => id);

    for (let index = 0; index < 100; index++) {
      await h.tick(SECOND);
      await h.emit(h.message());
    }

    await h.emit(h.voiceUpdate({ channelId: VOICE }));
    await h.tick(60 * MINUTE, 10 * MINUTE);
    await h.emit(h.voiceUpdate({ channelId: null }));

    expect([
      await h.value(MEMBER, allRounder.id, messages),
      await h.value(MEMBER, allRounder.id, minutes),
    ]).toEqual([100, 60]);
    expect(await h.unlocks(MEMBER)).toEqual([]);

    await h.gainXp(MEMBER, 500, TEXT);

    expect(await h.unlocks(MEMBER)).toMatchObject([
      {
        achievementId: allRounder.id,
        tierId: 'single',
        originChannelId: TEXT,
        progress: { [messages]: 100, [minutes]: 60, [level]: 5 },
        announceStatus: 'sent',
      },
    ]);
    expect(await h.rewards(MEMBER, allRounder.id)).toMatchObject([
      { rewardKey: `add_role:${REWARD_ROLE}`, status: 'delivered' },
      { rewardKey: 'xp', amount: 250, status: 'delivered' },
    ]);
    expect(h.roleCalls()).toEqual([
      { method: 'PUT', guildId: GUILD, userId: MEMBER, roleId: REWARD_ROLE, status: 204 },
    ]);
    expect(h.rest.member(GUILD, MEMBER)?.roles).toContain(REWARD_ROLE);
    expect(h.leveling.requests.map(({ amount }) => amount)).toEqual([250]);
    expect(h.leveling.xpOf(GUILD, MEMBER)).toBe(750);
    expect(h.ofType('achievements.unlocked')).toHaveLength(1);

    const announced = h.sends(TEXT);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.body.content).toBe(
      `<@${MEMBER}> earned **All-Rounder**: <@&${REWARD_ROLE}> and 250 XP given`,
    );
  });
});
