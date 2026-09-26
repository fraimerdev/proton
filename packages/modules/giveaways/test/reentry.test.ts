import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  DISCORD_EPOCH_MS,
  encodeCustomId,
  type MemberContext,
  OptionType,
  type ProtonEvent,
  ProviderRegistry,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import { giveawaysConfigSchema, MODULE_ID } from '../src/config.ts';
import { MemoryDirtyCounts } from '../src/counter.ts';
import type { GiveawaysDeps } from '../src/deps.ts';
import { drawGiveaway } from '../src/end.ts';
import { describeJoin, join } from '../src/entry.ts';
import { handleEnter } from '../src/interactions.ts';
import { ENTER_ACTION, LEAVE_ACTION } from '../src/message.ts';
import type { Ctx } from '../src/perform.ts';
import type { Giveaway, MemberSnapshot, NewEntry } from '../src/store.ts';
import { commandHarness, group, stringOption, subcommand, userOption } from './command-harness.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const CHANNEL = '500000000000000000';
const HOST = '400000000000000001';
const APPLICATION = '800000000000000001';
const NOW = new Date('2026-09-18T12:00:00.000Z');
const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ROLE_A = '600000000000000000';
const ROLE_B = '600000000000000001';

function userId(index: number): string {
  return String(400000000000000200n + BigInt(index));
}

function at(second: number): Date {
  return new Date(NOW.getTime() + second * 1_000);
}

async function seeded(store = new MemoryGiveawayStore()): Promise<MemoryGiveawayStore> {
  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(NOW.getTime() + 60_000),
    createdBy: HOST,
  });

  return store;
}

function snapshot(roleIds: string[]): MemberSnapshot {
  return { roleIds, joinedAt: null, premiumSince: null, hasAvatar: true };
}

function entryFor(user: string, pressedAt: Date, over: Partial<NewEntry> = {}): NewEntry {
  return {
    giveawayId: 'g1',
    userId: user,
    baseEntries: 1,
    totalEntries: 1,
    breakdown: [],
    memberSnapshot: snapshot([ROLE_A]),
    pressedAt,
    ...over,
  };
}

