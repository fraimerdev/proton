import { describe, expect, test } from 'bun:test';
import { collectAchievementUnlocked } from '../src/collect/achievements.ts';
import { collectApplicationAccepted } from '../src/collect/applications.ts';
import { chainOf, dayKey } from '../src/collect/common.ts';
import {
  collectDropClaimed,
  collectGiveawayCancelled,
  collectGiveawayDrawn,
  collectGiveawayEntered,
} from '../src/collect/giveaways.ts';
import {
  collectMemberJoined,
  collectMemberLeft,
  collectMemberUpdated,
} from '../src/collect/members.ts';
import { collectMessage } from '../src/collect/messages.ts';
import { collectReaction } from '../src/collect/reactions.ts';
import { collectStarboardPost } from '../src/collect/starboard.ts';
import { collectLevelGained, collectXpAwarded } from '../src/collect/xp.ts';
import { REACTIONS_GIVEN_DAILY_CAP, REACTIONS_PAIR_DAILY_CAP } from '../src/constants.ts';
import {
  achievement,
  CATEGORY,
  DAY,
  event,
  fixture,
  GUILD,
  GUILD_STATE,
  HOUR,
  harness,
  JOINED_AT,
  MEMBER,
  MINUTE,
  messagePayload,
  OTHER,
  PROTON,
  ROLE,
  SECOND,
  snowflakeAt,
  T0,
  TEXT,
  THREAD,
} from './collect-fakes.ts';

const MESSAGE_ID = '1400000000000000001';
const JOINED_MS = Date.parse(JOINED_AT);

describe('channel chain and day keys', () => {
  test('a thread reaches its channel and category; an unknown channel stands alone', () => {
    expect(chainOf(THREAD, GUILD_STATE)).toEqual({
      channelId: THREAD,
      parentId: TEXT,
      categoryId: CATEGORY,
    });
    expect(chainOf(TEXT, GUILD_STATE)).toEqual({
      channelId: TEXT,
      parentId: null,
      categoryId: CATEGORY,
    });
    expect(chainOf('500000000000000999', GUILD_STATE)).toEqual({
      channelId: '500000000000000999',
      parentId: null,
      categoryId: null,
    });
    expect(chainOf(THREAD, null)).toEqual({ channelId: THREAD, parentId: null, categoryId: null });
  });

  test('the day is the calendar day in the module time zone', () => {
    const lateUtc = Date.UTC(2026, 8, 14, 20, 0, 0);
    expect(dayKey(lateUtc, 'UTC')).toBe('2026-09-14');
    expect(dayKey(lateUtc, 'Asia/Tokyo')).toBe('2026-09-15');
    expect(dayKey(lateUtc, 'America/Los_Angeles')).toBe('2026-09-14');
  });
});

