import { describe, expect, test } from 'bun:test';
import type { BadgeCard } from '@proton/cards/design';
import { DM_CLOSED } from '../src/announce.ts';
import type { AchievementInput, AchievementsConfigInput } from '../src/config.ts';
import type { MemberLookup } from '../src/deps.ts';
import { DAY_MS, processRecords } from '../src/engine.ts';
import { createScheduledHandlers } from '../src/jobs.ts';
import { CHANNEL, GUILD, OTHER_CHANNEL, ROLE, T0, USER } from './contracts.ts';
import { DM_CHANNEL, failure, harness, subjects } from './fakes.ts';

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

const CLIMBER: AchievementInput = {
  id: 'climber',
  name: 'Climber',
  kind: 'tiered',
  status: 'active',
  requirements: [{ id: 'messages', trigger: 'messages.sent' }],
  tiers: [
    { id: 'bronze', targets: { messages: 5 } },
    { id: 'silver', targets: { messages: 10 } },
  ],
  almostThere: { enabled: true, percent: 80 },
};

const EMBED_MESSAGE = {
  content: '',
  embeds: [{ title: '{achievement.name}' }],
  components: [],
  mentions: { everyone: false, roles: false, users: true },
  v2: [],
};

const MEMBER_MESSAGE = {
  content: '{user.role_mentions}|{user.role_count}|{user.joined_at}|{user.is_boosting}',
  embeds: [],
  components: [],
  mentions: { everyone: false, roles: false, users: true },
  v2: [],
};

type Harness = ReturnType<typeof harness>;

async function earn(
  config: AchievementsConfigInput,
  options: { origin?: string | null; deps?: Parameters<typeof harness>[1] } = {},
): Promise<Harness> {
  const h = harness(config, options.deps ?? {});
  await processRecords(h.ctx, h.deps, {
    records: [h.message(1)],
    subjects: subjects(),
    originChannelId: options.origin === undefined ? CHANNEL : options.origin,
  });
  return h;
}

async function unlockOf(h: Harness) {
  const [row] = await h.store.unlocksOf(GUILD, USER);
  return row;
}

function payloadOf(h: Harness, index = 0): Record<string, unknown> {
  return (h.executor.of('send')[index]?.payload ?? {}) as Record<string, unknown>;
}

