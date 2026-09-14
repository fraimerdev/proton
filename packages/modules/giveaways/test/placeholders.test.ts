import { describe, expect, test } from 'bun:test';
import { type ActionRequest, type ModuleContext, ProviderRegistry } from '@proton/core';
import {
  type BotFacts,
  type PlaceholderEnvironment,
  SAMPLE_BOT,
  SAMPLE_NOW,
  type ServerFacts,
  validateTemplate,
} from '@proton/core/placeholders';
import { publishResult } from '../src/announce.ts';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import { drawGiveaway } from '../src/end.ts';
import { dmWinner } from '../src/perform.ts';
import {
  GIVEAWAY_WIN_EVENT,
  GIVEAWAY_WIN_SURFACE,
  renderWinMessage,
  WIN_MESSAGE_PATH,
} from '../src/placeholders.ts';
import { scheduleNextRun } from '../src/recurrence.ts';
import { rerollGiveaway } from '../src/reroll.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const CHANNEL = '500000000000000000';
const MESSAGE = '700000000000000000';
const HOST = '400000000000000001';
const DM_CHANNEL = '800000000000000000';
const APPLICATION = '100000000000000099';
const NOW = Date.UTC(2026, 8, 14, 9);
const HOUR = 60 * 60 * 1000;
const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LINK = `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`;
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';

function userId(index: number): string {
  return String(400000000000002000n + BigInt(index));
}

interface Sent {
  key: string;
  content: string;
  allowedMentions: unknown;
}

function harness() {
  const requests: ActionRequest[] = [];
  const warnings: string[] = [];

  const ctx = {
    guildId: GUILD,
    config: { ...giveawaysConfigSchema.parse({}), enabled: true, announceInChannel: false },
    tier: 'free',
    executor: {
      async execute(request: ActionRequest) {
        requests.push(request);
        return request.kind === 'create_dm'
          ? { status: 'executed', body: { id: DM_CHANNEL } }
          : { status: 'executed' };
      },
    },
    logger: {
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
      error() {},
    },
    async publish() {},
    async schedule() {
      return { scheduled: true, replaced: false };
    },
  } as unknown as ModuleContext<GiveawaysConfig>;

  const dms = (): Sent[] =>
    requests.flatMap((request) => {
      if (request.kind !== 'send') return [];
      const payload = request.payload as {
        channelId?: unknown;
        content?: unknown;
        allowedMentions?: unknown;
      };
      return payload.channelId === DM_CHANNEL
        ? [
            {
              key: request.idempotencyKey,
              content: String(payload.content),
              allowedMentions: payload.allowedMentions,
            },
          ]
        : [];
    });

  return { ctx, requests, warnings, dms };
}

async function drawn(over: Partial<CreateGiveawayInput> = {}, entrants = 3) {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    hostId: HOST,
    title: 'Nitro Classic',
    winnerCount: entrants,
    endsAt: new Date(NOW),
    createdBy: HOST,
    verifyOn: 'join',
    dmWinners: true,
    ...over,
  } satisfies CreateGiveawayInput);

  for (let index = 1; index <= entrants; index += 1) {
    await store.enter({
      giveawayId: 'g1',
      userId: userId(index),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });
  }

  const result = await drawGiveaway(
    { store, providers: new ProviderRegistry(), now: () => NOW, seed: () => SEED },
    { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
  );
  if (result.outcome !== 'drawn') throw new Error('expected a draw');

  return { store, giveaway: result.giveaway, summary: result.summary };
}

async function publish(
  setup: Awaited<ReturnType<typeof drawn>>,
  placeholders?: PlaceholderEnvironment,
) {
  const h = harness();

  await publishResult(
    h.ctx,
    {
      store: setup.store,
      providers: new ProviderRegistry(),
      ...(placeholders ? { placeholders } : {}),
    },
    { giveaway: setup.giveaway, summary: setup.summary },
  );

  return h;
}

function environment(
  options: {
    server?: () => Promise<ServerFacts>;
    bot?: () => Promise<BotFacts>;
    now?: number;
  } = {},
) {
  const calls = { server: 0, bot: 0, user: 0 };

  const env: PlaceholderEnvironment = {
    applicationId: APPLICATION,
    async bot() {
      calls.bot += 1;
      return options.bot ? options.bot() : SAMPLE_BOT;
    },
    async server(guildId) {
      calls.server += 1;
      return options.server ? options.server() : { id: guildId, name: 'Proton HQ' };
    },
    async user() {
      calls.user += 1;
      return null;
    },
    now: () => options.now ?? NOW,
  };

  return { env, calls };
}