describe('message collector', () => {
  test('counts a member’s message and their first active day, with origin and roles', async () => {
    const h = harness();
    await collectMessage(
      h.ctx(),
      h.deps,
      event('message.created', messagePayload(), { id: 'message.created:1' }),
      h.engine,
    );

    expect(h.engine.processed).toHaveLength(1);
    expect(h.engine.processed[0]?.originChannelId).toBe(TEXT);
    expect(h.engine.processed[0]?.subjects?.get(MEMBER)).toEqual({
      roleIds: [ROLE],
      isMember: true,
      isBot: false,
    });
    expect(h.engine.records()).toMatchObject([
      {
        guildId: GUILD,
        userId: MEMBER,
        metric: 'messages',
        sourceKey: MESSAGE_ID,
        occurredAt: T0,
        amount: 1,
        channelId: TEXT,
        parentId: null,
        categoryId: CATEGORY,
        sourceModule: 'discord',
        causation: { kind: 'organic', rootId: 'message.created:1', depth: 0 },
      },
      { metric: 'active_days', sourceKey: `${MEMBER}:2026-09-14`, occurredAt: T0 },
    ]);
  });

  test('bots, webhooks, system messages and Proton’s own posts never count', async () => {
    const h = harness();
    const payloads = [
      messagePayload({ author: { id: OTHER, bot: true } }),
      messagePayload({ webhook_id: '800000000000000001' }),
      messagePayload({ type: 7 }),
      messagePayload({ author: { id: PROTON, bot: false } }),
    ];

    for (const payload of payloads) {
      await collectMessage(h.ctx(), h.deps, event('message.created', payload), h.engine);
    }

    expect(h.engine.processed).toEqual([]);
  });

  test('an excluded category, an excluded parent of a thread and ticket channels never count', async () => {
    const h = harness({ kinds: { [TEXT]: 'ticket' } });
    await collectMessage(h.ctx(), h.deps, event('message.created', messagePayload()), h.engine);
    await collectMessage(
      h.ctx(),
      h.deps,
      event('message.created', messagePayload({ channel_id: THREAD })),
      h.engine,
    );

    const excluded = harness();
    await collectMessage(
      excluded.ctx({ excludedChannelIds: [CATEGORY] }),
      excluded.deps,
      event('message.created', messagePayload()),
      excluded.engine,
    );
    await collectMessage(
      excluded.ctx({ excludedChannelIds: [TEXT] }),
      excluded.deps,
      event('message.created', messagePayload({ channel_id: THREAD })),
      excluded.engine,
    );

    expect(h.engine.processed).toEqual([]);
    expect(excluded.engine.processed).toEqual([]);
  });

  test('an excluded role stops counting but the join date is still kept', async () => {
    const h = harness();
    await collectMessage(
      h.ctx({ excludedRoleIds: [ROLE] }),
      h.deps,
      event('message.created', messagePayload()),
      h.engine,
    );

    expect(h.engine.processed).toEqual([]);
    expect(await h.store.facts(GUILD, MEMBER)).toMatchObject({
      joinedAt: JOINED_MS,
      premiumSince: null,
      leftAt: null,
    });
  });

  test('the cooldown blocks a second message but lets a redelivery of the first back in', async () => {
    const h = harness();
    const first = event('message.created', messagePayload({ id: 'm1' }), { id: 'first' });

    await collectMessage(h.ctx(), h.deps, first, h.engine);

    h.clock.now = T0 + 5 * SECOND;
    await collectMessage(
      h.ctx(),
      h.deps,
      event('message.created', messagePayload({ id: 'm2' }), { occurredAt: h.clock.now }),
      h.engine,
    );
    await collectMessage(h.ctx(), h.deps, first, h.engine);

    h.clock.now = T0 + 16 * SECOND;
    await collectMessage(
      h.ctx(),
      h.deps,
      event('message.created', messagePayload({ id: 'm3' }), { occurredAt: h.clock.now }),
      h.engine,
    );

    expect(h.engine.keys()).toEqual([
      ['messages:m1', `active_days:${MEMBER}:2026-09-14`],
      ['messages:m1'],
      ['messages:m3'],
    ]);
  });

  test('a failed evaluation leaves the active day to be recorded again on redelivery', async () => {
    const h = harness();
    const delivered = event('message.created', messagePayload());
    h.engine.failures = 1;

    await expect(collectMessage(h.ctx(), h.deps, delivered, h.engine)).rejects.toThrow(
      'the engine failed',
    );
    await collectMessage(h.ctx(), h.deps, delivered, h.engine);

    expect(h.engine.keys()).toEqual([
      [`messages:${MESSAGE_ID}`, `active_days:${MEMBER}:2026-09-14`],
    ]);
  });

  test('active days follow the module time zone', async () => {
    const h = harness();
    const late = Date.UTC(2026, 8, 14, 20, 0, 0);
    await collectMessage(
      h.ctx({ timezone: 'Asia/Tokyo' }),
      h.deps,
      event('message.created', messagePayload(), { occurredAt: late }),
      h.engine,
    );

    expect(h.engine.records('active_days')).toMatchObject([
      { sourceKey: `${MEMBER}:2026-09-15`, occurredAt: late },
    ]);
  });

  test('a day already marked is offered again once an achievement counting it goes live', async () => {
    const h = harness();
    const draft = achievement('regular', 'activity.active_days', {}, 'draft');
    const send = (id: string, status: 'draft' | 'active', at: number) =>
      collectMessage(
        h.ctx({ messageCooldown: '0s', achievements: [{ ...draft, status }] }),
        h.deps,
        event('message.created', messagePayload({ id }), { occurredAt: at }),
        h.engine,
      );

    await send('m1', 'draft', T0);
    await send('m2', 'draft', T0 + HOUR);
    await send('m3', 'active', T0 + 2 * HOUR);

    expect(h.engine.keys()).toEqual([
      ['messages:m1', `active_days:${MEMBER}:2026-09-14`],
      ['messages:m2'],
      ['messages:m3', `active_days:${MEMBER}:2026-09-14`],
    ]);
  });

  test('member facts are written once and again only when they change', async () => {
    const h = harness();
    let writes = 0;
    const upsert = h.store.upsertFacts.bind(h.store);
    h.store.upsertFacts = async (...args) => {
      writes++;
      return upsert(...args);
    };

    for (const id of ['a', 'b']) {
      await collectMessage(
        h.ctx(),
        h.deps,
        event('message.created', messagePayload({ id })),
        h.engine,
      );
      h.clock.now += 20 * SECOND;
    }
    expect(writes).toBe(1);

    const boosting = '2026-09-10T08:00:00.000000+00:00';
    await collectMessage(
      h.ctx(),
      h.deps,
      event(
        'message.created',
        messagePayload({
          id: 'c',
          member: { roles: [ROLE], joined_at: JOINED_AT, premium_since: boosting },
        }),
      ),
      h.engine,
    );
    expect(writes).toBe(2);
    expect(await h.store.facts(GUILD, MEMBER)).toMatchObject({
      joinedAt: JOINED_MS,
      premiumSince: Date.parse(boosting),
    });
  });

  test('without a cooldown every message counts, even with no limits port', async () => {
    const h = harness({ omit: ['limits'] });
    for (const id of ['a', 'b']) {
      await collectMessage(
        h.ctx({ messageCooldown: '0s' }),
        h.deps,
        event('message.created', messagePayload({ id })),
        h.engine,
      );
    }

    expect(h.engine.records('messages').map((record) => record.sourceKey)).toEqual(['a', 'b']);
  });

  test('with a cooldown and no limits port, messages are not counted and the log says why', async () => {
    const h = harness({ omit: ['limits'] });
    await collectMessage(h.ctx(), h.deps, event('message.created', messagePayload()), h.engine);

    expect(h.engine.keys()).toEqual([[`active_days:${MEMBER}:2026-09-14`]]);
    expect(h.logs.join('\n')).toContain('limits: new RedisLimits(moduleRedis)');
  });
});

