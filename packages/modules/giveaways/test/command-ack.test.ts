import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type CommandLabeler,
  formatCommandLabel,
  MESSAGE_FLAG_EPHEMERAL,
  OptionType,
  ProviderRegistry,
  type RawOption,
  toRestCall,
} from '@proton/core';
import { drawGiveaway } from '../src/end.ts';
import type { GiveawayStatus } from '../src/store.ts';
import {
  APPLICATION,
  CHANNEL,
  type CommandHarness,
  commandHarness,
  GUILD,
  group,
  HOST,
  isDefer,
  MEMBER,
  type RunOverrides,
  STRANGER,
  stringOption,
  subcommand,
  userOption,
} from './command-harness.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

const G1 = stringOption('giveaway', 'g1');
const NITRO = stringOption('prize', 'Nitro');

const PRE_ACK_READS = new Set(['store:get', 'store:resolve', 'store:countRunning']);

type Seed = (h: CommandHarness) => Promise<void>;
type Arrange = (h: CommandHarness) => void;

interface Payload {
  content?: string;
  embeds?: { description?: string }[];
  files?: unknown[];
  ephemeral?: boolean;
}

function payloadOf(request: ActionRequest | undefined): Payload {
  return (request?.payload ?? {}) as Payload;
}

function textOf(request: ActionRequest | undefined): string {
  const payload = payloadOf(request);
  return payload.content || payload.embeds?.[0]?.description || '';
}

function said(request: ActionRequest | undefined) {
  const payload = payloadOf(request);
  return { content: payload.content, embeds: payload.embeds, files: payload.files };
}

function restBody(request: ActionRequest | undefined): unknown {
  if (!request) return null;
  const mapped = toRestCall(request);
  return 'call' in mapped ? mapped.call.body : mapped;
}

function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}

async function create(
  h: CommandHarness,
  id: string,
  entrants: readonly string[],
  status?: GiveawayStatus,
): Promise<void> {
  await h.store.create({
    id,
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(NOW + 4 * HOUR),
    createdBy: HOST,
    shortCode: `${id.toUpperCase()}AB`,
  });

  for (const userId of entrants) {
    await h.store.enter({
      giveawayId: id,
      userId,
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
      pressedAt: new Date(NOW - HOUR),
    });
  }

  const row = h.store.giveaways.get(id);
  if (row && status) h.store.giveaways.set(id, { ...row, status });
}

