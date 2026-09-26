import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  DISCORD_EPOCH_MS,
  type EventType,
  encodeCustomId,
  type ProtonEvent,
  ProviderRegistry,
  STATUS_ERROR_COLOUR,
  STATUS_SUCCESS_COLOUR,
} from '@proton/core';
import { giveawaysConfigSchema, MODULE_ID } from '../src/config.ts';
import type { GiveawaysDeps } from '../src/deps.ts';
import { createGiveawaysModule } from '../src/index.ts';
import { handleEnter } from '../src/interactions.ts';
import { ENTER_ACTION, LEAVE_ACTION } from '../src/message.ts';
import type { Ctx } from '../src/perform.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const CHANNEL = '500000000000000000';
const HOST = '400000000000000001';
const APPLICATION = '800000000000000001';
const MEMBER = '400000000000000301';
const RIVAL = '400000000000000302';
const ROLE_A = '600000000000000000';
const NOW = new Date('2026-09-18T12:00:00.000Z');

interface Published {
  type: EventType;
  key: string;
  payload: unknown;
}

function pressId(second: number): string {
  return String(BigInt(NOW.getTime() + second * 1_000 - DISCORD_EPOCH_MS) << 22n);
}

function press(
  action: string,
  interactionId: string,
  userId = MEMBER,
  giveawayId = 'g1',
): ProtonEvent {
  const encoded = encodeCustomId(MODULE_ID, action, giveawayId);
  if (!encoded.ok) throw new Error(encoded.humanReason);

  return {
    id: `interaction.component:${interactionId}`,
    type: 'interaction.component',
    guildId: GUILD,
    occurredAt: NOW.getTime() + 250,
    payload: {
      id: interactionId,
      token: `token-${interactionId}`,
      type: 3,
      application_id: APPLICATION,
      guild_id: GUILD,
      channel_id: CHANNEL,
      member: {
        user: { id: userId, avatar: 'a1b2c3' },
        roles: [ROLE_A],
        joined_at: '2024-01-01T00:00:00.000Z',
      },
      data: { custom_id: encoded.customId, component_type: 2 },
    },
  } as unknown as ProtonEvent;
}

async function harness(over: Partial<CreateGiveawayInput> = {}) {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    shortCode: '7X29',
    endsAt: new Date(NOW.getTime() + 60_000),
    createdBy: HOST,
    ...over,
  });

  const requests: ActionRequest[] = [];
  const published: Published[] = [];
  const warnings: string[] = [];
  const bus = { failures: 0 };

  const ctx: Ctx = {
    guildId: GUILD,
    config: { ...giveawaysConfigSchema.parse({}), enabled: true },
    executor: {
      async execute(request) {
        requests.push(request);
        return { status: 'executed' };
      },
    },
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    },
    async publish(type, key, payload) {
      if (bus.failures > 0) {
        bus.failures -= 1;
        throw new Error('the bus is unreachable');
      }
      published.push({ type, key, payload });
    },
  };

  const deps: GiveawaysDeps = {
    store,
    providers: new ProviderRegistry(),
    applicationId: APPLICATION,
    now: () => NOW.getTime() + 30_000,
  };

  async function answer(event: ProtonEvent) {
    expect(await handleEnter(event, ctx, deps)).toBe('answered');

    const token = (event.payload as { token: string }).token;
    const followUps = requests.filter(
      (request) =>
        request.kind === 'interaction_followup' &&
        (request.payload as { interactionToken?: string }).interactionToken === token,
    );
    const embed = (
      followUps.at(-1)?.payload as { embeds?: { description: string; color: number }[] }
    )?.embeds?.[0];
    if (!embed) throw new Error(`no answer to ${event.id}`);

    return embed;
  }

  return { store, published, warnings, bus, answer };
}

const SUBJECT = {
  guildId: GUILD,
  giveawayId: 'g1',
  shortCode: '7X29',
  title: 'A prize',
  channelId: CHANNEL,
  hostId: HOST,
};