describe('boost collector', () => {
  const boosting = '2026-09-10T08:00:00.000000+00:00';
  const boostingMs = Date.parse(boosting);

  test('a boost notice and a member update share one key, so the boost counts once', async () => {
    const h = harness();
    await collectMessage(
      h.ctx(),
      h.deps,
      event(
        'message.created',
        messagePayload({
          type: 8,
          content: '',
          member: { roles: [ROLE], joined_at: JOINED_AT, premium_since: boosting },
        }),
      ),
      h.engine,
    );
    await collectMemberUpdated(
      h.ctx(),
      h.deps,
      event('member.updated', {
        ...fixture('guildMemberUpdate'),
        user: { id: MEMBER, bot: false },
        premium_since: boosting,
      }),
      h.engine,
    );

    const [fromNotice, fromUpdate] = h.engine.records('boosts');
    expect(h.engine.records()).toHaveLength(2);
    expect(fromNotice).toMatchObject({
      userId: MEMBER,
      sourceKey: `${MEMBER}:${boostingMs}`,
      occurredAt: boostingMs,
      channelId: null,
    });
    expect(fromUpdate?.sourceKey).toBe(fromNotice?.sourceKey as string);
    expect(h.engine.processed.map((batch) => batch.originChannelId)).toEqual([TEXT, null]);

    if (!fromNotice || !fromUpdate) throw new Error('both boosts should have been collected');
    expect((await h.store.record(fromNotice, [], [])).fresh).toBe(true);
    expect((await h.store.record(fromUpdate, [], [])).fresh).toBe(false);
  });

  test('a notice without a boosting-since date and a member update without one count nothing', async () => {
    const h = harness();
    await collectMessage(
      h.ctx(),
      h.deps,
      event('message.created', messagePayload({ type: 9 })),
      h.engine,
    );
    await collectMemberUpdated(
      h.ctx(),
      h.deps,
      event('member.updated', fixture('guildMemberUpdate')),
      h.engine,
    );

    expect(h.engine.processed).toEqual([]);
    expect(await h.store.facts(GUILD, OTHER)).toMatchObject({ joinedAt: JOINED_MS });
  });
});

