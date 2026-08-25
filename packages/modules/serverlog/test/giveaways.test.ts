import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { ServerLogColors } from '../src/colours.ts';
import { createServerlogListener } from '../src/listeners.ts';
import { ACTOR, BOT_USER, context, EMOJIS, GUILD, RecordingExecutor, resolver } from './harness.ts';

const listener = () =>
  createServerlogListener({ emojis: EMOJIS, users: resolver, botUserId: BOT_USER });

const CHANNEL = '500000000000000010';
const HOST = '200000000000000001';
const WINNER_A = '200000000000000002';
const WINNER_B = '200000000000000003';

function giveawayEvent(type: ProtonEvent['type'], payload: unknown): ProtonEvent {
  return { id: `${type}:1`, type, guildId: GUILD, occurredAt: 1_700_000_000_000, payload };
}

const subject = {
  guildId: GUILD,
  giveawayId: '01JXXXXXXXXXXXXXXXXXXXXXXX',
  shortCode: '7X29',
  title: 'Discord Nitro',
  channelId: CHANNEL,
  hostId: HOST,
};

const drawn = {
  ...subject,
  drawNumber: 1,
  drawnById: HOST,
  winnerIds: [WINNER_A, WINNER_B],
  entrantCount: 1284,
  totalEntries: 2050,
  disqualified: 3,
  degradedProviders: [],
  seed: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  snapshotHash: 'b'.repeat(64),
};

async function render(type: ProtonEvent['type'], payload: unknown) {
  const executor = new RecordingExecutor();
  await listener().handler(giveawayEvent(type, payload), context(executor));

  return executor;
}

describe('giveaway lifecycle logs', () => {
  test('a created giveaway names the prize, the host and the code', async () => {
    const executor = await render('giveaways.created', {
      ...subject,
      createdById: HOST,
      winnerCount: 3,
      endsAt: 1_700_100_000_000,
      startsAt: null,
      requirementCount: 2,
      multiplierCount: 1,
    });

    expect(executor.titles()).toEqual(['Giveaway created']);

    const body = String(executor.embeds()[0]?.description);
    expect(body).toContain('Discord Nitro');
    expect(body).toContain('G-7X29');
    expect(body).toContain('2 requirements, 1 multiplier');
  });

  test('a scheduled giveaway leads with when it starts', async () => {
    const executor = await render('giveaways.created', {
      ...subject,
      createdById: HOST,
      winnerCount: 1,
      endsAt: 1_700_200_000_000,
      startsAt: 1_700_100_000_000,
      requirementCount: 0,
      multiplierCount: 0,
    });

    expect(String(executor.embeds()[0]?.description)).toContain('Starts');
  });

  test('starting a scheduled giveaway logs separately', async () => {
    const executor = await render('giveaways.started', { ...subject, endsAt: 1_700_100_000_000 });

    expect(executor.titles()).toEqual(['Giveaway started']);
  });

  test('an edit says what changed', async () => {
    const executor = await render('giveaways.edited', {
      ...subject,
      actorId: ACTOR,
      changed: ['title', 'winnerCount'],
      endsAtBefore: 1_700_100_000_000,
      endsAtAfter: 1_700_100_000_000,
    });

    expect(executor.titles()).toEqual(['Giveaway edited']);
    expect(String(executor.embeds()[0]?.description)).toContain('title, winnerCount');
  });

  test('an extension reports the new deadline', async () => {
    const executor = await render('giveaways.edited', {
      ...subject,
      actorId: ACTOR,
      changed: ['extended'],
      endsAtBefore: 1_700_100_000_000,
      endsAtAfter: 1_700_200_000_000,
    });

    expect(String(executor.embeds()[0]?.description)).toContain('Now ends');
  });

  test('a pause carries its reason', async () => {
    const executor = await render('giveaways.paused', {
      ...subject,
      actorId: ACTOR,
      reason: 'prize supplier fell through',
    });

    expect(executor.titles()).toEqual(['Giveaway paused']);
    expect(String(executor.embeds()[0]?.description)).toContain('prize supplier fell through');
  });

  test('a resume reports how long it was held', async () => {
    const executor = await render('giveaways.resumed', {
      ...subject,
      actorId: ACTOR,
      endsAt: 1_700_200_000_000,
      heldMs: 90 * 60 * 1000,
    });

    expect(executor.titles()).toEqual(['Giveaway resumed']);
    // Compound, not rounded to one unit: the held time is exactly how far the deadline moved, and
    // "2h" would misstate it.
    expect(String(executor.embeds()[0]?.description)).toContain('1h 30m');
  });

  test.each([
    [45 * 1000, '45s'],
    [30 * 60 * 1000, '30m'],
    [2 * 60 * 60 * 1000, '2h'],
    [(26 * 60 + 5) * 60 * 1000, '1d 2h 5m'],
  ] as const)('a pause of %i ms reads as %s', async (heldMs, expected) => {
    const executor = await render('giveaways.resumed', {
      ...subject,
      actorId: ACTOR,
      endsAt: 1_700_200_000_000,
      heldMs,
    });

    expect(String(executor.embeds()[0]?.description)).toContain(expected);
  });

  test('a cancellation is red and counts who missed out', async () => {
    const executor = await render('giveaways.cancelled', {
      ...subject,
      actorId: ACTOR,
      entrantCount: 42,
    });

    expect(executor.titles()).toEqual(['Giveaway cancelled']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Remove);
    expect(String(executor.embeds()[0]?.description)).toContain('42');
  });
});