function ctxFor(id: string): MemberContext {
  return {
    guildId: GUILD,
    userId: id,
    member: {
      joinedAt: new Date('2024-01-01T00:00:00.000Z'),
      roleIds: [ROLE_A],
      premiumSince: null,
      communicationDisabledUntil: null,
    },
    user: { createdAt: new Date('2020-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    tier: 'free',
    now: NOW,
  };
}

async function giveawayOf(store: MemoryGiveawayStore): Promise<Giveaway> {
  const giveaway = await store.get(GUILD, 'g1');
  if (!giveaway) throw new Error('the giveaway was not seeded');
  return giveaway;
}

async function joinAs(store: MemoryGiveawayStore, user: string, pressedAt: Date) {
  return join(
    { store, providers: new ProviderRegistry() },
    {
      giveaway: await giveawayOf(store),
      ctx: ctxFor(user),
      pressedAt,
      requirements: [],
      multipliers: [],
      blacklist: [],
    },
  );
}

function rowOf(store: MemoryGiveawayStore, user: string) {
  const row = store.entries.find((entry) => entry.giveawayId === 'g1' && entry.userId === user);
  if (!row) throw new Error(`no entry row for ${user}`);
  return row;
}

describe('the store takes a leaver back', () => {
  test('a member who left is entered again and counted again', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.enter(entryFor(userId(2), at(0)));

    expect(await store.leave('g1', userId(1), at(1))).toBe('left');
    expect(await store.entrantCount('g1')).toBe(1);
    expect(await store.entry('g1', userId(1))).toBeNull();

    expect(await store.enter(entryFor(userId(1), at(2)))).toBe('entered');

    expect(await store.entrantCount('g1')).toBe(2);
    expect(await store.entry('g1', userId(1))).not.toBeNull();

    const pool: string[] = [];
    for await (const chunk of store.entrants('g1', 10)) {
      pool.push(...chunk.map((row) => row.userId));
    }
    expect(pool).toEqual([userId(1), userId(2)]);
  });

  test('a first entry is stamped with its press time, however late it is handled', async () => {
    const store = await seeded();

    expect(await store.enter(entryFor(userId(1), at(-30)))).toBe('entered');
    expect(rowOf(store, userId(1)).joinedAt).toEqual(at(-30));
  });

  test('re-entering takes the new weight and snapshot and stamps the new press', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0), { totalEntries: 3 }));
    await store.leave('g1', userId(1), at(1));
    rowOf(store, userId(1)).revalidatedAt = at(1);

    await store.enter(
      entryFor(userId(1), at(2), {
        baseEntries: 2,
        totalEntries: 5,
        memberSnapshot: snapshot([ROLE_B]),
      }),
    );

    const row = rowOf(store, userId(1));
    expect(row.leftAt).toBeNull();
    expect(row.baseEntries).toBe(2);
    expect(row.totalEntries).toBe(5);
    expect(row.memberSnapshot?.roleIds).toEqual([ROLE_B]);
    expect(row.joinedAt).toEqual(at(2));
    expect(row.revalidatedAt).toBeNull();
  });

  test('leaving and coming back keeps the one history row that loss streaks count', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));

    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(await store.leave('g1', userId(1), at(2 * cycle + 1))).toBe('left');
      expect((await store.priorEntryCounts(GUILD, [userId(1)], new Date(0))).get(userId(1))).toBe(
        1,
      );

      expect(await store.enter(entryFor(userId(1), at(2 * cycle + 2)))).toBe('entered');
    }

    expect(store.entries.filter((row) => row.userId === userId(1))).toHaveLength(1);
    expect((await store.priorEntryCounts(GUILD, [userId(1)], new Date(0))).get(userId(1))).toBe(1);
  });

  test('a press after re-entering is already in, and the row is not touched again', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(1));
    await store.enter(entryFor(userId(1), at(2), { totalEntries: 4 }));

    expect(await store.enter(entryFor(userId(1), at(3), { totalEntries: 9 }))).toBe(
      'already-entered',
    );
    expect(rowOf(store, userId(1)).totalEntries).toBe(4);
    expect(rowOf(store, userId(1)).joinedAt).toEqual(at(2));
  });

  test('a double press after a leave takes the member back once', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(1));

    expect(await store.enter(entryFor(userId(1), at(2)))).toBe('entered');
    expect(await store.enter(entryFor(userId(1), at(2.1)))).toBe('already-entered');
    expect(await store.entrantCount('g1')).toBe(1);
  });

  test('a leaver cannot come back once the giveaway stops running', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(1));
    await store.pause(GUILD, 'g1', HOST, null, at(2));

    expect(await store.enter(entryFor(userId(1), at(3)))).toBe('closed');
    expect(rowOf(store, userId(1)).leftAt).toEqual(at(1));
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('re-entering never lifts a disqualification', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.disqualify('g1', [{ userId: userId(1), reason: 'lost the role' }], at(1));

    expect(await store.enter(entryFor(userId(1), at(2)))).not.toBe('entered');

    const row = rowOf(store, userId(1));
    row.leftAt = at(3);

    expect(await store.enter(entryFor(userId(1), at(4)))).not.toBe('entered');
    expect(row.disqualifiedAt).not.toBeNull();
    expect(await store.entrantCount('g1')).toBe(0);
  });
});