describe('reaction collector', () => {
  const recent = snowflakeAt(T0 - HOUR);

  function reaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...fixture('messageReactionAdd'), message_id: recent, ...overrides };
  }

  test('counts one given for the reactor and one received for the author', async () => {
    const h = harness();
    await collectReaction(
      h.ctx(),
      h.deps,
      event('reaction.added', reaction(), { id: 'reaction:1' }),
      h.engine,
    );

    expect(h.engine.records()).toMatchObject([
      {
        userId: OTHER,
        metric: 'reactions_given',
        sourceKey: `${recent}:${OTHER}`,
        channelId: TEXT,
        categoryId: CATEGORY,
      },
      { userId: MEMBER, metric: 'reactions_received', sourceKey: `${recent}:${OTHER}` },
    ]);
    expect(h.engine.processed[0]?.originChannelId).toBe(TEXT);
    expect(h.engine.processed[0]?.subjects?.get(OTHER)).toEqual({
      roleIds: [ROLE],
      isMember: true,
      isBot: false,
    });
  });

  test('bots, missing authors, self reactions, Proton’s messages and old messages never count', async () => {
    const h = harness();
    const bot = fixture('messageReactionAdd');
    const payloads = [
      reaction({ member: { ...(bot.member as object), user: { id: OTHER, bot: true } } }),
      reaction({ message_author_id: undefined }),
      reaction({ message_author_id: OTHER }),
      reaction({ message_author_id: PROTON }),
      reaction({ message_id: snowflakeAt(T0 - 8 * DAY) }),
    ];

    for (const payload of payloads) {
      await collectReaction(h.ctx(), h.deps, event('reaction.added', payload), h.engine);
    }

    expect(h.engine.processed).toEqual([]);
  });

  test('another emoji on the same message is skipped while a redelivery is re-run', async () => {
    const h = harness();
    const first = event('reaction.added', reaction(), { id: 'reaction:star' });

    await collectReaction(h.ctx(), h.deps, first, h.engine);
    await collectReaction(
      h.ctx(),
      h.deps,
      event('reaction.added', reaction({ emoji: { id: null, name: '🔥' } }), {
        id: 'reaction:fire',
      }),
      h.engine,
    );
    await collectReaction(h.ctx(), h.deps, first, h.engine);

    expect(h.engine.processed).toHaveLength(2);
    expect(h.engine.keys()[1]).toEqual(h.engine.keys()[0] as string[]);
  });

  test('daily caps: 50 given per member and 5 received from the same member', async () => {
    const h = harness();
    const total = REACTIONS_GIVEN_DAILY_CAP + 1;

    for (let index = 0; index < total; index++) {
      await collectReaction(
        h.ctx(),
        h.deps,
        event('reaction.added', reaction({ message_id: snowflakeAt(T0 - HOUR, index) })),
        h.engine,
      );
    }

    expect(h.engine.records('reactions_given')).toHaveLength(REACTIONS_GIVEN_DAILY_CAP);
    expect(h.engine.records('reactions_received')).toHaveLength(REACTIONS_PAIR_DAILY_CAP);
  });

  test('an excluded reactor gives nothing, but the author still receives', async () => {
    const h = harness();
    await collectReaction(
      h.ctx({ excludedRoleIds: [ROLE] }),
      h.deps,
      event('reaction.added', reaction()),
      h.engine,
    );

    expect(h.engine.records().map((record) => `${record.metric}:${record.userId}`)).toEqual([
      `reactions_received:${MEMBER}`,
    ]);
  });

  test('reactions in excluded or ticket channels never count', async () => {
    const h = harness({ kinds: { [TEXT]: 'ticket' } });
    await collectReaction(h.ctx(), h.deps, event('reaction.added', reaction()), h.engine);

    const excluded = harness();
    await collectReaction(
      excluded.ctx({ excludedChannelIds: [CATEGORY] }),
      excluded.deps,
      event('reaction.added', reaction()),
      excluded.engine,
    );

    expect(h.engine.processed).toEqual([]);
    expect(excluded.engine.processed).toEqual([]);
  });
});

