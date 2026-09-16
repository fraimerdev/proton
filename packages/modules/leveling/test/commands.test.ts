import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type RawOption,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import { leaderboardCommand, rankCommand, xpCommand } from '../src/commands.ts';
import type { LevelingDeps } from '../src/deps.ts';
import type { AdjustInput, LeaderboardEntry, MemberXpRecord } from '../src/store.ts';
import { commandContext, FakeXpStore, GUILD, USER } from './fakes.ts';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const TARGET = '400000000000000004';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

interface ReplyPayload {
  content?: string;
  embeds?: { description?: string; color?: number }[];
  ephemeral?: boolean;
  files?: { filename: string }[];
}

function replyOf(sent: ActionRequest[]): ReplyPayload | undefined {
  return sent.find((request) => request.kind === 'interaction_reply')?.payload as
    | ReplyPayload
    | undefined;
}

function descriptionOf(sent: ActionRequest[]): string {
  return replyOf(sent)?.embeds?.[0]?.description ?? '';
}

function giveOptions(amount: number, userId: string | null = TARGET): RawOption[] {
  return [
    {
      name: 'give',
      type: 1,
      options: [
        ...(userId === null ? [] : [{ name: 'user', type: 6, value: userId }]),
        { name: 'amount', type: 4, value: amount },
      ],
    },
  ];
}

function record(overrides: Partial<MemberXpRecord> = {}): MemberXpRecord {
  return {
    userId: USER,
    xp: 1200,
    level: 5,
    rank: 3,
    messageCount: 120,
    voiceSeconds: 900,
    ...overrides,
  };
}

function storeWith(...records: MemberXpRecord[]): FakeXpStore {
  return new FakeXpStore().seed(GUILD, ...records);
}

describe('/xp give', () => {
  test('a member who gains XP is told so in a green status embed', async () => {
    const store = storeWith();
    const adjusts: AdjustInput[] = [];
    store.adjust = async (input) => {
      adjusts.push(input);
      return { xp: 1250, level: 3, previousLevel: 2, awarded: true };
    };

    const { ctx, sent } = commandContext(giveOptions(500));

    await xpCommand({ xp: store, now: () => NOW }).handler(ctx);

    expect(adjusts[0]).toMatchObject({ userId: TARGET, adjustment: 'give', amount: 500 });

    const payload = replyOf(sent);
    expect(payload?.content).toBe('');
    expect(payload?.embeds?.[0]?.color).toBe(STATUS_SUCCESS_COLOUR);
    expect(descriptionOf(sent)).toBe(
      `${STATUS_SUCCESS_EMOJI} <@${TARGET}> is now on 1,250 XP — level 3, up from 2.`,
    );
  });

  test('without a member to adjust it refuses in a red status embed', async () => {
    const store = storeWith();
    let adjusted = false;
    store.adjust = async () => {
      adjusted = true;
      return { xp: 0, level: 0, previousLevel: 0, awarded: false };
    };

    const { ctx, sent } = commandContext(giveOptions(500, null));

    await xpCommand({ xp: store, now: () => NOW }).handler(ctx);

    expect(adjusted).toBe(false);
    expect(replyOf(sent)).toMatchObject({ ephemeral: true });
    expect(replyOf(sent)?.embeds?.[0]?.color).toBe(STATUS_ERROR_COLOUR);
    expect(descriptionOf(sent)).toBe(`${STATUS_ERROR_EMOJI} I need a member and an amount.`);
  });

  test('a server with Leveling disabled is refused before the store is touched', async () => {
    const store = storeWith();
    let adjusted = false;
    store.adjust = async () => {
      adjusted = true;
      return { xp: 0, level: 0, previousLevel: 0, awarded: false };
    };

    const { ctx, sent } = commandContext(giveOptions(500), { enabled: false });

    await xpCommand({ xp: store, now: () => NOW }).handler(ctx);

    expect(adjusted).toBe(false);
    expect(replyOf(sent)).toMatchObject({ ephemeral: true });
    expect(replyOf(sent)?.embeds?.[0]?.color).toBe(STATUS_ERROR_COLOUR);
    expect(descriptionOf(sent)).toContain('Leveling is disabled in this server');
  });

  test('a process built without the XP store refuses and names the missing port', async () => {
    const { ctx, sent, logs } = commandContext(giveOptions(500));

    await xpCommand({ now: () => NOW }).handler(ctx);

    expect(replyOf(sent)).toMatchObject({ ephemeral: true });
    expect(replyOf(sent)?.embeds?.[0]?.color).toBe(STATUS_ERROR_COLOUR);
    expect(descriptionOf(sent)).toContain("I can't reach this server's XP records");
    expect(logs.some((line) => line.startsWith('error:') && line.includes('xp:'))).toBe(true);
  });
});