describe('unlock announcements', () => {
  test('no origin channel falls back to a direct message with pings off', async () => {
    const h = await earn(
      { announcement: { destination: 'current', fallback: 'dm' }, achievements: [GIFTED] },
      { origin: null },
    );
    const row = await unlockOf(h);

    expect(h.executor.of('create_dm')).toEqual([
      expect.objectContaining({
        payload: { userId: USER },
        idempotencyKey: `achievements:${GUILD}:announce:${row?.announceGroup}:dm-open:1`,
      }),
    ]);
    expect(payloadOf(h)).toMatchObject({
      channelId: DM_CHANNEL,
      directMessage: true,
      allowedMentions: { parse: [] },
    });
    expect(h.executor.of('send')[0]?.record).toBe(false);
    expect(row?.announceStatus).toBe('sent');
  });

  test('no origin channel and no fallback skips with the reason', async () => {
    const h = await earn({ achievements: [GIFTED] }, { origin: null });
    const row = await unlockOf(h);

    expect(h.executor.of('send')).toEqual([]);
    expect(row).toMatchObject({ announceStatus: 'skipped' });
    expect(row?.announceError).toContain('No channel to post in');
  });

  test('a refused origin channel is tried once more on the fallback channel', async () => {
    const h = harness({
      announcement: { fallback: 'channel', fallbackChannelId: OTHER_CHANNEL },
      achievements: [GIFTED],
    });
    h.executor.on(
      ({ kind, payload }) =>
        kind === 'send' && (payload as { channelId: string }).channelId === CHANNEL,
      failure('discord_403', 'Discord says I’m missing a permission.', 50013),
    );

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    const row = await unlockOf(h);
    const sends = h.executor.of('send');
    expect(sends.map(({ payload }) => (payload as { channelId: string }).channelId)).toEqual([
      CHANNEL,
      OTHER_CHANNEL,
    ]);
    expect(sends[1]?.idempotencyKey).toBe(
      `achievements:${GUILD}:announce:${row?.announceGroup}:1:fallback`,
    );
    expect(row?.announceStatus).toBe('sent');
  });

  test('closed direct messages fail with plain wording and the unlock stands', async () => {
    const h = harness({ announcement: { destination: 'dm' }, achievements: [GIFTED] });
    h.executor.on(
      ({ kind, payload }) =>
        kind === 'send' && (payload as { directMessage?: boolean }).directMessage === true,
      failure('discord_403', "That user doesn't accept direct messages from Proton.", 50007),
    );

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    const row = await unlockOf(h);
    expect(row).toMatchObject({ announceStatus: 'failed', announceError: DM_CLOSED });
    expect((await h.store.rewardsFor(GUILD, USER, 'gifted', 0))[0]?.status).toBe('delivered');
  });

  test('an achievement set not to announce is skipped', async () => {
    const h = await earn({ achievements: [{ ...GIFTED, announcement: { mode: 'off' } }] });
    const row = await unlockOf(h);

    expect(h.executor.of('send')).toEqual([]);
    expect(row).toMatchObject({
      announceStatus: 'skipped',
      announceError: 'Announcements are off for this achievement.',
    });
  });

  test('attaches the badge and points the first embed’s thumbnail at it', async () => {
    const cards: BadgeCard[] = [];
    const h = harness(
      {
        announcement: { message: EMBED_MESSAGE },
        achievements: [{ ...GIFTED, badge: { assetId: 'abcdef0123' } }],
      },
      {
        renderBadge: async (card) => {
          cards.push(card);
          return new Uint8Array([137, 80, 78, 71]);
        },
      },
    );
    await h.store.putBadge(GUILD, {
      assetId: 'abcdef0123',
      contentType: 'image/png',
      base64: 'iVBORw0KGgo=',
      byteSize: 8,
      uploadedBy: USER,
      uploadedAt: h.clock.now,
    });

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    expect(cards).toEqual([
      {
        kind: 'badge',
        shape: 'circle',
        colour: '#2a8af7',
        image: 'data:image/png;base64,iVBORw0KGgo=',
      },
    ]);

    const payload = payloadOf(h) as {
      files?: Array<{ filename: string }>;
      embeds?: Array<{ title?: string; thumbnail?: { url: string } }>;
    };
    expect(payload.files?.map(({ filename }) => filename)).toEqual(['badge.png']);
    expect(payload.embeds?.[0]).toMatchObject({
      title: 'Gifted',
      thumbnail: { url: 'attachment://badge.png' },
    });
  });

  test('a badge that fails to render is left out', async () => {
    const h = await earn(
      { achievements: [GIFTED] },
      {
        deps: {
          renderBadge: async () => {
            throw new Error('satori crashed');
          },
        },
      },
    );

    expect(payloadOf(h).files).toBeUndefined();
    expect((await unlockOf(h))?.announceStatus).toBe('sent');
  });

  test('a transient failure goes back to pending and the sweep retries under a new key', async () => {
    const h = harness({ achievements: [GIFTED] });
    h.executor.on(
      ({ kind }) => kind === 'send',
      failure('discord_503', 'Discord had a problem.'),
      1,
    );

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    let row = await unlockOf(h);
    expect(row).toMatchObject({
      announceStatus: 'pending',
      announceError: 'Discord had a problem.',
    });

    await createScheduledHandlers(h.deps).sweep({}, h.ctx);
    row = await unlockOf(h);

    expect(row?.announceStatus).toBe('sent');
    expect(
      h.executor.of('send').map(({ idempotencyKey }) => idempotencyKey.split(':').at(-1)),
    ).toEqual(['1', '2']);
  });

  test('a duplicate send stays pending until its lease runs out', async () => {
    const h = harness({ achievements: [GIFTED] });
    h.executor.on(({ kind }) => kind === 'send', { status: 'skipped_duplicate' }, 1);

    await processRecords(h.ctx, h.deps, {
      records: [h.message(1)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });

    await createScheduledHandlers(h.deps).sweep({}, h.ctx);
    expect((await unlockOf(h))?.announceStatus).toBe('pending');

    h.advance(61_000);
    await createScheduledHandlers(h.deps).sweep({}, h.ctx);
    expect((await unlockOf(h))?.announceStatus).toBe('sent');
    expect(h.executor.of('send')).toHaveLength(2);
  });
});

describe('member placeholders', () => {
  function lookup(asked: string[], answer: MemberLookup | null) {
    return {
      memberFacts: async (_guildId: string, userId: string) => {
        asked.push(userId);
        return answer;
      },
    };
  }

  test('what they have in this server is read and filled in', async () => {
    const asked: string[] = [];
    const h = await earn(
      { announcement: { message: MEMBER_MESSAGE }, achievements: [GIFTED] },
      {
        deps: lookup(asked, {
          roleIds: [ROLE],
          bot: false,
          joinedAt: T0 - DAY_MS,
          premiumSince: T0,
        }),
      },
    );

    expect(asked).toEqual([USER]);
    expect(payloadOf(h).content).toBe(`<@&${ROLE}>|1|<t:${(T0 - DAY_MS) / 1000}:f>|Yes`);
  });

  test('a member who has left leaves them unread, and the announcement still goes out', async () => {
    const asked: string[] = [];
    const h = await earn(
      { announcement: { message: MEMBER_MESSAGE }, achievements: [GIFTED] },
      { deps: lookup(asked, null) },
    );

    expect(asked).toEqual([USER]);
    expect(payloadOf(h).content).toBe('|||');
    expect((await unlockOf(h))?.announceStatus).toBe('sent');
  });

  test('a message that asks for none of them reads nothing', async () => {
    const asked: string[] = [];
    const h = await earn({ achievements: [GIFTED] }, { deps: lookup(asked, null) });

    expect(asked).toEqual([]);
    expect((await unlockOf(h))?.announceStatus).toBe('sent');
  });
});

describe('almost there', () => {
  async function send(h: Harness, index: number): Promise<void> {
    await processRecords(h.ctx, h.deps, {
      records: [h.message(index)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });
  }

  test('reminds once per tier by direct message and respects the cooldown', async () => {
    const h = harness({ achievements: [CLIMBER] });

    for (let index = 1; index <= 3; index++) await send(h, index);
    expect(h.executor.of('send')).toEqual([]);

    await send(h, 4);
    const reminders = () =>
      h.executor.of('send').filter(({ idempotencyKey }) => idempotencyKey.endsWith(':almost'));

    expect(reminders()).toEqual([
      expect.objectContaining({
        record: false,
        idempotencyKey: `achievements:${GUILD}:${USER}:climber:0:bronze:almost`,
        payload: expect.objectContaining({ channelId: DM_CHANNEL, directMessage: true }),
      }),
    ]);
    expect(
      String((reminders()[0]?.payload as { content?: string } | undefined)?.content),
    ).toContain('4 / 5 messages');

    await send(h, 5);
    for (let index = 6; index <= 8; index++) await send(h, index);
    expect(reminders()).toHaveLength(1);

    h.advance(DAY_MS + 1);
    await send(h, 9);
    expect(reminders().map(({ idempotencyKey }) => idempotencyKey.split(':').at(-2))).toEqual([
      'bronze',
      'silver',
    ]);
  });

  test('stays quiet while announcements are suppressed', async () => {
    const h = harness({ achievements: [CLIMBER] });

    for (let index = 1; index <= 4; index++) {
      await processRecords(h.ctx, h.deps, {
        records: [h.message(index)],
        subjects: subjects(),
        originChannelId: CHANNEL,
        announce: 'suppressed',
      });
    }

    expect(h.executor.of('send')).toEqual([]);
    const [state] = await h.store.memberStates(GUILD, USER, ['climber']);
    expect(state?.almostNotified).toEqual([]);
  });
});