describe('a replayed press is ordered by when it was pressed', () => {
  test('an Enter pressed before a Leave and redelivered after it leaves the member out', async () => {
    const store = await seeded();
    const first = entryFor(userId(1), at(0));

    expect(await store.enter(first)).toBe('entered');
    expect(await store.leave('g1', userId(1), at(1))).toBe('left');

    expect(await store.enter(first)).toBe('superseded');

    const row = rowOf(store, userId(1));
    expect(row.leftAt).toEqual(at(1));
    expect(row.joinedAt).toEqual(at(0));
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('a re-entry redelivered after a later Leave does not undo that Leave', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(1));
    const back = entryFor(userId(1), at(2));
    expect(await store.enter(back)).toBe('entered');
    expect(await store.leave('g1', userId(1), at(3))).toBe('left');

    expect(await store.enter(back)).toBe('superseded');

    expect(rowOf(store, userId(1)).leftAt).toEqual(at(3));
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('a Leave pressed before a re-entry and redelivered after it keeps the member in', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    expect(await store.leave('g1', userId(1), at(1))).toBe('left');
    expect(await store.enter(entryFor(userId(1), at(2)))).toBe('entered');

    expect(await store.leave('g1', userId(1), at(1))).toBe('superseded');

    const row = rowOf(store, userId(1));
    expect(row.leftAt).toBeNull();
    expect(row.joinedAt).toEqual(at(2));
    expect(await store.entrantCount('g1')).toBe(1);
  });

  test('leave, enter and leave again in press order all land', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));

    expect(await store.leave('g1', userId(1), at(1))).toBe('left');
    expect(await store.enter(entryFor(userId(1), at(2)))).toBe('entered');
    expect(await store.entrantCount('g1')).toBe(1);
    expect(await store.leave('g1', userId(1), at(3))).toBe('left');

    expect(await store.entrantCount('g1')).toBe(0);
    expect(rowOf(store, userId(1)).leftAt).toEqual(at(3));
  });
});

describe('a press handled after a later one', () => {
  test('an Enter handled after the Leave that followed it is superseded, not closed', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    expect(await store.leave('g1', userId(1), at(2))).toBe('left');

    expect(await store.enter(entryFor(userId(1), at(1)))).toBe('superseded');

    const row = rowOf(store, userId(1));
    expect(row.leftAt).toEqual(at(2));
    expect(row.joinedAt).toEqual(at(0));
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('an Enter pressed at the same instant as the Leave is superseded', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(1));

    expect(await store.enter(entryFor(userId(1), at(1)))).toBe('superseded');
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('a late Enter is closed, not superseded, once the giveaway stops running', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(2));
    await store.pause(GUILD, 'g1', HOST, null, at(3));

    expect(await store.enter(entryFor(userId(1), at(1)))).toBe('closed');
  });

  test('a late Leave is not in the draw when the member has since left again', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(1));
    await store.enter(entryFor(userId(1), at(3)));
    await store.leave('g1', userId(1), at(4));

    expect(await store.leave('g1', userId(1), at(2))).toBe('not-entered');
    expect(rowOf(store, userId(1)).leftAt).toEqual(at(4));
  });

  test('a late Leave from a member disqualified since is not in the draw', async () => {
    const store = await seeded();
    await store.enter(entryFor(userId(1), at(0)));
    await store.leave('g1', userId(1), at(1));
    await store.enter(entryFor(userId(1), at(3)));
    await store.disqualify('g1', [{ userId: userId(1), reason: 'lost the role' }], at(4));

    expect(await store.leave('g1', userId(1), at(2))).toBe('not-entered');
    expect(rowOf(store, userId(1)).leftAt).toBeNull();
  });
});