describe('member collector', () => {
  test('a join keeps the join date, a leave marks the member gone, bots are ignored', async () => {
    const h = harness();
    await collectMemberJoined(h.ctx(), h.deps, event('member.joined', fixture('guildMemberAdd')));
    await collectMemberJoined(
      h.ctx(),
      h.deps,
      event('member.joined', fixture('guildMemberAddBot')),
    );

    expect(await h.store.facts(GUILD, OTHER)).toMatchObject({ joinedAt: JOINED_MS, leftAt: null });
    expect(await h.store.facts(GUILD, '100000000000000003')).toBeNull();

    await collectMemberLeft(
      h.ctx(),
      h.deps,
      event('member.left', { guild_id: GUILD, user: { id: OTHER } }, { occurredAt: T0 + HOUR }),
    );
    expect(await h.store.facts(GUILD, OTHER)).toMatchObject({ joinedAt: null, leftAt: T0 + HOUR });

    const rejoined = '2026-09-14T13:00:00.000000+00:00';
    await collectMemberJoined(
      h.ctx(),
      h.deps,
      event('member.joined', { ...fixture('guildMemberAdd'), joined_at: rejoined }),
    );
    expect(await h.store.facts(GUILD, OTHER)).toMatchObject({
      joinedAt: Date.parse(rejoined),
      leftAt: null,
    });
    expect(h.engine.processed).toEqual([]);
  });
});

describe('starboard collector', () => {
  const post = {
    guildId: GUILD,
    sourceMessageId: '1400000000000000777',
    sourceChannelId: TEXT,
    authorId: MEMBER,
    authorBot: false,
    boardMessageId: '1400000000000000778',
    starCount: 3,
    activityAt: T0 - SECOND,
  };

  test('counts the source message for its author in its channel', async () => {
    const h = harness();
    await collectStarboardPost(h.ctx(), h.deps, event('starboard.message_posted', post), h.engine);

    expect(h.engine.records()).toMatchObject([
      {
        userId: MEMBER,
        metric: 'starboard_messages',
        sourceKey: post.sourceMessageId,
        occurredAt: post.activityAt,
        channelId: TEXT,
        categoryId: CATEGORY,
        sourceModule: 'starboard',
      },
    ]);
    expect(h.engine.processed[0]?.originChannelId).toBe(TEXT);
  });

  test('bots’ messages, excluded channels and other servers’ posts never count', async () => {
    const h = harness();
    await collectStarboardPost(
      h.ctx(),
      h.deps,
      event('starboard.message_posted', { ...post, authorBot: true }),
      h.engine,
    );
    await collectStarboardPost(
      h.ctx({ excludedChannelIds: [TEXT] }),
      h.deps,
      event('starboard.message_posted', post),
      h.engine,
    );
    await collectStarboardPost(
      h.ctx(),
      h.deps,
      event('starboard.message_posted', { ...post, guildId: '900000000000000002' }),
      h.engine,
    );

    expect(h.engine.processed).toEqual([]);
  });
});

describe('giveaway collector', () => {
  function base(giveawayId: string) {
    return {
      guildId: GUILD,
      giveawayId,
      shortCode: null,
      title: 'Nitro',
      channelId: TEXT,
      hostId: OTHER,
    };
  }

  function drawn(giveawayId: string, winnerIds: string[]) {
    return {
      ...base(giveawayId),
      drawNumber: 1,
      drawnById: OTHER,
      winnerIds,
      entrantCount: 1,
      totalEntries: 1,
      disqualified: 0,
      degradedProviders: [],
      seed: 'seed',
      snapshotHash: 'hash',
    };
  }

  async function enter(h: ReturnType<typeof harness>, giveawayId: string, userId: string) {
    await collectGiveawayEntered(
      h.ctx(),
      h.deps,
      event('giveaways.entered', {
        ...base(giveawayId),
        userId,
        totalEntries: 1,
        activityAt: T0 - HOUR,
      }),
      h.engine,
    );
    const pending = h.engine.processed.at(-1)?.records[0];
    if (!pending) throw new Error('the entry should have been collected');
    await h.store.record(pending, [], []);
    return pending;
  }

  test('an entry waits for the draw, which counts it along with the winners', async () => {
    const h = harness();
    const pending = await enter(h, 'gw1', MEMBER);

    expect(pending).toMatchObject({
      metric: 'giveaways_entered',
      sourceKey: `gw1:${MEMBER}`,
      groupKey: 'giveaway:gw1',
      pending: true,
      occurredAt: T0 - HOUR,
    });

    await collectGiveawayDrawn(
      h.ctx(),
      h.deps,
      event('giveaways.ended', drawn('gw1', [OTHER])),
      h.engine,
    );

    expect(h.engine.processed.at(-1)?.originChannelId).toBe(TEXT);
    expect(h.engine.processed.at(-1)?.records).toMatchObject([
      {
        userId: MEMBER,
        metric: 'giveaways_entered',
        sourceKey: `gw1:${MEMBER}`,
        pending: false,
        sourceModule: 'giveaways',
      },
      { userId: OTHER, metric: 'giveaways_won', sourceKey: `gw1:${OTHER}`, pending: false },
    ]);
  });

  test('a reroll re-runs the entries and adds the new winner; a drop counts as a win', async () => {
    const h = harness();
    await enter(h, 'gw1', MEMBER);

    await collectGiveawayDrawn(
      h.ctx(),
      h.deps,
      event('giveaways.rerolled', { ...drawn('gw1', [MEMBER]), replacedIds: [OTHER] }),
      h.engine,
    );
    await collectDropClaimed(
      h.ctx(),
      h.deps,
      event('giveaways.drop_claimed', { ...base('drop1'), userId: OTHER, activityAt: T0 }),
      h.engine,
    );

    expect(h.engine.keys().slice(1)).toEqual([
      [`giveaways_entered:gw1:${MEMBER}`, `giveaways_won:gw1:${MEMBER}`],
      [`giveaways_won:drop1:${OTHER}`],
    ]);
  });

  test('a cancelled giveaway voids its entries, so a later draw counts none', async () => {
    const h = harness();
    await enter(h, 'gw2', MEMBER);

    await collectGiveawayCancelled(
      h.ctx(),
      h.deps,
      event('giveaways.cancelled', { ...base('gw2'), actorId: OTHER, entrantCount: 1 }),
    );
    await collectGiveawayDrawn(
      h.ctx(),
      h.deps,
      event('giveaways.ended', drawn('gw2', [])),
      h.engine,
    );

    expect(h.engine.processed).toHaveLength(1);
  });
});