describe('draw logs', () => {
  test('a draw names the winners and the pool', async () => {
    const executor = await render('giveaways.ended', drawn);

    expect(executor.titles()).toEqual(['Giveaway ended']);

    const body = String(executor.embeds()[0]?.description);
    expect(body).toContain(`<@${WINNER_A}>`);
    expect(body).toContain('1284 entrants');
    expect(body).toContain('2050 entries');
  });

  // The seed is what makes a disputed draw reproducible without opening the database.
  test('a draw records its seed', async () => {
    const executor = await render('giveaways.ended', drawn);

    expect(String(executor.embeds()[0]?.description)).toContain(drawn.seed);
  });

  test('a draw with nobody eligible says so rather than showing an empty list', async () => {
    const executor = await render('giveaways.ended', { ...drawn, winnerIds: [], entrantCount: 0 });

    expect(executor.titles()).toEqual(['Giveaway ended with no winners']);
    expect(String(executor.embeds()[0]?.description)).toContain('nobody eligible');
  });

  // A draw that ran without one of its requirements is a different draw than the host configured.
  test('skipped rules are never silent', async () => {
    const executor = await render('giveaways.ended', {
      ...drawn,
      degradedProviders: ['leveling.messages'],
    });

    expect(String(executor.embeds()[0]?.description)).toContain('leveling.messages');
  });

  test('a scheduled draw shows the pseudo-actor as a name, not a broken mention', async () => {
    const executor = await render('giveaways.ended', { ...drawn, drawnById: 'proton:schedule' });

    const body = String(executor.embeds()[0]?.description);
    expect(body).toContain('schedule');
    expect(body).not.toContain('<@proton:schedule>');
  });

  test('a reroll names who was replaced', async () => {
    const executor = await render('giveaways.rerolled', {
      ...drawn,
      drawNumber: 2,
      winnerIds: [WINNER_B],
      replacedIds: [WINNER_A],
    });

    expect(executor.titles()).toEqual(['Giveaway rerolled']);

    const body = String(executor.embeds()[0]?.description);
    expect(body).toContain(`<@${WINNER_A}>`);
    expect(body).toContain('#2');
  });
});

describe('bonus entry logs', () => {
  test('a grant names the member, the amount and the reason', async () => {
    const executor = await render('giveaways.bonus_granted', {
      ...subject,
      actorId: ACTOR,
      subjectId: WINNER_A,
      amount: 5,
      reason: 'ran the tournament',
      revoked: false,
    });

    expect(executor.titles()).toEqual(['Giveaway entries granted']);

    const body = String(executor.embeds()[0]?.description);
    expect(body).toContain('+5');
    expect(body).toContain('ran the tournament');
  });

  test('a revocation is red and shows the entries coming back', async () => {
    const executor = await render('giveaways.bonus_granted', {
      ...subject,
      actorId: ACTOR,
      subjectId: WINNER_A,
      amount: 5,
      reason: null,
      revoked: true,
    });

    expect(executor.titles()).toEqual(['Giveaway entries taken back']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Remove);
    expect(String(executor.embeds()[0]?.description)).toContain('-5');
  });
});

describe('malformed payloads', () => {
  test.each([
    'giveaways.created',
    'giveaways.started',
    'giveaways.edited',
    'giveaways.paused',
    'giveaways.resumed',
    'giveaways.cancelled',
    'giveaways.ended',
    'giveaways.rerolled',
    'giveaways.bonus_granted',
  ] as const)('%s with a junk payload logs nothing rather than throwing', async (type) => {
    const executor = await render(type, { nonsense: true });

    expect(executor.embeds()).toHaveLength(0);
  });
});