describe('the winner message', () => {
  test('each winner is told their own prize and place', async () => {
    const setup = await drawn({
      winMessage:
        'You won {giveaway.prize}, winner {giveaway.winner_position} of {giveaway.winner_count}.',
      prizes: [
        { label: 'Nitro', count: 1 },
        { label: 'A mug', count: 2 },
      ],
    });

    const h = await publish(setup);

    expect(h.dms().map((dm) => dm.content)).toEqual([
      'You won Nitro, winner 1 of 3.',
      'You won A mug, winner 2 of 3.',
      'You won A mug, winner 3 of 3.',
    ]);
  });

  test('the default message is byte-identical, with and without the giveaway link', async () => {
    const prizes = [
      { label: 'Nitro', count: 1 },
      { label: 'A *mug*', count: 2 },
    ];
    const { env, calls } = environment();

    const linked = await publish(await drawn({ prizes }), env);
    expect(linked.dms().map((dm) => dm.content)).toEqual([
      `You won **Nitro**! Congratulations. ${LINK}`,
      `You won **A *mug***! Congratulations. ${LINK}`,
      `You won **A *mug***! Congratulations. ${LINK}`,
    ]);

    const unlinked = await publish(await drawn({ messageId: null }), env);
    expect(unlinked.dms().map((dm) => dm.content)).toEqual([
      'You won **Nitro Classic**! Congratulations.',
      'You won **Nitro Classic**! Congratulations.',
      'You won **Nitro Classic**! Congratulations.',
    ]);

    expect(calls).toEqual({ server: 0, bot: 0, user: 0 });
  });

  test('a stored message without braces posts exactly as written', async () => {
    const message = 'Well **done**, _you_ won! DM <@400000000000000001> for your prize.';

    const h = await publish(await drawn({ winMessage: message }));

    expect(h.dms().map((dm) => dm.content)).toEqual([message, message, message]);
  });

  test('the idempotency keys and mention policy are unchanged', async () => {
    const setup = await drawn({ winMessage: 'You won {giveaway.prize}' });
    const h = await publish(setup);
    const root = `giveaways:${GUILD}:g1:${setup.summary.drawNumber}`;

    expect(
      h.requests
        .filter((request) => request.kind === 'create_dm')
        .map((request) => request.idempotencyKey),
    ).toEqual(setup.summary.winnerIds.map((id) => `${root}:${id}:dm-open`));

    expect(h.dms().map((dm) => dm.key)).toEqual(
      setup.summary.winnerIds.map((id) => `${root}:${id}:dm-send`),
    );

    for (const dm of h.dms()) expect(dm.allowedMentions).toEqual({ parse: [] });
  });

  test('host, winner, link and end time render', async () => {
    const setup = await drawn(
      {
        winMessage:
          '{giveaway.host} {user.mention} {user.id} {giveaway.message_url} ' +
          '{giveaway.ended_at:unix} {giveaway.title}',
      },
      1,
    );
    const [winner] = setup.summary.winnerIds;

    const h = await publish(setup);

    expect(h.dms().map((dm) => dm.content)).toEqual([
      `<@${HOST}> <@${winner}> ${winner} ${LINK} ${Math.floor(NOW / 1000)} Nitro Classic`,
    ]);
  });

  test('a reroll winner is told when the reroll ended it, not the first deadline', async () => {
    const setup = await drawn({ winnerCount: 1, winMessage: 'Ended {giveaway.ended_at:unix}' }, 3);
    const later = NOW + 2 * HOUR;

    const rerolled = await rerollGiveaway(
      { store: setup.store, providers: new ProviderRegistry(), now: () => later, seed: () => SEED },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST, count: 1 },
    );
    if (rerolled.outcome !== 'rerolled') throw new Error(`expected a reroll: ${rerolled.outcome}`);

    expect(rerolled.giveaway.endedAt).toBeNull();
    expect(rerolled.giveaway.endsAt.getTime()).toBe(NOW);

    const h = harness();
    await publishResult(
      h.ctx,
      {
        store: setup.store,
        providers: new ProviderRegistry(),
        placeholders: environment({ now: later }).env,
      },
      {
        giveaway: rerolled.giveaway,
        summary: rerolled.summary,
        reroll: true,
        replacedIds: rerolled.replaced,
      },
    );

    expect(h.dms().map((dm) => dm.content)).toEqual([`Ended ${Math.floor(later / 1000)}`]);
  });

  test('a giveaway whose message is gone has no link, and its fallback is used', async () => {
    const setup = await drawn(
      { messageId: null, winMessage: 'Link: {giveaway.message_url:fallback("gone")}' },
      1,
    );

    const h = await publish(setup);

    expect(h.dms().map((dm) => dm.content)).toEqual(['Link: gone']);
  });

  test('the claim deadline is the one recorded with the draw, read only when used', async () => {
    const claiming = await drawn(
      { claimWindowSeconds: 3600, winMessage: 'Claim by {giveaway.claim_deadline:unix}' },
      2,
    );
    let reads = 0;
    const winners = claiming.store.winners.bind(claiming.store);
    claiming.store.winners = async (giveawayId) => {
      reads += 1;
      return winners(giveawayId);
    };

    const h = await publish(claiming);

    const deadline = Math.floor((NOW + HOUR) / 1000);
    expect(h.dms().map((dm) => dm.content)).toEqual([
      `Claim by ${deadline}`,
      `Claim by ${deadline}`,
    ]);
    expect(reads).toBe(1);

    const unused = await drawn({ claimWindowSeconds: 3600, winMessage: 'Well done' }, 1);
    let unusedReads = 0;
    const unusedWinners = unused.store.winners.bind(unused.store);
    unused.store.winners = async (giveawayId) => {
      unusedReads += 1;
      return unusedWinners(giveawayId);
    };
    await publish(unused);
    expect(unusedReads).toBe(0);
  });

  test('without claiming, the claim deadline is not set', async () => {
    const setup = await drawn(
      { winMessage: 'Claim by {giveaway.claim_deadline:fallback("no need to claim")}' },
      1,
    );

    const h = await publish(setup);

    expect(h.dms().map((dm) => dm.content)).toEqual(['Claim by no need to claim']);
  });

  test('the server and Proton are read once per draw, and only when the message uses them', async () => {
    const quiet = environment();
    await publish(await drawn({ winMessage: 'You won {giveaway.prize}' }), quiet.env);
    expect(quiet.calls).toEqual({ server: 0, bot: 0, user: 0 });

    const loud = environment();
    const h = await publish(
      await drawn({ winMessage: '{server.name} and {bot.name} say well done' }),
      loud.env,
    );

    expect(h.dms().map((dm) => dm.content)).toEqual([
      'Proton HQ and Proton say well done',
      'Proton HQ and Proton say well done',
      'Proton HQ and Proton say well done',
    ]);
    expect(loud.calls).toEqual({ server: 1, bot: 1, user: 0 });
  });

  test('without the environment the message still goes, with those names empty', async () => {
    const h = await publish(
      await drawn({ winMessage: 'You won {giveaway.prize} in {server.name}.' }, 1),
    );

    expect(h.dms().map((dm) => dm.content)).toEqual(['You won Nitro Classic in .']);
    expect(h.warnings).toEqual([]);
  });

  test('a failed read is logged and the message still goes', async () => {
    const { env } = environment({
      server: async () => {
        throw new Error('redis is down');
      },
      bot: async () => {
        throw new Error('rest is down');
      },
    });

    const h = await publish(
      await drawn({ winMessage: 'Hello from {server.name}{bot.name:fallback("Proton")}!' }, 1),
      env,
    );

    expect(h.dms().map((dm) => dm.content)).toEqual(['Hello from Proton!']);
    expect(h.warnings.some((line) => line.includes('redis is down'))).toBe(true);
    expect(h.warnings.some((line) => line.includes('rest is down'))).toBe(true);
  });

  test('a message that comes out empty sends the default instead, and says why', async () => {
    const h = await publish(await drawn({ winMessage: '{server.name}' }, 1));

    expect(h.dms().map((dm) => dm.content)).toEqual([
      `You won **Nitro Classic**! Congratulations. ${LINK}`,
    ]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('came out empty');
  });

  test('unknown names post as written and doubled braces become one', async () => {
    const h = await publish(
      await drawn(
        { winMessage: 'Hi {nobody} {{x}} {constructor} {__proto__} {giveaway.__proto__}' },
        1,
      ),
    );

    expect(h.dms().map((dm) => dm.content)).toEqual([
      'Hi {nobody} {x} {constructor} {__proto__} {giveaway.__proto__}',
    ]);
  });

  test('a prize cannot ping everyone, format the message or mention a role', async () => {
    const h = await publish(
      await drawn(
        {
          winMessage: 'You won {giveaway.prize}',
          prizes: [{ label: '@everyone **free** <@&600000000000000001>', count: 1 }],
        },
        1,
      ),
    );

    const [dm] = h.dms();
    expect(dm?.content).not.toContain('@everyone');
    expect(dm?.content).toContain('@​everyone');
    expect(dm?.content).not.toContain('**');
    expect(dm?.content).not.toMatch(/(?<!\\)<@&/);
  });

  test('a winner message past 2000 characters is cut on a grapheme boundary', async () => {
    const h = await publish(
      await drawn(
        {
          winMessage: `${'a'.repeat(1995)}{giveaway.prize}`,
          prizes: [{ label: FAMILY, count: 1 }],
        },
        1,
      ),
    );

    expect(h.dms().map((dm) => dm.content)).toEqual(['a'.repeat(1995)]);
  });
});