describe('leveling collector', () => {
  const award = {
    guildId: GUILD,
    userId: MEMBER,
    amount: 20,
    source: 'message',
    channelId: TEXT,
    activityAt: T0 - 500,
    xp: 120,
    level: 1,
    causation: { kind: 'organic', rootId: 'message.created:9', depth: 0 },
  };

  test('XP awards count at the activity time with their source and a deeper causation', async () => {
    const h = harness();
    const id = `xp.awarded:${GUILD}:message.created:9`;
    await collectXpAwarded(h.ctx(), h.deps, event('xp.awarded', award, { id }), h.engine);
    await collectXpAwarded(
      h.ctx(),
      h.deps,
      event('xp.awarded', { ...award, source: 'voice', channelId: undefined }),
      h.engine,
    );

    expect(h.engine.records()).toMatchObject([
      {
        metric: 'activity_xp',
        sourceKey: id,
        occurredAt: T0 - 500,
        amount: 20,
        xpSource: 'message',
        channelId: TEXT,
        sourceModule: 'leveling',
        causation: { kind: 'organic', rootId: 'message.created:9', depth: 1 },
      },
      { xpSource: 'voice', channelId: null },
    ]);
    expect(h.engine.processed.map((batch) => batch.originChannelId)).toEqual([TEXT, null]);
  });

  test('XP earned in an excluded channel is skipped and long keys are bounded', async () => {
    const h = harness();
    await collectXpAwarded(
      h.ctx({ excludedChannelIds: [CATEGORY] }),
      h.deps,
      event('xp.awarded', award),
      h.engine,
    );
    expect(h.engine.processed).toEqual([]);

    await collectXpAwarded(
      h.ctx(),
      h.deps,
      event('xp.awarded', award, { id: `xp.awarded:${GUILD}:grant:${'x'.repeat(220)}` }),
      h.engine,
    );
    expect(h.engine.records()[0]?.sourceKey.length).toBeLessThanOrEqual(200);
  });

  test('a level-up re-evaluates only active level achievements, with the new level and its own time', async () => {
    const h = harness();
    const levelledAt = T0 - MINUTE;
    const gained = {
      guildId: GUILD,
      userId: MEMBER,
      level: 5,
      previousLevel: 4,
      xp: 900,
      source: 'message',
      channelId: TEXT,
      causation: { kind: 'reward', rootId: 'root', depth: 2 },
    };
    const achievements = [
      achievement('rising', 'leveling.level'),
      achievement('drafted', 'leveling.level', {}, 'draft'),
      achievement('chatter', 'messages.sent'),
    ];

    await collectLevelGained(
      h.ctx({ achievements }),
      h.deps,
      event('xp.level_gained', gained, { occurredAt: levelledAt }),
      h.engine,
    );
    await collectLevelGained(
      h.ctx({ achievements: [achievement('chatter', 'messages.sent')] }),
      h.deps,
      event('xp.level_gained', gained, { occurredAt: levelledAt }),
      h.engine,
    );

    expect(h.engine.evaluated).toEqual([
      {
        userId: MEMBER,
        achievementIds: ['rising'],
        stateValues: { level: 5 },
        originChannelId: TEXT,
        occurredAt: levelledAt,
        causation: { kind: 'reward', rootId: 'root', depth: 3 },
      },
    ]);
  });
});

