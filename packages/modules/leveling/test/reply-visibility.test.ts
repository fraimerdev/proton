import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type CommandDefinition,
  leafPaths,
  type RawOption,
  replyControl,
} from '@proton/core';
import { levelingCommands } from '../src/commands.ts';
import { type LevelingConfig, levelingDefaultConfig } from '../src/config.ts';
import type { LevelingDeps } from '../src/deps.ts';
import type { LeaderboardEntry, MemberXpRecord } from '../src/store.ts';
import {
  APPLICATION,
  commandContext,
  FakeXpEventStore,
  FakeXpStore,
  GUILD,
  type ReplyOverrides,
  USER,
  workerContext,
} from './fakes.ts';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const TARGET = '400000000000000004';
const CHANNEL = '300000000000000009';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

type Name = 'rank' | 'leaderboard' | 'xp';

interface Leaf {
  label: string;
  name: Name;
  path: string;
  options: RawOption[];
  config?: Partial<LevelingConfig>;
  deps: () => LevelingDeps;
  privateBefore: boolean[];
  follows: boolean;
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

function ranked(): FakeXpStore {
  const store = storeWith();
  const entries: LeaderboardEntry[] = [{ userId: USER, xp: 1200, level: 5, rank: 1 }];
  store.leaderboard = async () => entries;
  return store;
}

function adjust(sub: string, options: RawOption[]): RawOption[] {
  return [{ name: sub, type: 1, options }];
}

function event(sub: string, options: RawOption[] = []): RawOption[] {
  return [{ name: 'event', type: 2, options: [{ name: sub, type: 1, options }] }];
}

const MEMBER_AND_AMOUNT: RawOption[] = [
  { name: 'user', type: 6, value: TARGET },
  { name: 'amount', type: 4, value: 500 },
];

const START: RawOption[] = [
  { name: 'multiplier', type: 10, value: 2 },
  { name: 'duration', type: 3, value: '2h' },
];

const card = (): LevelingDeps => ({
  xp: storeWith(record()),
  now: () => NOW,
  renderCard: async () => PNG,
  userProfile: async () => ({ displayName: 'Rin', avatarHash: null }),
});

const plainXp = (): LevelingDeps => ({ xp: storeWith(record()), now: () => NOW });
const events = (): LevelingDeps => ({
  xpEvents: new FakeXpEventStore(),
  applicationId: APPLICATION,
  now: () => NOW,
});

const LEAVES: Leaf[] = [
  {
    label: '/rank answers with the card',
    name: 'rank',
    path: '',
    options: [],
    config: { rankCard: true },
    deps: card,
    privateBefore: [false],
    follows: true,
  },
  {
    label: '/rank says the card could not be drawn',
    name: 'rank',
    path: '',
    options: [],
    config: { rankCard: true },
    deps: () => ({
      ...plainXp(),
      renderCard: async () => {
        throw new Error('resvg said no');
      },
    }),
    privateBefore: [false],
    follows: true,
  },
  {
    label: '/rank says rank cards are off',
    name: 'rank',
    path: '',
    options: [],
    deps: plainXp,
    privateBefore: [false],
    follows: true,
  },
  {
    label: '/rank says there is no XP yet',
    name: 'rank',
    path: '',
    options: [],
    deps: () => ({ xp: storeWith(), now: () => NOW }),
    privateBefore: [false],
    follows: true,
  },
  {
    label: '/rank refuses while Leveling is off',
    name: 'rank',
    path: '',
    options: [],
    config: { enabled: false },
    deps: plainXp,
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/rank refuses without its XP store',
    name: 'rank',
    path: '',
    options: [],
    deps: () => ({ now: () => NOW }),
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/leaderboard answers with the page',
    name: 'leaderboard',
    path: '',
    options: [],
    deps: () => ({ xp: ranked(), now: () => NOW }),
    privateBefore: [false],
    follows: true,
  },
  {
    label: '/leaderboard says nobody has XP yet',
    name: 'leaderboard',
    path: '',
    options: [],
    deps: () => ({ xp: storeWith(), now: () => NOW }),
    privateBefore: [false],
    follows: true,
  },
  {
    label: '/leaderboard says a page is past the end',
    name: 'leaderboard',
    path: '',
    options: [{ name: 'page', type: 4, value: 3 }],
    deps: () => ({ xp: storeWith(), now: () => NOW }),
    privateBefore: [false],
    follows: true,
  },
  {
    label: '/leaderboard refuses while Leveling is off',
    name: 'leaderboard',
    path: '',
    options: [],
    config: { enabled: false },
    deps: plainXp,
    privateBefore: [true],
    follows: false,
  },
  ...(['give', 'take', 'set'] as const).flatMap((sub): Leaf[] => [
    {
      label: `/xp ${sub} confirms the new total`,
      name: 'xp',
      path: sub,
      options: adjust(sub, MEMBER_AND_AMOUNT),
      deps: plainXp,
      privateBefore: [false],
      follows: true,
    },
    {
      label: `/xp ${sub} refuses without a member`,
      name: 'xp',
      path: sub,
      options: adjust(sub, [{ name: 'amount', type: 4, value: 500 }]),
      deps: plainXp,
      privateBefore: [true],
      follows: false,
    },
  ]),
  {
    label: '/xp give refuses while Leveling is off',
    name: 'xp',
    path: 'give',
    options: adjust('give', MEMBER_AND_AMOUNT),
    config: { enabled: false },
    deps: plainXp,
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/xp give refuses without its XP store',
    name: 'xp',
    path: 'give',
    options: adjust('give', MEMBER_AND_AMOUNT),
    deps: () => ({ now: () => NOW }),
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/xp event start starts one',
    name: 'xp',
    path: 'event.start',
    options: event('start', START),
    deps: events,
    privateBefore: [true, true],
    follows: false,
  },
  {
    label: '/xp event start refuses a bad duration',
    name: 'xp',
    path: 'event.start',
    options: event('start', [
      { name: 'multiplier', type: 10, value: 2 },
      { name: 'duration', type: 3, value: 'soon' },
    ]),
    deps: events,
    privateBefore: [true, true],
    follows: false,
  },
  {
    label: '/xp event end ends nothing',
    name: 'xp',
    path: 'event.end',
    options: event('end'),
    deps: events,
    privateBefore: [true, true],
    follows: false,
  },
  {
    label: '/xp event list lists none',
    name: 'xp',
    path: 'event.list',
    options: event('list'),
    deps: events,
    privateBefore: [true, true],
    follows: false,
  },
  {
    label: '/xp event start refuses while Leveling is off',
    name: 'xp',
    path: 'event.start',
    options: event('start', START),
    config: { enabled: false },
    deps: events,
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/xp event start refuses without its event store',
    name: 'xp',
    path: 'event.start',
    options: event('start', START),
    deps: () => ({ applicationId: APPLICATION, now: () => NOW }),
    privateBefore: [true],
    follows: false,
  },
];

const CASES = LEAVES.map((leaf) => [leaf.label, leaf] as const);

function commandOf(name: Name, deps: LevelingDeps): CommandDefinition<LevelingConfig> {
  const command = levelingCommands(deps).find((candidate) => candidate.name === name);
  if (!command) throw new Error(`leveling ships no /${name}`);
  return command;
}

async function runLeaf(leaf: Leaf, overrides: Partial<ReplyOverrides>) {
  const deps = leaf.deps();
  const command = commandOf(leaf.name, deps);
  const run = workerContext(command, leaf.options, leaf.config, overrides);
  await command.handler(run.ctx);
  return run;
}

const ANSWERS = new Set(['interaction_reply', 'interaction_followup']);

function answers(sent: ActionRequest[]) {
  return sent
    .filter((request) => ANSWERS.has(request.kind))
    .map((request) => {
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      return {
        kind: request.kind,
        key: request.idempotencyKey,
        callbackType: payload.callbackType,
        ephemeral: payload.ephemeral,
        flags: payload.flags,
      };
    });
}

function ephemeralOf(sent: ActionRequest[]): unknown[] {
  return answers(sent).map((answer) => answer.ephemeral);
}

async function runAnswering(leaf: Leaf, overrides: Partial<ReplyOverrides>) {
  const deps = leaf.deps();
  const command = commandOf(leaf.name, deps);
  const run = workerContext(command, leaf.options, leaf.config, overrides);
  run.ctx.applicationId = APPLICATION;
  await command.handler(run.ctx);
  return run;
}

function callbacks(sent: ActionRequest[]): ActionRequest[] {
  return sent.filter((request) => request.kind === 'interaction_reply');
}

function lastAnswer(sent: ActionRequest[]): ActionRequest | undefined {
  return sent.findLast((request) => ANSWERS.has(request.kind));
}

function copyOf(request: ActionRequest | undefined) {
  const payload = (request?.payload ?? {}) as Record<string, unknown>;
  return { content: payload.content, embeds: payload.embeds, files: payload.files };
}

const DEFERRED = CASES.filter(([, leaf]) => leaf.follows);
const ALWAYS_PRIVATE = CASES.filter(([, leaf]) => !leaf.follows);

describe('leveling reply policies', () => {
  test('the table names every leaf path of /rank, /leaderboard and /xp', () => {
    for (const name of ['rank', 'leaderboard', 'xp'] as const) {
      const paths = new Set(LEAVES.filter((leaf) => leaf.name === name).map((leaf) => leaf.path));
      expect({ name, paths: [...paths].sort() }).toEqual({
        name,
        paths: leafPaths(commandOf(name, {}).data).sort(),
      });
    }
  });

  test.each(['rank', 'leaderboard'] as const)(
    '/%s answers in public unless set otherwise',
    (name) => {
      const command = commandOf(name, {});

      expect(replyControl(command.reply, command.data, levelingDefaultConfig)).toEqual({
        supported: true,
        paths: [{ path: '', default: 'public', toggleable: true }],
      });
    },
  );

  test('/xp lets admins choose the adjustments, and keeps XP events private', () => {
    const command = commandOf('xp', {});

    expect(replyControl(command.reply, command.data, levelingDefaultConfig)).toEqual({
      supported: true,
      paths: [
        { path: 'give', default: 'public', toggleable: true },
        { path: 'take', default: 'public', toggleable: true },
        { path: 'set', default: 'public', toggleable: true },
        { path: 'event.start', default: 'private', toggleable: false },
        { path: 'event.end', default: 'private', toggleable: false },
        { path: 'event.list', default: 'private', toggleable: false },
      ],
    });
  });
});

describe('with no command setting', () => {
  test.each(CASES)('%s exactly as before', async (_label, leaf) => {
    const before = await runLeaf(leaf, { privateReply: undefined });
    const after = await runLeaf(leaf, { replyPreference: null });

    expect(after.sent).toEqual(before.sent);
    expect(ephemeralOf(after.sent)).toEqual(leaf.privateBefore);
  });

  test('an /xp event defers privately before its answer, as it always has', async () => {
    const leaf = LEAVES.find((candidate) => candidate.path === 'event.start') as Leaf;
    const run = await runLeaf(leaf, { replyPreference: null });

    expect(answers(run.sent).map(({ kind, callbackType }) => ({ kind, callbackType }))).toEqual([
      { kind: 'interaction_reply', callbackType: 5 },
      { kind: 'interaction_followup', callbackType: undefined },
    ]);
  });
});

describe.each([
  ['public', false],
  ['private', true],
] as const)('set %s on the Commands page', (_label, preference) => {
  test.each(CASES)('%s', async (_label, leaf) => {
    const run = await runLeaf(leaf, { replyPreference: preference });

    expect(ephemeralOf(run.sent)).toEqual(leaf.follows ? [preference] : leaf.privateBefore);
  });
});

describe('a private reply changes nothing but the reply', () => {
  test('an /xp event stays private even when a worker hands it a public reply', async () => {
    for (const leaf of LEAVES.filter((candidate) => candidate.path.startsWith('event.'))) {
      const run = await runLeaf(leaf, { privateReply: false });
      expect({ leaf: leaf.label, ephemeral: ephemeralOf(run.sent) }).toEqual({
        leaf: leaf.label,
        ephemeral: leaf.privateBefore,
      });
    }
  });

  test('a private /xp give still announces the level-up in the channel', async () => {
    const store = storeWith();
    store.adjust = async () => ({ xp: 1250, level: 3, previousLevel: 2, awarded: true });
    const deps: LevelingDeps = { xp: store, now: () => NOW };
    const command = commandOf('xp', deps);

    const run = workerContext(
      command,
      adjust('give', MEMBER_AND_AMOUNT),
      {},
      {
        replyPreference: true,
      },
    );
    await command.handler(run.ctx);

    expect(ephemeralOf(run.sent)).toEqual([true]);

    const announced = run.sent.filter((request) => request.kind === 'send');
    expect(announced).toHaveLength(1);
    expect(announced[0]?.payload).toMatchObject({ channelId: CHANNEL });
    expect(announced[0]?.payload).not.toHaveProperty('ephemeral');
  });
});

describe.each([
  ['no command setting', null, false],
  ['public set on the Commands page', false, false],
  ['private set on the Commands page', true, true],
] as const)('with an application id and %s', (_label, preference, ephemeral) => {
  test.each(CASES)('%s acknowledges the interaction exactly once', async (_label, leaf) => {
    const run = await runAnswering(leaf, { replyPreference: preference });

    expect(callbacks(run.sent)).toHaveLength(1);
  });

  test.each(DEFERRED)(
    '%s defers with the resolved visibility and follows up once with the same copy',
    async (_label, leaf) => {
      const deferred = await runAnswering(leaf, { replyPreference: preference });
      const replied = await runLeaf(leaf, { replyPreference: preference });

      expect(answers(deferred.sent)).toEqual([
        {
          kind: 'interaction_reply',
          key: 'interaction-event-1:defer',
          callbackType: 5,
          ephemeral,
          flags: undefined,
        },
        {
          kind: 'interaction_followup',
          key: 'interaction-event-1:followup',
          callbackType: undefined,
          ephemeral,
          flags: undefined,
        },
      ]);
      expect(copyOf(lastAnswer(deferred.sent))).toEqual(copyOf(lastAnswer(replied.sent)));
    },
  );

  test.each(ALWAYS_PRIVATE)('%s stays private, as it always has', async (_label, leaf) => {
    const run = await runAnswering(leaf, { replyPreference: preference });

    expect(ephemeralOf(run.sent)).toEqual(leaf.privateBefore);
  });
});

describe('a refusal under a public reply setting', () => {
  test.each(ALWAYS_PRIVATE.filter(([, leaf]) => !leaf.path.startsWith('event.')))(
    '%s is decided before any defer and answered privately in the one callback',
    async (_label, leaf) => {
      const run = await runAnswering(leaf, { privateReply: false });

      expect(answers(run.sent)).toEqual([
        {
          kind: 'interaction_reply',
          key: 'interaction-event-1:reply',
          callbackType: undefined,
          ephemeral: true,
          flags: undefined,
        },
      ]);
    },
  );
});

describe('without an application id', () => {
  test.each(DEFERRED)('%s still answers in the one callback', async (_label, leaf) => {
    const run = await runLeaf(leaf, { replyPreference: null });

    expect(answers(run.sent)).toEqual([
      {
        kind: 'interaction_reply',
        key: 'interaction-event-1:reply',
        callbackType: undefined,
        ephemeral: false,
        flags: undefined,
      },
    ]);
  });

  test('the process-wide application id is enough to defer', async () => {
    const deps: LevelingDeps = { ...plainXp(), applicationId: APPLICATION };
    const command = commandOf('rank', deps);
    const run = workerContext(command, [], {}, { replyPreference: null });
    await command.handler(run.ctx);

    expect(answers(run.sent).map(({ kind, callbackType }) => ({ kind, callbackType }))).toEqual([
      { kind: 'interaction_reply', callbackType: 5 },
      { kind: 'interaction_followup', callbackType: undefined },
    ]);
  });
});

describe('the defer comes before the XP store is read', () => {
  test.each([
    ['rank', []],
    ['leaderboard', []],
    ['xp', adjust('give', MEMBER_AND_AMOUNT)],
  ] as const)('/%s', async (name, options) => {
    const timeline: string[] = [];
    const store = storeWith(record());
    const read = <T>(work: Promise<T>): Promise<T> => {
      timeline.push('store');
      return work;
    };
    const get = store.get.bind(store);
    const board = store.leaderboard.bind(store);
    const change = store.adjust.bind(store);
    store.get = (guildId, userId) => read(get(guildId, userId));
    store.leaderboard = () => read(board());
    store.adjust = (input) => read(change(input));

    const command = commandOf(name, { xp: store, now: () => NOW });
    const { ctx } = commandContext([...options], {}, timeline);
    ctx.applicationId = APPLICATION;
    await command.handler(ctx);

    expect(timeline.slice(0, 2)).toEqual(['exec:interaction_reply', 'store']);
  });
});