describe('the direct message clip', () => {
  test('never splits a surrogate pair or a mention', async () => {
    const h = harness();

    await dmWinner(h.ctx, userId(1), `${'x'.repeat(1999)}\u{1F44D}`, 'root-a');
    await dmWinner(h.ctx, userId(1), `${'x'.repeat(1990)}<@400000000000002001>`, 'root-b');
    await dmWinner(h.ctx, userId(1), 'y'.repeat(2000), 'root-c');

    expect(h.dms().map((dm) => dm.content)).toEqual([
      'x'.repeat(1999),
      'x'.repeat(1990),
      'y'.repeat(2000),
    ]);
  });
});

describe('the winner message surface', () => {
  test('is private to the winner, with one message field', () => {
    expect(GIVEAWAY_WIN_SURFACE.id).toBe('giveaways.win_dm');
    expect(GIVEAWAY_WIN_SURFACE.module).toBe('giveaways');
    expect(GIVEAWAY_WIN_SURFACE.event).toBe(GIVEAWAY_WIN_EVENT);
    expect(GIVEAWAY_WIN_EVENT).toBe('giveaways.win');
    expect(GIVEAWAY_WIN_SURFACE.audience).toBe('member_private');
    expect(GIVEAWAY_WIN_SURFACE.fields.map((field) => field.path)).toEqual([WIN_MESSAGE_PATH]);
    expect(GIVEAWAY_WIN_SURFACE.fieldAt(WIN_MESSAGE_PATH)?.kind).toBe('discord_text');
    expect(GIVEAWAY_WIN_SURFACE.fieldAt(WIN_MESSAGE_PATH)?.limit).toBe(2000);
    expect(GIVEAWAY_WIN_SURFACE.fieldAt('title')).toBeUndefined();
  });

  test('offers the giveaway, the winner, the server name, Proton and the time', () => {
    expect(
      GIVEAWAY_WIN_SURFACE.pickerFor(WIN_MESSAGE_PATH)
        .map((definition) => definition.key)
        .sort(),
    ).toEqual(
      [
        'giveaway.title',
        'giveaway.prize',
        'giveaway.winner_count',
        'giveaway.winner_position',
        'giveaway.message_url',
        'giveaway.host',
        'giveaway.ended_at',
        'giveaway.claim_deadline',
        'user.id',
        'user.mention',
        'server.name',
        'bot.id',
        'bot.mention',
        'bot.name',
        'bot.avatar_url',
        'bot.website_url',
        'bot.support_url',
        'now',
        'today',
        'year',
      ].sort(),
    );
  });

  test('its sample renders coherently', () => {
    const [sample] = GIVEAWAY_WIN_SURFACE.samples;
    if (!sample) throw new Error('no sample');

    const rendered = renderWinMessage(
      'You won {giveaway.prize}, winner {giveaway.winner_position} of ' +
        '{giveaway.winner_count}, in {server.name}.',
      sample.facts,
      SAMPLE_NOW,
    );

    expect(sample.id).toBe('giveaway_winner');
    expect(rendered.output).toBe('You won Nitro Classic, winner 2 of 3, in Proton HQ.');
    expect(rendered.diagnostics).toEqual([]);
  });

  test('names from other surfaces only warn', () => {
    const result = validateTemplate('{user.nickname} {ticket.number} {level}', {
      registry: GIVEAWAY_WIN_SURFACE.registry,
      field: 'discord_text',
      event: GIVEAWAY_WIN_EVENT,
      audience: 'member_private',
    });

    expect(result.valid).toBe(true);
    expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.code))).toEqual(
      new Set(['unknown_placeholder']),
    );
  });

  test('a bad modifier argument is an error', () => {
    const result = validateTemplate('{giveaway.prize:upper(3)}', {
      registry: GIVEAWAY_WIN_SURFACE.registry,
      field: 'discord_text',
      event: GIVEAWAY_WIN_EVENT,
      audience: 'member_private',
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['invalid_argument']);
  });
});

describe('recurrence', () => {
  test('the next run copies the winner message as written, with nothing filled in', async () => {
    const store = new MemoryGiveawayStore();
    const template = 'You won {giveaway.prize} in {server.name} {{not a placeholder}}';

    const giveaway = await store.create({
      id: 'g1',
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: MESSAGE,
      hostId: HOST,
      title: 'Nitro Classic',
      winnerCount: 1,
      endsAt: new Date(NOW),
      createdBy: HOST,
      dmWinners: true,
      winMessage: template,
      recurrenceConfig: { everyMs: 24 * HOUR, runs: 3 },
      recurrenceLeft: 3,
    });

    const h = harness();
    const outcome = await scheduleNextRun(h.ctx, store, giveaway, 'start', new Date(NOW));
    if (outcome.outcome !== 'scheduled') throw new Error(`expected a next run: ${outcome.outcome}`);

    expect(outcome.giveaway.winMessage).toBe(template);
    expect(h.requests).toEqual([]);
  });
});