describe('giveaways.entered', () => {
  test('the manifest declares both new events', () => {
    expect(createGiveawaysModule().emits).toEqual(
      expect.arrayContaining(['giveaways.entered', 'giveaways.drop_claimed']),
    );
  });

  test('an entry publishes who entered, with how many entries, at the press’s delivery time', async () => {
    const { published, answer } = await harness();

    const event = press(ENTER_ACTION, pressId(1));
    expect((await answer(event)).color).toBe(STATUS_SUCCESS_COLOUR);

    expect(published).toEqual([
      {
        type: 'giveaways.entered',
        key: `giveaways:g1:entered:${MEMBER}`,
        payload: { ...SUBJECT, userId: MEMBER, totalEntries: 1, activityAt: event.occurredAt },
      },
    ]);
  });

  test('a redelivered press publishes again under the same key', async () => {
    const { store, published, answer } = await harness();

    await answer(press(ENTER_ACTION, pressId(1)));
    await answer(press(ENTER_ACTION, pressId(1)));

    expect(await store.entrantCount('g1')).toBe(1);
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);
  });

  test('a member already in who presses again is published under the same key', async () => {
    const { published, answer } = await harness();

    await answer(press(ENTER_ACTION, pressId(1)));
    expect((await answer(press(ENTER_ACTION, pressId(2)))).color).toBe(STATUS_ERROR_COLOUR);

    expect(published.map((event) => [event.type, event.key])).toEqual([
      ['giveaways.entered', `giveaways:g1:entered:${MEMBER}`],
      ['giveaways.entered', `giveaways:g1:entered:${MEMBER}`],
    ]);
  });

  test('a publish the bus refuses is warned about and the member is still entered', async () => {
    const { store, published, warnings, bus, answer } = await harness();

    bus.failures = 1;
    expect((await answer(press(ENTER_ACTION, pressId(1)))).color).toBe(STATUS_SUCCESS_COLOUR);

    expect(await store.entrantCount('g1')).toBe(1);
    expect(published).toEqual([]);
    expect(warnings).toEqual([
      `Giveaways could not publish giveaways.entered (giveaways:g1:entered:${MEMBER}), so ` +
        'Achievements will not count it: the bus is unreachable',
    ]);
  });

  test('a leave, a superseded press and a closed giveaway publish nothing', async () => {
    const { store, published, answer } = await harness();

    await answer(press(LEAVE_ACTION, pressId(1)));
    await store.enter({
      giveawayId: 'g1',
      userId: MEMBER,
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
      pressedAt: new Date(NOW.getTime() + 2_000),
    });
    await store.leave('g1', MEMBER, new Date(NOW.getTime() + 4_000));
    await answer(press(ENTER_ACTION, pressId(3)));
    await store.pause(GUILD, 'g1', HOST, null, new Date(NOW.getTime() + 5_000));
    await answer(press(ENTER_ACTION, pressId(6), RIVAL));

    expect(published).toEqual([]);
  });

  test('a blacklisted member publishes nothing', async () => {
    const { store, published, answer } = await harness();
    await store.addBlacklist(GUILD, {
      subjectType: 'user',
      subjectId: MEMBER,
      addedBy: HOST,
      reason: null,
    });

    await answer(press(ENTER_ACTION, pressId(1)));

    expect(published).toEqual([]);
  });
});

describe('giveaways.drop_claimed', () => {
  test('the member who wins a drop is published, and nobody after them', async () => {
    const { published, answer } = await harness({ entryMethod: 'drop' });

    const won = press(ENTER_ACTION, pressId(1));
    expect((await answer(won)).color).toBe(STATUS_SUCCESS_COLOUR);
    expect((await answer(press(ENTER_ACTION, pressId(2), RIVAL))).color).toBe(STATUS_ERROR_COLOUR);

    expect(published).toEqual([
      {
        type: 'giveaways.drop_claimed',
        key: `giveaways:g1:drop:${MEMBER}`,
        payload: { ...SUBJECT, userId: MEMBER, activityAt: won.occurredAt },
      },
    ]);
  });

  test('the winner’s own press, redelivered, publishes again under the same key', async () => {
    const { store, published, answer } = await harness({ entryMethod: 'drop' });

    const won = press(ENTER_ACTION, pressId(1));
    expect((await answer(won)).color).toBe(STATUS_SUCCESS_COLOUR);
    expect((await answer(won)).color).toBe(STATUS_SUCCESS_COLOUR);

    expect(store.winRows.map((row) => row.userId)).toEqual([MEMBER]);
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);
    expect(published[0]).toEqual({
      type: 'giveaways.drop_claimed',
      key: `giveaways:g1:drop:${MEMBER}`,
      payload: { ...SUBJECT, userId: MEMBER, activityAt: won.occurredAt },
    });
  });

  test('a drop win whose publish the bus refuses is warned about and still won', async () => {
    const { store, published, warnings, bus, answer } = await harness({ entryMethod: 'drop' });

    bus.failures = 1;
    expect((await answer(press(ENTER_ACTION, pressId(1)))).color).toBe(STATUS_SUCCESS_COLOUR);

    expect(store.winRows.map((row) => row.userId)).toEqual([MEMBER]);
    expect(published).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(
      `Giveaways could not publish giveaways.drop_claimed (giveaways:g1:drop:${MEMBER})`,
    );
  });
});