describe('join after Leave', () => {
  test('a leaver is put back in the draw and told so', async () => {
    const store = await seeded();
    expect((await joinAs(store, userId(1), at(0))).outcome).toBe('entered');
    await store.leave('g1', userId(1), at(1));

    const again = await joinAs(store, userId(1), at(2));

    expect(again.outcome).toBe('entered');
    expect(describeJoin(again, 'A prize')).toBe('You’re in the draw for **A prize**. Good luck.');
    expect(await store.entrantCount('g1')).toBe(1);
  });

  test('a replayed join from before the Leave does not put the member back', async () => {
    const store = await seeded();
    await joinAs(store, userId(1), at(0));
    await store.leave('g1', userId(1), at(1));

    const replayed = await joinAs(store, userId(1), at(0));

    expect(replayed).toEqual({ outcome: 'superseded' });
    expect(describeJoin(replayed, 'A prize')).toBe(
      'You left **A prize** after pressing “Enter giveaway”, so you’re not in the draw.',
    );
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('a member who re-entered is eligible to win', async () => {
    const store = await seeded();
    await joinAs(store, userId(1), at(0));
    await joinAs(store, userId(2), at(0));

    await store.leave('g1', userId(1), at(1));
    await joinAs(store, userId(1), at(2));
    await store.leave('g1', userId(2), at(3));

    const drawn = await drawGiveaway(
      { store, providers: new ProviderRegistry(), now: () => NOW.getTime(), seed: () => SEED },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
    );

    if (drawn.outcome !== 'drawn') throw new Error(`expected a draw, got ${drawn.outcome}`);
    expect(drawn.summary.entrantCount).toBe(1);
    expect(drawn.summary.winnerIds).toEqual([userId(1)]);
  });

  test('a member genuinely in is still told they are already in, with their entries', async () => {
    const store = await seeded();
    expect(describeJoin(await joinAs(store, userId(1), at(0)), 'A prize')).toContain('Good luck');

    const again = await joinAs(store, userId(1), at(1));
    expect(again).toEqual({ outcome: 'already-entered', totalEntries: 1 });
    expect(describeJoin(again, 'A prize')).toBe(
      'You’re already in the draw for **A prize** with 1 entry.',
    );

    await store.grantBonus({
      id: 'b1',
      giveawayId: 'g1',
      userId: userId(1),
      amount: 2,
      reason: null,
      grantedBy: HOST,
    });

    expect(describeJoin(await joinAs(store, userId(1), at(2)), 'A prize')).toBe(
      'You’re already in the draw for **A prize** with 3 entries.',
    );
  });

  test('a bonus granted while the member was out counts once when they come back', async () => {
    const store = await seeded();
    await joinAs(store, userId(1), at(0));
    await store.leave('g1', userId(1), at(1));

    await store.grantBonus({
      id: 'b1',
      giveawayId: 'g1',
      userId: userId(1),
      amount: 4,
      reason: null,
      grantedBy: HOST,
    });

    const again = await joinAs(store, userId(1), at(2));

    if (again.outcome !== 'entered') throw new Error(`expected an entry, got ${again.outcome}`);
    expect(again.totalEntries).toBe(5);
    expect(rowOf(store, userId(1)).totalEntries).toBe(5);
  });
});

describe('the Enter button after Leave', () => {
  const MEMBER = userId(7);

  function pressId(second: number): string {
    return String(BigInt(at(second).getTime() - DISCORD_EPOCH_MS) << 22n);
  }

  function press(action: string, interactionId: string): ProtonEvent {
    const encoded = encodeCustomId(MODULE_ID, action, 'g1');
    if (!encoded.ok) throw new Error(encoded.humanReason);

    return {
      id: `interaction.component:${interactionId}`,
      type: 'interaction.component',
      guildId: GUILD,
      occurredAt: 0,
      payload: {
        id: interactionId,
        token: `token-${interactionId}`,
        type: 3,
        application_id: APPLICATION,
        guild_id: GUILD,
        channel_id: CHANNEL,
        member: {
          user: { id: MEMBER, avatar: 'a1b2c3' },
          roles: [ROLE_A],
          joined_at: '2024-01-01T00:00:00.000Z',
        },
        data: { custom_id: encoded.customId, component_type: 2 },
      },
    } as unknown as ProtonEvent;
  }

  async function buttons() {
    const store = await seeded();
    const dirty = new MemoryDirtyCounts(() => 0);
    const requests: ActionRequest[] = [];

    const ctx: Ctx = {
      guildId: GUILD,
      config: { ...giveawaysConfigSchema.parse({}), enabled: true },
      executor: {
        async execute(request) {
          requests.push(request);
          return { status: 'executed' };
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    };

    const deps: GiveawaysDeps = {
      store,
      dirty,
      providers: new ProviderRegistry(),
      applicationId: APPLICATION,
      now: () => NOW.getTime() + 30_000,
    };

    async function answer(action: string, interactionId: string) {
      expect(await handleEnter(press(action, interactionId), ctx, deps)).toBe('answered');

      const followUp = requests.find(
        (request) =>
          request.kind === 'interaction_followup' &&
          (request.payload as { interactionToken?: string }).interactionToken ===
            `token-${interactionId}`,
      );
      const embed = (followUp?.payload as { embeds?: { description: string; color: number }[] })
        ?.embeds?.[0];
      if (!embed) throw new Error(`no answer to ${action} (${interactionId})`);

      return embed;
    }

    async function redeliver(action: string, interactionId: string) {
      expect(await handleEnter(press(action, interactionId), ctx, deps)).toBe('answered');
    }

    return { store, dirty, answer, redeliver };
  }

  test('a member who left and presses Enter again is told they are in, not already in', async () => {
    const { store, dirty, answer } = await buttons();

    expect((await answer(ENTER_ACTION, pressId(1))).color).toBe(STATUS_SUCCESS_COLOUR);

    const left = await answer(LEAVE_ACTION, pressId(2));
    expect(left.description).toContain(
      'You left **A prize**. You can enter again while it’s still running.',
    );
    expect(await store.entrantCount('g1')).toBe(0);

    await dirty.clear(GUILD, 'g1');
    const back = await answer(ENTER_ACTION, pressId(3));

    expect(back.color).toBe(STATUS_SUCCESS_COLOUR);
    expect(back.description).toContain('You’re in the draw for **A prize**. Good luck.');
    expect(back.description).not.toContain('already');
    expect(await store.entrantCount('g1')).toBe(1);
    expect(await dirty.pending(GUILD, 10)).toEqual(['g1']);
  });

  test('the entry and the leave are stamped with the press times, not the worker clock', async () => {
    const { store, answer } = await buttons();

    await answer(ENTER_ACTION, pressId(1));
    expect(rowOf(store, MEMBER).joinedAt).toEqual(at(1));

    await answer(LEAVE_ACTION, pressId(2));
    expect(rowOf(store, MEMBER).leftAt).toEqual(at(2));
  });

  test('an Enter redelivered after the Leave that followed it changes nothing', async () => {
    const { store, dirty, answer, redeliver } = await buttons();

    await answer(ENTER_ACTION, pressId(1));
    await answer(LEAVE_ACTION, pressId(2));
    await dirty.clear(GUILD, 'g1');

    await redeliver(ENTER_ACTION, pressId(1));

    expect(await store.entrantCount('g1')).toBe(0);
    expect(rowOf(store, MEMBER).leftAt).toEqual(at(2));
    expect(await dirty.pending(GUILD, 10)).toEqual([]);
  });

  test('a Leave redelivered after the member came back keeps them in', async () => {
    const { store, dirty, answer, redeliver } = await buttons();

    await answer(ENTER_ACTION, pressId(1));
    await answer(LEAVE_ACTION, pressId(2));
    await answer(ENTER_ACTION, pressId(3));
    await dirty.clear(GUILD, 'g1');

    await redeliver(LEAVE_ACTION, pressId(2));

    expect(await store.entrantCount('g1')).toBe(1);
    expect(rowOf(store, MEMBER).joinedAt).toEqual(at(3));
    expect(await dirty.pending(GUILD, 10)).toEqual([]);
  });

  test('an Enter handled after the Leave pressed next is told the Leave came later', async () => {
    const { store, dirty, answer } = await buttons();

    await answer(ENTER_ACTION, pressId(1));
    expect((await answer(LEAVE_ACTION, pressId(3))).color).toBe(STATUS_SUCCESS_COLOUR);
    await dirty.clear(GUILD, 'g1');

    const late = await answer(ENTER_ACTION, pressId(2));

    expect(late.color).toBe(STATUS_ERROR_COLOUR);
    expect(late.description).toBe(
      `${STATUS_ERROR_EMOJI} You left **A prize** after pressing “Enter giveaway”, so you’re not in the draw.`,
    );
    expect(await store.entrantCount('g1')).toBe(0);
    expect(rowOf(store, MEMBER).leftAt).toEqual(at(3));
    expect(await dirty.pending(GUILD, 10)).toEqual([]);
  });

  test('a Leave handled after the Enter pressed next is told the member is still in', async () => {
    const { store, dirty, answer } = await buttons();

    await answer(ENTER_ACTION, pressId(1));
    await answer(LEAVE_ACTION, pressId(2));
    expect((await answer(ENTER_ACTION, pressId(4))).color).toBe(STATUS_SUCCESS_COLOUR);
    await dirty.clear(GUILD, 'g1');

    const late = await answer(LEAVE_ACTION, pressId(3));

    expect(late.color).toBe(STATUS_ERROR_COLOUR);
    expect(late.description).toBe(
      `${STATUS_ERROR_EMOJI} You entered **A prize** after pressing “Leave”, so you’re still in the draw.`,
    );
    expect(await store.entrantCount('g1')).toBe(1);
    expect(rowOf(store, MEMBER).joinedAt).toEqual(at(4));
    expect(await dirty.pending(GUILD, 10)).toEqual([]);
  });

  test('a Leave from somebody who never entered is told they are not in the draw', async () => {
    const { store, answer } = await buttons();

    const left = await answer(LEAVE_ACTION, pressId(1));

    expect(left.color).toBe(STATUS_ERROR_COLOUR);
    expect(left.description).toBe(`${STATUS_ERROR_EMOJI} You’re not in the draw for **A prize**.`);
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('a member still in who presses Enter again is told they are already in', async () => {
    const { store, answer } = await buttons();

    await answer(ENTER_ACTION, pressId(1));
    const again = await answer(ENTER_ACTION, pressId(2));

    expect(again.color).toBe(STATUS_ERROR_COLOUR);
    expect(again.description).toContain('You’re already in the draw for **A prize** with 1 entry.');
    expect(await store.entrantCount('g1')).toBe(1);
  });
});

describe('staff replies about a member who left', () => {
  const MEMBER = userId(9);

  async function staffView(cameBack: boolean) {
    const h = commandHarness();
    await seeded(h.store);

    await h.store.enter(entryFor(MEMBER, at(0), { totalEntries: 2 }));
    await h.store.leave('g1', MEMBER, at(1));
    if (cameBack) await h.store.enter(entryFor(MEMBER, at(2)));

    return h;
  }

  const entriesOf = subcommand('entries', [
    stringOption('giveaway', 'g1'),
    userOption('member', MEMBER),
  ]);

  const grantThree = group('bonus', 'add', [
    stringOption('giveaway', 'g1'),
    userOption('member', MEMBER),
    { name: 'entries', type: OptionType.Integer, value: 3 },
  ]);

  test('/giveaway entries says a member who left is not in the draw', async () => {
    const h = await staffView(false);

    await h.run(entriesOf);

    expect(h.replyText()).toBe(`<@${MEMBER}> isn’t in the draw for **A prize**.`);
  });

  test('/giveaway entries shows a member who came back at the weight they came back with', async () => {
    const h = await staffView(true);

    await h.run(entriesOf);

    expect(h.replyText()).toBe(`<@${MEMBER}> has **1 entry** in **A prize**.`);
  });

  test('a bonus for a member who left says it will count when they enter', async () => {
    const h = await staffView(false);

    await h.run(grantThree);

    expect(h.replyColour()).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyText()).toBe(
      `${STATUS_SUCCESS_EMOJI} <@${MEMBER}> now has **+3** extra entries in **A prize**. ` +
        'They aren’t in the draw yet, so these count once they enter.',
    );
    expect(await h.store.entry('g1', MEMBER)).toBeNull();
  });

  test('a bonus for a member who came back lands on their entry with no caveat', async () => {
    const h = await staffView(true);

    await h.run(grantThree);

    expect(h.replyColour()).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyText()).toBe(
      `${STATUS_SUCCESS_EMOJI} <@${MEMBER}> now has **+3** extra entries in **A prize**.`,
    );
    expect((await h.store.entry('g1', MEMBER))?.totalEntries).toBe(4);
  });
});