describe('application collector', () => {
  const accepted = {
    guildId: GUILD,
    applicationId: '01J9ZK4N7Q2X5V8B3C6D9F0G1H',
    number: 12,
    formId: 'moderator',
    formName: 'Moderator Application',
    versionId: '01J9ZK4N7Q2X5V8B3C6D9F0G1J',
    applicantId: MEMBER,
    actorId: OTHER,
    revision: 3,
    status: 'accepted',
    occurredAt: T0 - SECOND,
  };

  test('counts the application once for the applicant, never in a channel', async () => {
    const h = harness();
    await collectApplicationAccepted(
      h.ctx(),
      h.deps,
      event('applications.accepted', accepted),
      h.engine,
    );

    expect(h.engine.records()).toMatchObject([
      {
        userId: MEMBER,
        metric: 'applications_accepted',
        sourceKey: accepted.applicationId,
        occurredAt: accepted.occurredAt,
        channelId: null,
        parentId: null,
        categoryId: null,
        sourceModule: 'applications',
        causation: { kind: 'organic', depth: 0 },
      },
    ]);
    expect(h.engine.processed[0]?.originChannelId).toBeNull();
  });

  test('a reopened and accepted-again application keeps the same key, so it counts once', async () => {
    const h = harness();
    await collectApplicationAccepted(
      h.ctx(),
      h.deps,
      event('applications.accepted', accepted),
      h.engine,
    );
    await collectApplicationAccepted(
      h.ctx(),
      h.deps,
      event('applications.accepted', { ...accepted, revision: 7, occurredAt: T0 }),
      h.engine,
    );

    const keys = h.engine.records().map((record) => `${record.metric}:${record.sourceKey}`);
    expect(new Set(keys)).toEqual(new Set([`applications_accepted:${accepted.applicationId}`]));
  });

  test('another server’s, another status’s and an unreadable payload never count', async () => {
    const h = harness();
    await collectApplicationAccepted(
      h.ctx(),
      h.deps,
      event('applications.accepted', { ...accepted, guildId: '900000000000000002' }),
      h.engine,
    );
    await collectApplicationAccepted(
      h.ctx(),
      h.deps,
      event('applications.accepted', { ...accepted, status: 'rejected' }),
      h.engine,
    );
    await collectApplicationAccepted(
      h.ctx(),
      h.deps,
      event('applications.accepted', { ...accepted, applicantId: 'someone' }),
      h.engine,
    );

    expect(h.engine.processed).toEqual([]);
    expect(h.logs).toHaveLength(2);
  });
});

describe('achievement collector', () => {
  test('an unlock re-evaluates collectors and the achievements that name it', async () => {
    const h = harness();
    const achievements = [
      achievement('chatter', 'messages.sent'),
      achievement('collector', 'achievements.earned'),
      achievement('follow', 'achievements.unlocked', {
        achievementId: 'chatter',
        tierId: 'single',
      }),
      achievement('elsewhere', 'achievements.unlocked', { achievementId: 'someone' }),
    ];

    await collectAchievementUnlocked(
      h.ctx({ achievements }),
      h.deps,
      event('achievements.unlocked', {
        guildId: GUILD,
        userId: MEMBER,
        achievementId: 'chatter',
        tierId: 'single',
        generation: 0,
        unlockedAt: T0,
        final: true,
        originChannelId: TEXT,
        causation: { kind: 'organic', rootId: 'message.created:1', depth: 1 },
      }),
      h.engine,
    );

    expect(h.engine.evaluated).toEqual([
      {
        userId: MEMBER,
        achievementIds: ['collector', 'follow'],
        originChannelId: TEXT,
        occurredAt: T0,
        causation: { kind: 'organic', rootId: 'message.created:1', depth: 2 },
      },
    ]);
  });
});
