import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  BulkMemberContextLoader,
  type CommandLabeler,
  formatCommandLabel,
  type ModuleContext,
  ProviderRegistry,
  type RestProxyClient,
  type RestResponse,
} from '@proton/core';
import { publishResult } from '../src/announce.ts';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import { drawGiveaway } from '../src/end.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const CHANNEL = '500000000000000000';
const MESSAGE = '700000000000000000';
const LOG_CHANNEL = '500000000000000077';
const HOST = '400000000000000001';
const NOW = Date.UTC(2026, 8, 19, 9);

function userId(index: number): string {
  return String(400000000000002000n + BigInt(index));
}

function harness(logChannelId: string | null = LOG_CHANNEL, commandLabel?: CommandLabeler) {
  const requests: ActionRequest[] = [];

  const ctx = {
    ...(commandLabel ? { commandLabel } : {}),
    guildId: GUILD,
    config: {
      ...giveawaysConfigSchema.parse({}),
      enabled: true,
      announceInChannel: false,
      logChannelId,
    },
    tier: 'free',
    executor: {
      async execute(request: ActionRequest) {
        requests.push(request);
        return { status: 'executed' };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    async publish() {},
    async schedule() {
      return { scheduled: true, replaced: false };
    },
  } as unknown as ModuleContext<GiveawaysConfig>;

  const notices = () =>
    requests.flatMap((request) => {
      const payload = request.payload as { channelId?: unknown; content?: unknown };
      return request.kind === 'send' && payload.channelId === LOG_CHANNEL
        ? [{ key: request.idempotencyKey, content: String(payload.content) }]
        : [];
    });

  return { ctx, notices };
}

async function drawn() {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    hostId: HOST,
    title: 'Nitro Classic',
    winnerCount: 1,
    endsAt: new Date(NOW),
    createdBy: HOST,
    verifyOn: 'join',
  } satisfies CreateGiveawayInput);

  for (let index = 1; index <= 3; index += 1) {
    await store.enter({
      giveawayId: 'g1',
      userId: userId(index),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
      pressedAt: new Date(NOW),
    });
  }

  const result = await drawGiveaway(
    { store, providers: new ProviderRegistry(), now: () => NOW },
    { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
  );
  if (result.outcome !== 'drawn') throw new Error('expected a draw');

  return { store, giveaway: result.giveaway, summary: result.summary };
}

describe('the staff notice after a draw', () => {
  test('a draw that skipped a requirement tells the host which one, under its own key', async () => {
    const setup = await drawn();
    const h = harness();

    await publishResult(
      h.ctx,
      { store: setup.store, providers: new ProviderRegistry() },
      { giveaway: setup.giveaway, summary: { ...setup.summary, degraded: ['leveling.level'] } },
    );

    expect(h.notices()).toEqual([
      {
        key: `giveaways:${GUILD}:g1:${setup.summary.drawNumber}:degraded`,
        content:
          `<@${HOST}>, **Nitro Classic** was drawn without one of its requirements: ` +
          'leveling.level. The module that provides it is off or not running, so it was skipped ' +
          'instead of stopping the draw. If that changes who should have won, reroll it with ' +
          '`/giveaway reroll`.',
      },
    ]);
  });

  test('the notices name the reroll command as the server shows it', async () => {
    const setup = await drawn();
    const h = harness(LOG_CHANNEL, (key, path) =>
      formatCommandLabel(key, path, key === 'giveaway' ? 'gw' : undefined),
    );

    await publishResult(
      h.ctx,
      { store: setup.store, providers: new ProviderRegistry() },
      {
        giveaway: setup.giveaway,
        summary: { ...setup.summary, degraded: ['leveling.level'], unchecked: 2 },
      },
    );

    const notices = h.notices();
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice.content).toContain('should have won, reroll it with `/gw reroll`.');
      expect(notice.content).not.toContain('/giveaway');
    }
  });

  test('a draw that skipped nothing posts no notice', async () => {
    const setup = await drawn();
    const h = harness();

    await publishResult(
      h.ctx,
      { store: setup.store, providers: new ProviderRegistry() },
      { giveaway: setup.giveaway, summary: setup.summary },
    );

    expect(h.notices()).toEqual([]);
  });

  test('no log channel means no notice', async () => {
    const setup = await drawn();
    const h = harness(null);

    await publishResult(
      h.ctx,
      { store: setup.store, providers: new ProviderRegistry() },
      { giveaway: setup.giveaway, summary: { ...setup.summary, degraded: ['leveling.level'] } },
    );

    expect(h.notices()).toEqual([]);
  });

  test('a draw judged without the member list tells the host how many entrants went unchecked', async () => {
    const setup = await drawnWithoutList({
      status: 403,
      body: { message: 'Missing Access', code: 50001 },
    });
    const h = harness();

    expect(setup.summary.unchecked).toBe(3);

    await publishResult(
      h.ctx,
      { store: setup.store, providers: new ProviderRegistry() },
      { giveaway: setup.giveaway, summary: setup.summary },
    );

    expect(h.notices()).toEqual([
      {
        key: `giveaways:${GUILD}:g1:${setup.summary.drawNumber}:unchecked`,
        content:
          `<@${HOST}>, **Nitro Classic** was drawn without a full member list because Proton ` +
          "couldn't read this server's members. 3 entrants were checked against how they looked " +
          'when they entered (or not checked at all, where there was no record), and none of ' +
          'them could be disqualified for leaving. If that changes who should have won, reroll ' +
          'it with `/giveaway reroll`.',
      },
    ]);
  });

  test('a draw that read the whole member list posts no unchecked notice', async () => {
    const setup = await drawnWithoutList({
      status: 200,
      body: [1, 2, 3].map((index) => ({
        joined_at: '2024-01-01T00:00:00.000Z',
        roles: [],
        premium_since: null,
        communication_disabled_until: null,
        user: { id: userId(index), avatar: 'abc', bot: false },
      })),
    });
    const h = harness();

    await publishResult(
      h.ctx,
      { store: setup.store, providers: new ProviderRegistry() },
      { giveaway: setup.giveaway, summary: setup.summary },
    );

    expect(setup.summary.unchecked).toBe(0);
    expect(h.notices()).toEqual([]);
  });

  test('an unchecked draw with no log channel posts nothing', async () => {
    const setup = await drawnWithoutList({ status: 502, body: {} });
    const h = harness(null);

    await publishResult(
      h.ctx,
      { store: setup.store, providers: new ProviderRegistry() },
      { giveaway: setup.giveaway, summary: setup.summary },
    );

    expect(setup.summary.unchecked).toBe(3);
    expect(h.notices()).toEqual([]);
  });
});

async function drawnWithoutList(reply: RestResponse) {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    hostId: HOST,
    title: 'Nitro Classic',
    winnerCount: 1,
    endsAt: new Date(NOW),
    createdBy: HOST,
    verifyOn: 'both',
  } satisfies CreateGiveawayInput);

  for (let index = 1; index <= 3; index += 1) {
    await store.enter({
      giveawayId: 'g1',
      userId: userId(index),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot:
        index === 3 ? null : { roleIds: [], joinedAt: null, premiumSince: null, hasAvatar: true },
      pressedAt: new Date(NOW),
    });
  }

  const rest: RestProxyClient = { request: async () => reply };
  const members = new BulkMemberContextLoader(rest, { now: () => new Date(NOW) });

  const result = await drawGiveaway(
    { store, providers: new ProviderRegistry(), members, now: () => NOW },
    { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
  );
  if (result.outcome !== 'drawn') throw new Error('expected a draw');

  return { store, giveaway: result.giveaway, summary: result.summary };
}