describe('/rank', () => {
  test('the card is the whole reply, with no caption and no status embed', async () => {
    const store = storeWith(record());
    const deps: LevelingDeps = {
      xp: store,
      now: () => NOW,
      renderCard: async () => PNG,
      userProfile: async () => ({ displayName: 'Rin', avatarHash: null }),
    };

    const { ctx, sent } = commandContext([], { rankCard: true });

    await rankCommand(deps).handler(ctx);

    const payload = replyOf(sent);
    expect(payload?.files?.[0]?.filename).toBe('rank.png');
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('embeds');
  });

  test('a card that cannot be drawn answers with a red status embed', async () => {
    const store = storeWith(record());
    const deps: LevelingDeps = {
      xp: store,
      now: () => NOW,
      renderCard: async () => {
        throw new Error('resvg said no');
      },
    };

    const { ctx, sent } = commandContext([], { rankCard: true });

    await rankCommand(deps).handler(ctx);

    expect(replyOf(sent)?.embeds?.[0]?.color).toBe(STATUS_ERROR_COLOUR);
    expect(descriptionOf(sent)).toContain('could not draw the rank card');
    expect(descriptionOf(sent)).toStartWith(STATUS_ERROR_EMOJI);
  });

  test('with rank cards disabled it says so in a red status embed', async () => {
    const { ctx, sent } = commandContext([]);

    await rankCommand({ xp: storeWith(record()), now: () => NOW }).handler(ctx);

    expect(replyOf(sent)?.embeds?.[0]?.color).toBe(STATUS_ERROR_COLOUR);
    expect(descriptionOf(sent)).toContain('Rank cards are disabled in this server');
  });

  test('a member with no XP yet is told plainly, not in a status embed', async () => {
    const { ctx, sent } = commandContext([]);

    await rankCommand({ xp: storeWith(), now: () => NOW }).handler(ctx);

    expect(replyOf(sent)?.content).toBe(
      'You have not earned any XP in this server yet. Join a conversation.',
    );
    expect(replyOf(sent)).not.toHaveProperty('embeds');
  });
});

describe('/leaderboard', () => {
  test('the leaderboard itself stays plain text', async () => {
    const store = storeWith();
    const entries: LeaderboardEntry[] = [
      { userId: USER, xp: 1200, level: 5, rank: 1 },
      { userId: TARGET, xp: 800, level: 4, rank: 2 },
    ];
    store.leaderboard = async () => entries;

    const { ctx, sent } = commandContext([]);

    await leaderboardCommand({ xp: store, now: () => NOW }).handler(ctx);

    const payload = replyOf(sent);
    expect(payload?.content).toContain('**XP leaderboard** (page 1)');
    expect(payload?.content).toContain(`**1.** <@${USER}> — level 5, 1,200 XP`);
    expect(payload).not.toHaveProperty('embeds');
  });

  test('a page past the end of the leaderboard is refused in a red status embed', async () => {
    const { ctx, sent } = commandContext([{ name: 'page', type: 4, value: 3 }]);

    await leaderboardCommand({ xp: storeWith(), now: () => NOW }).handler(ctx);

    expect(replyOf(sent)?.embeds?.[0]?.color).toBe(STATUS_ERROR_COLOUR);
    expect(descriptionOf(sent)).toBe(
      `${STATUS_ERROR_EMOJI} There is no page 3 — the leaderboard is shorter than that.`,
    );
  });

  test('an empty leaderboard is stated plainly, not as a refusal', async () => {
    const { ctx, sent } = commandContext([]);

    await leaderboardCommand({ xp: storeWith(), now: () => NOW }).handler(ctx);

    expect(replyOf(sent)?.content).toBe('Nobody has earned any XP in this server yet.');
    expect(replyOf(sent)).not.toHaveProperty('embeds');
  });
});