async function draw(h: CommandHarness): Promise<void> {
  await drawGiveaway(
    { store: h.store, providers: new ProviderRegistry(), now: () => NOW - HOUR },
    { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
  );
}

const running: Seed = (h) => create(h, 'g1', [MEMBER, STRANGER]);
const empty: Seed = (h) => create(h, 'g1', []);
const inState =
  (status: GiveawayStatus): Seed =>
  (h) =>
    create(h, 'g1', [MEMBER, STRANGER], status);

const ended: Seed = async (h) => {
  await running(h);
  await draw(h);
};

const everybodyWon: Seed = async (h) => {
  await create(h, 'g1', [MEMBER]);
  await draw(h);
};

const paused: Seed = async (h) => {
  await running(h);
  await h.store.pause(GUILD, 'g1', HOST, null, new Date(NOW - 60_000));
};

const granted: Seed = async (h) => {
  await running(h);
  await h.store.grantBonus({
    id: 'b1',
    giveawayId: 'g1',
    userId: MEMBER,
    amount: 2,
    reason: null,
    grantedBy: HOST,
  });
};

const atLimit: Seed = async (h) => {
  for (const id of ['g1', 'g2', 'g3']) await create(h, id, []);
};

const REWARD_ROLE = '900000000000000001';

const rewarded: Seed = async (h) => {
  await create(h, 'g1', [MEMBER]);
  const row = h.store.giveaways.get('g1');
  if (row) h.store.giveaways.set('g1', { ...row, rewardRoleId: REWARD_ROLE });
};

const anotherWorkerRecordedTheDraw: Arrange = (h) => {
  Object.assign(h.store, { recordDraw: async () => 'already-drawn' });
};

type Racy = 'beginDraw' | 'finishDraw' | 'pause' | 'resume' | 'patch';

function race(method: Racy, status: GiveawayStatus): Arrange {
  return (h) => {
    const store = h.store;
    const original = store[method] as (...args: unknown[]) => Promise<unknown>;

    Object.assign(store, {
      [method]: (...args: unknown[]) => {
        const row = store.giveaways.get('g1');
        if (row) store.giveaways.set('g1', { ...row, status });
        return original.apply(store, args);
      },
    });
  };
}

const discordRefusesTheCard: Arrange = (h) => {
  h.refuse.add('send');
};

interface AckCase {
  name: string;
  path: string;
  raw: RawOption[];
  toggleable: boolean;
  seed?: Seed;
  arrange?: Arrange;
  says: string;
  refused?: boolean;
}

const ACK_CASES: AckCase[] = [
  {
    name: 'a start that posts its card',
    path: 'start',
    raw: subcommand('start', [stringOption('duration', '12h'), NITRO]),
    toggleable: true,
    says: '**Nitro** is live',
  },
  {
    name: 'a start whose card Discord refuses',
    path: 'start',
    raw: subcommand('start', [stringOption('duration', '12h'), NITRO]),
    toggleable: true,
    arrange: discordRefusesTheCard,
    says: '**Nitro** was created, but I couldn’t post it',
    refused: true,
  },
  {
    name: 'a drop that posts its card',
    path: 'drop',
    raw: subcommand('drop', [NITRO]),
    toggleable: true,
    says: '**Nitro** is up for grabs',
  },
  {
    name: 'a drop whose card Discord refuses',
    path: 'drop',
    raw: subcommand('drop', [NITRO]),
    toggleable: true,
    arrange: discordRefusesTheCard,
    says: '**Nitro** was created, but I couldn’t post it',
    refused: true,
  },
  {
    name: 'an end that draws',
    path: 'end',
    raw: subcommand('end', [G1]),
    toggleable: true,
    seed: running,
    says: '**A prize** has been drawn: 1 winner from 2 entrants.',
  },
  {
    name: 'an end that loses the draw to another worker',
    path: 'end',
    raw: subcommand('end', [G1]),
    toggleable: true,
    seed: running,
    arrange: race('beginDraw', 'ended'),
    says: 'That giveaway has already been drawn. Use `/giveaway reroll` instead.',
    refused: true,
  },
  {
    name: 'an end that gives the winner the reward role',
    path: 'end',
    raw: subcommand('end', [G1]),
    toggleable: true,
    seed: rewarded,
    says: '**A prize** has been drawn: 1 winner from 1 entrant.',
  },
  {
    name: 'an end whose draw another worker recorded first',
    path: 'end',
    raw: subcommand('end', [G1]),
    toggleable: true,
    seed: running,
    arrange: anotherWorkerRecordedTheDraw,
    says: 'That giveaway has already been drawn. Use `/giveaway reroll` instead.',
    refused: true,
  },
  {
    name: 'an end that finds the giveaway paused under it',
    path: 'end',
    raw: subcommand('end', [G1]),
    toggleable: true,
    seed: running,
    arrange: race('beginDraw', 'paused'),
    says: 'That giveaway is paused. Resume it with `/giveaway resume` before you end it.',
    refused: true,
  },
  {
    name: 'a reroll that draws',
    path: 'reroll',
    raw: subcommand('reroll', [G1]),
    toggleable: true,
    seed: ended,
    says: '**A prize** has been rerolled: 1 new winner.',
  },
  {
    name: 'a reroll that finds nobody left',
    path: 'reroll',
    raw: subcommand('reroll', [G1]),
    toggleable: true,
    seed: everybodyWon,
    says: 'There was nobody left to draw',
    refused: true,
  },
  {
    name: 'a cancel that cancels',
    path: 'cancel',
    raw: subcommand('cancel', [G1]),
    toggleable: true,
    seed: running,
    says: '**A prize** has been cancelled. Nobody was drawn.',
  },
  {
    name: 'a cancel that loses to a draw',
    path: 'cancel',
    raw: subcommand('cancel', [G1]),
    toggleable: true,
    seed: running,
    arrange: race('finishDraw', 'ended'),
    says: 'That giveaway is already over, so there’s nothing to cancel.',
    refused: true,
  },
  {
    name: 'a pause that pauses',
    path: 'pause',
    raw: subcommand('pause', [G1]),
    toggleable: true,
    seed: running,
    says: '**A prize** has been paused.',
  },
  {
    name: 'a pause that loses to a draw',
    path: 'pause',
    raw: subcommand('pause', [G1]),
    toggleable: true,
    seed: running,
    arrange: race('pause', 'ended'),
    says: '**A prize** has already ended, so it can’t be paused.',
    refused: true,
  },
  {
    name: 'a resume that reopens',
    path: 'resume',
    raw: subcommand('resume', [G1]),
    toggleable: true,
    seed: paused,
    says: '**A prize** is running again',
  },
  {
    name: 'a resume that loses to a cancel',
    path: 'resume',
    raw: subcommand('resume', [G1]),
    toggleable: true,
    seed: paused,
    arrange: race('resume', 'cancelled'),
    says: '**A prize** was cancelled, so it can’t be resumed.',
    refused: true,
  },
  {
    name: 'an extend that moves the deadline',
    path: 'extend',
    raw: subcommand('extend', [G1, stringOption('duration', '1h')]),
    toggleable: true,
    seed: running,
    says: `**A prize** now ends <t:${(NOW + 5 * HOUR) / 1000}:R>.`,
  },
  {
    name: 'an extend that loses to a draw',
    path: 'extend',
    raw: subcommand('extend', [G1, stringOption('duration', '1h')]),
    toggleable: true,
    seed: running,
    arrange: race('patch', 'ended'),
    says: '**A prize** has already ended, so it can’t be extended.',
    refused: true,
  },
  {
    name: 'a shorten that moves the deadline',
    path: 'shorten',
    raw: subcommand('shorten', [G1, stringOption('duration', '1h')]),
    toggleable: true,
    seed: running,
    says: `**A prize** now ends <t:${(NOW + 3 * HOUR) / 1000}:R>.`,
  },
  {
    name: 'a shorten that loses to a draw',
    path: 'shorten',
    raw: subcommand('shorten', [G1, stringOption('duration', '1h')]),
    toggleable: true,
    seed: running,
    arrange: race('patch', 'ended'),
    says: '**A prize** has already ended, so it can’t be shortened.',
    refused: true,
  },
  {
    name: 'an edit that repaints the card',
    path: 'edit',
    raw: subcommand('edit', [G1, stringOption('prize', 'A bigger prize')]),
    toggleable: true,
    seed: running,
    says: '**A bigger prize** has been updated.',
  },
  {
    name: 'an edit that loses to a draw',
    path: 'edit',
    raw: subcommand('edit', [G1, stringOption('prize', 'A bigger prize')]),
    toggleable: true,
    seed: running,
    arrange: race('patch', 'ended'),
    says: '**A prize** has already ended, so it can’t be edited.',
    refused: true,
  },
  {
    name: 'an export that hands over the file',
    path: 'export',
    raw: subcommand('export', [G1]),
    toggleable: false,
    seed: running,
    says: 'Exported 2 entrants from **A prize**.',
  },
  {
    name: 'an export with nobody in it',
    path: 'export',
    raw: subcommand('export', [G1]),
    toggleable: false,
    seed: empty,
    says: 'Nobody has entered **A prize**, so there’s nothing to export.',
    refused: true,
  },
  {
    name: 'an entrants page',
    path: 'entrants',
    raw: subcommand('entrants', [G1]),
    toggleable: false,
    seed: running,
    says: '**A prize** · 2 entrants',
  },
  {
    name: 'a template save',
    path: 'template.save',
    raw: group('template', 'save', [stringOption('name', 'weekly'), G1]),
    toggleable: false,
    seed: running,
    says: 'Saved **weekly** as a template.',
  },
  {
    name: 'a bonus grant',
    path: 'bonus.add',
    raw: group('bonus', 'add', [G1, userOption('member', MEMBER), integerOption('entries', 2)]),
    toggleable: false,
    seed: running,
    says: `<@${MEMBER}> now has **+2** extra entries in **A prize**.`,
  },
  {
    name: 'a bonus taken back',
    path: 'bonus.remove',
    raw: group('bonus', 'remove', [G1, userOption('member', MEMBER)]),
    toggleable: false,
    seed: granted,
    says: `Took back **2** extra entries from <@${MEMBER}> in **A prize**.`,
  },
  {
    name: 'a bonus with nothing to take back',
    path: 'bonus.remove',
    raw: group('bonus', 'remove', [G1, userOption('member', MEMBER)]),
    toggleable: false,
    seed: running,
    says: `<@${MEMBER}> has no extra entries in **A prize** to take back.`,
    refused: true,
  },
];

async function ran(
  c: { raw: RawOption[]; seed?: Seed; arrange?: Arrange },
  overrides: Partial<RunOverrides>,
): Promise<CommandHarness> {
  const h = commandHarness({ now: () => NOW });
  await c.seed?.(h);
  c.arrange?.(h);
  await h.run(c.raw, { idempotencyKey: 'evt-ack', ...overrides });
  return h;
}

const ANSWERS = new Set(['interaction_reply', 'interaction_followup']);

function followupsOf(h: CommandHarness): ActionRequest[] {
  return h.requests.filter((request) => request.kind === 'interaction_followup');
}

const PREFERENCES = [
  ['with no setting', null],
  ['set private', true],
  ['set public', false],
] as const;

describe('/giveaway acknowledges before it draws, writes or calls Discord', () => {
  for (const c of ACK_CASES) {
    for (const [setting, preference] of PREFERENCES) {
      const ephemeral = c.toggleable ? (preference ?? true) : true;

      test(`${c.name}, ${setting}: one ${ephemeral ? 'private' : 'public'} defer first`, async () => {
        const h = await ran(c, { replyPreference: preference });

        const initial = h.requests.filter((request) => request.kind === 'interaction_reply');
        expect(initial).toHaveLength(1);
        expect(h.requests[0]).toBe(initial[0] as ActionRequest);
        expect(isDefer(initial[0] as ActionRequest)).toBe(true);
        expect(restBody(initial[0])).toEqual(
          ephemeral ? { type: 5, data: { flags: MESSAGE_FLAG_EPHEMERAL } } : { type: 5 },
        );

        const acknowledged = h.timeline.indexOf('execute:interaction_reply');
        expect(acknowledged).toBeGreaterThan(-1);
        expect(
          h.timeline.slice(0, acknowledged).filter((step) => !PRE_ACK_READS.has(step)),
        ).toEqual([]);
      });

      test(`${c.name}, ${setting}: answered by followup in the words it always used`, async () => {
        const h = await ran(c, { replyPreference: preference });
        const followups = followupsOf(h);

        for (const followup of followups) {
          const mapped = toRestCall(followup);
          expect('call' in mapped && mapped.call.path).toBe(
            `/webhooks/${APPLICATION}/interaction-token`,
          );
        }

        if (c.refused && !ephemeral) {
          expect(followups).toHaveLength(2);
          expect(payloadOf(followups[0])).toMatchObject({
            content: `\`${formatCommandLabel('giveaway', c.path)}\` didn’t go through.`,
            ephemeral: false,
          });
          expect(payloadOf(followups[0])).not.toHaveProperty('embeds');
          expect(payloadOf(followups[1]).ephemeral).toBe(true);
          expect(followups[0]?.idempotencyKey).not.toBe(followups[1]?.idempotencyKey);
        } else {
          expect(followups).toHaveLength(1);
          expect(payloadOf(followups[0]).ephemeral).toBe(ephemeral);
        }

        expect(textOf(followups.at(-1))).toContain(c.says);

        const replied = await ran(c, { replyPreference: preference, applicationId: null });
        const callbacks = replied.requests.filter((request) => ANSWERS.has(request.kind));

        expect(callbacks).toHaveLength(1);
        expect(callbacks[0]?.kind).toBe('interaction_reply');
        expect(isDefer(callbacks[0] as ActionRequest)).toBe(false);
        expect(payloadOf(callbacks[0]).ephemeral).toBe(c.refused ? true : ephemeral);
        expect(said(followups.at(-1))).toEqual(said(callbacks[0]));
      });
    }
  }

  test('the public notice names the command as this server renamed it', async () => {
    const renamed: CommandLabeler = (key, path) =>
      formatCommandLabel(key, path, key === 'giveaway' ? 'gw' : undefined);

    const h = await ran(
      { raw: subcommand('end', [G1]), seed: running, arrange: race('beginDraw', 'ended') },
      { replyPreference: false, commandLabel: renamed },
    );

    expect(payloadOf(followupsOf(h)[0]).content).toBe('`/gw end` didn’t go through.');
    expect(textOf(followupsOf(h)[1])).toContain('Use `/gw reroll` instead.');
  });

  test('the application id the interaction carries is enough to defer', async () => {
    const h = commandHarness({ now: () => NOW });
    await running(h);

    await h.run(subcommand('end', [G1]), {
      applicationId: '800000000000000002',
      deps: { store: h.store, providers: new ProviderRegistry(), now: () => NOW },
    });

    expect(isDefer(h.requests[0] as ActionRequest)).toBe(true);
    expect(followupsOf(h).map((request) => request.payload)).toMatchObject([
      { applicationId: '800000000000000002' },
    ]);
  });

  test('a redelivered end draws once and follows up once', async () => {
    const h = commandHarness({ now: () => NOW });
    await running(h);

    await h.run(subcommand('end', [G1]), { idempotencyKey: 'evt-again' });
    await h.run(subcommand('end', [G1]), { idempotencyKey: 'evt-again' });

    expect(h.store.drawRows).toHaveLength(1);
    expect(followupsOf(h)).toHaveLength(1);
  });

  test('an end gives the winner the reward role before it answers', async () => {
    const h = await ran({ raw: subcommand('end', [G1]), seed: rewarded }, {});

    const granted = h.requests.filter((request) => request.kind === 'add_role');
    expect(granted.map((request) => request.payload)).toEqual([
      { userId: MEMBER, roleId: REWARD_ROLE },
    ]);
    expect(h.requests.indexOf(granted[0] as ActionRequest)).toBeLessThan(
      h.requests.indexOf(followupsOf(h)[0] as ActionRequest),
    );
  });

  test('a public notice that does not post keeps the private reason out of the channel', async () => {
    const h = await ran(
      {
        raw: subcommand('end', [G1]),
        seed: running,
        arrange: (racing) => {
          race('beginDraw', 'ended')(racing);
          racing.refuseFirst.add('interaction_followup');
        },
      },
      { replyPreference: false },
    );

    expect(followupsOf(h)).toHaveLength(1);
    expect(payloadOf(followupsOf(h)[0])).toMatchObject({
      content: '`/giveaway end` didn’t go through.',
      ephemeral: false,
    });
    expect(h.warnings.some((line) => line.includes('did not tell the invoker'))).toBe(true);
  });
});

interface RefusalCase {
  name: string;
  raw: RawOption[];
  seed?: Seed;
  userId?: string;
  says: string;
}

const REFUSAL_CASES: RefusalCase[] = [
  {
    name: 'a start with a duration it cannot read',
    raw: subcommand('start', [stringOption('duration', 'soon'), NITRO]),
    says: 'soon',
  },
  {
    name: 'a start past the running-giveaway limit',
    raw: subcommand('start', [stringOption('duration', '12h'), NITRO]),
    seed: atLimit,
    says: 'running giveaways',
  },
  {
    name: 'a drop past the running-giveaway limit',
    raw: subcommand('drop', [NITRO]),
    seed: atLimit,
    says: 'running giveaways',
  },
  {
    name: 'an end naming no giveaway',
    raw: subcommand('end', [stringOption('giveaway', 'nope')]),
    says: 'Couldn’t find a giveaway with that ID in this server.',
  },
  {
    name: 'an end on a drawn giveaway',
    raw: subcommand('end', [G1]),
    seed: ended,
    says: 'That giveaway has already been drawn. Use `/giveaway reroll` instead.',
  },
  {
    name: 'an end on a giveaway being drawn',
    raw: subcommand('end', [G1]),
    seed: inState('drawing'),
    says: 'That giveaway is being drawn right now.',
  },
  {
    name: 'an end on a cancelled giveaway',
    raw: subcommand('end', [G1]),
    seed: inState('cancelled'),
    says: 'That giveaway was cancelled, so there’s nobody to draw.',
  },
  {
    name: 'an end on a paused giveaway',
    raw: subcommand('end', [G1]),
    seed: paused,
    says: 'That giveaway is paused. Resume it with `/giveaway resume` before you end it.',
  },
  {
    name: 'an end on a giveaway that has not started',
    raw: subcommand('end', [G1]),
    seed: inState('scheduled'),
    says: 'That giveaway hasn’t started yet, so there’s nobody to draw.',
  },
  {
    name: 'a cancel on a drawn giveaway',
    raw: subcommand('cancel', [G1]),
    seed: ended,
    says: 'That giveaway is already over, so there’s nothing to cancel.',
  },
  {
    name: 'a cancel naming no giveaway',
    raw: subcommand('cancel', [stringOption('giveaway', 'nope')]),
    says: 'Couldn’t find a giveaway with that ID in this server.',
  },
  {
    name: 'a reroll on a running giveaway',
    raw: subcommand('reroll', [G1]),
    seed: running,
    says: 'That giveaway hasn’t been drawn yet. Use `/giveaway end` first.',
  },
  {
    name: 'a reroll on a cancelled giveaway',
    raw: subcommand('reroll', [G1]),
    seed: inState('cancelled'),
    says: 'That giveaway was cancelled, so there are no winners to reroll.',
  },
  {
    name: 'a pause on somebody else’s giveaway',
    raw: subcommand('pause', [G1]),
    seed: running,
    userId: STRANGER,
    says: 'giveaway manager',
  },
  {
    name: 'a pause on a paused giveaway',
    raw: subcommand('pause', [G1]),
    seed: paused,
    says: '**A prize** is already paused.',
  },
  {
    name: 'a resume on a running giveaway',
    raw: subcommand('resume', [G1]),
    seed: running,
    says: '**A prize** is already running.',
  },
  {
    name: 'a shorten into the past',
    raw: subcommand('shorten', [G1, stringOption('duration', '7d')]),
    seed: running,
    says: 'That would move the end of **A prize** into the past.',
  },
  {
    name: 'an extend on a drawn giveaway',
    raw: subcommand('extend', [G1, stringOption('duration', '1h')]),
    seed: ended,
    says: '**A prize** has already ended, so it can’t be extended.',
  },
  {
    name: 'an edit naming nothing to change',
    raw: subcommand('edit', [G1]),
    seed: running,
    says: 'Choose at least one thing to change.',
  },
  {
    name: 'an edit on a drawn giveaway',
    raw: subcommand('edit', [G1, stringOption('prize', 'A bigger prize')]),
    seed: ended,
    says: '**A prize** has already ended, so it can’t be edited.',
  },
  {
    name: 'an export naming no giveaway',
    raw: subcommand('export', [stringOption('giveaway', 'nope')]),
    says: 'Couldn’t find a giveaway with that ID or code in this server.',
  },
  {
    name: 'a template save naming no giveaway',
    raw: group('template', 'save', [stringOption('name', 'weekly'), stringOption('giveaway', 'x')]),
    says: 'Couldn’t find a giveaway with that ID in this server.',
  },
  {
    name: 'a bonus grant out of range',
    raw: group('bonus', 'add', [G1, userOption('member', MEMBER), integerOption('entries', 0)]),
    seed: running,
    says: 'Grant between',
  },
];

describe('/giveaway refuses what one read can tell it in a single private reply', () => {
  test.each(REFUSAL_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const h = await ran(c, {
      replyPreference: false,
      ...(c.userId ? { userId: c.userId } : {}),
    });

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.kind).toBe('interaction_reply');
    expect(isDefer(h.requests[0] as ActionRequest)).toBe(false);
    expect(payloadOf(h.requests[0]).ephemeral).toBe(true);
    expect(textOf(h.requests[0])).toContain(c.says);
    expect(
      h.timeline.filter((step) => !step.startsWith('execute:') && !PRE_ACK_READS.has(step)),
    ).toEqual([]);
  });
});

describe('/giveaway end says what state the giveaway is really in', () => {
  test.each(['cancelled', 'paused', 'scheduled'] as const)(
    'a %s giveaway is not sent to /giveaway reroll',
    async (status) => {
      const h = await ran({ raw: subcommand('end', [G1]), seed: inState(status) }, {});

      expect(textOf(h.requests[0])).not.toContain('reroll');
      expect(textOf(h.requests[0])).not.toContain('already been drawn');
      expect(h.store.giveaways.get('g1')?.status).toBe(status);
    },
  );

  test('a paused giveaway points at the renamed resume command', async () => {
    const renamed: CommandLabeler = (key, path) =>
      formatCommandLabel(key, path, key === 'giveaway' ? 'gw' : undefined);

    const h = await ran({ raw: subcommand('end', [G1]), seed: paused }, { commandLabel: renamed });

    expect(textOf(h.requests[0])).toContain(
      'That giveaway is paused. Resume it with `/gw resume` before you end it.',
    );
  });
});
