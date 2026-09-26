import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  leafPaths,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  OptionType,
  ProviderRegistry,
  type RawOption,
  replyControl,
} from '@proton/core';
import { MemoryDraftStore } from '../src/builder/state.ts';
import { giveawayCommand } from '../src/commands.ts';
import { giveawaysConfigSchema } from '../src/config.ts';
import type { GiveawaysDeps } from '../src/deps.ts';
import { drawGiveaway } from '../src/end.ts';
import {
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
const GIVEAWAY_CHANNEL = '500000000000000000';
const GIVEAWAY_MESSAGE = '700000000000000000';

const TOGGLEABLE = [
  'start',
  'drop',
  'end',
  'reroll',
  'cancel',
  'pause',
  'resume',
  'extend',
  'shorten',
  'edit',
];

type Seed = (h: CommandHarness) => Promise<void>;

interface Leaf {
  label: string;
  path: string;
  raw: RawOption[];
  seed?: Seed;
  deps?: Partial<GiveawaysDeps>;
  userId?: string;
  follows: boolean;
  deferred?: boolean;
}

function visibility(leaf: Leaf, ephemeral: boolean): boolean[] {
  return leaf.deferred ? [ephemeral, ephemeral] : [ephemeral];
}

function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}

const running: Seed = async (h) => {
  await h.store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: GIVEAWAY_CHANNEL,
    messageId: GIVEAWAY_MESSAGE,
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(Date.now() + 4 * HOUR),
    createdBy: HOST,
  });

  for (const userId of [MEMBER, STRANGER]) {
    await h.store.enter({
      giveawayId: 'g1',
      userId,
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
      pressedAt: new Date(),
    });
  }
};

const ended: Seed = async (h) => {
  await running(h);
  await drawGiveaway(
    { store: h.store, providers: new ProviderRegistry() },
    { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
  );
};

const paused: Seed = async (h) => {
  await running(h);
  await h.store.pause(GUILD, 'g1', HOST, null, new Date(Date.now() - 60_000));
};

const templated: Seed = async (h) => {
  await h.store.saveTemplate({
    id: 't1',
    guildId: GUILD,
    name: 'weekly',
    createdBy: HOST,
    payload: { title: 'Nitro', durationMs: 12 * HOUR, winnerCount: 1 },
  });
};

const builder: Partial<GiveawaysDeps> = {
  drafts: new MemoryDraftStore(),
  availability: { isEnabled: async () => true },
};

const G1 = stringOption('giveaway', 'g1');
const NOPE = stringOption('giveaway', 'nope');
const NITRO = stringOption('prize', 'Nitro');

const LEAVES: Leaf[] = [
  {
    label: 'create opens the builder',
    path: 'create',
    raw: subcommand('create'),
    deps: builder,
    follows: false,
  },
  {
    label: 'start posts a giveaway',
    path: 'start',
    raw: subcommand('start', [stringOption('duration', '12h'), NITRO]),
    follows: true,
    deferred: true,
  },
  {
    label: 'start refuses a duration it cannot read',
    path: 'start',
    raw: subcommand('start', [stringOption('duration', 'soon'), NITRO]),
    follows: false,
  },
  {
    label: 'drop posts a drop',
    path: 'drop',
    raw: subcommand('drop', [NITRO]),
    follows: true,
    deferred: true,
  },
  {
    label: 'drop refuses an expiry it cannot read',
    path: 'drop',
    raw: subcommand('drop', [NITRO, stringOption('expires', 'soon')]),
    follows: false,
  },
  {
    label: 'end draws a running giveaway',
    path: 'end',
    raw: subcommand('end', [G1]),
    seed: running,
    follows: true,
    deferred: true,
  },
  {
    label: 'end refuses a giveaway that does not exist',
    path: 'end',
    raw: subcommand('end', [NOPE]),
    follows: false,
  },
  {
    label: 'cancel cancels a running giveaway',
    path: 'cancel',
    raw: subcommand('cancel', [G1]),
    seed: running,
    follows: true,
    deferred: true,
  },
  {
    label: 'cancel refuses a giveaway that does not exist',
    path: 'cancel',
    raw: subcommand('cancel', [NOPE]),
    follows: false,
  },
  {
    label: 'reroll draws an ended giveaway again',
    path: 'reroll',
    raw: subcommand('reroll', [G1]),
    seed: ended,
    follows: true,
    deferred: true,
  },
  {
    label: 'reroll refuses a giveaway still running',
    path: 'reroll',
    raw: subcommand('reroll', [G1]),
    seed: running,
    follows: false,
  },
  {
    label: 'pause pauses a running giveaway',
    path: 'pause',
    raw: subcommand('pause', [G1]),
    seed: running,
    follows: true,
    deferred: true,
  },
  {
    label: 'pause refuses somebody else’s giveaway',
    path: 'pause',
    raw: subcommand('pause', [G1]),
    seed: running,
    userId: STRANGER,
    follows: false,
  },
  {
    label: 'resume reopens a paused giveaway',
    path: 'resume',
    raw: subcommand('resume', [G1]),
    seed: paused,
    follows: true,
    deferred: true,
  },
  {
    label: 'resume refuses a giveaway that is not paused',
    path: 'resume',
    raw: subcommand('resume', [G1]),
    seed: running,
    follows: false,
  },
  {
    label: 'extend moves the deadline out',
    path: 'extend',
    raw: subcommand('extend', [G1, stringOption('duration', '1h')]),
    seed: running,
    follows: true,
    deferred: true,
  },
  {
    label: 'shorten brings the deadline in',
    path: 'shorten',
    raw: subcommand('shorten', [G1, stringOption('duration', '1h')]),
    seed: running,
    follows: true,
    deferred: true,
  },
  {
    label: 'shorten refuses a deadline in the past',
    path: 'shorten',
    raw: subcommand('shorten', [G1, stringOption('duration', '7d')]),
    seed: running,
    follows: false,
  },
  {
    label: 'edit changes a posted giveaway',
    path: 'edit',
    raw: subcommand('edit', [G1, stringOption('prize', 'A bigger prize')]),
    seed: running,
    follows: true,
    deferred: true,
  },
  {
    label: 'edit refuses when nothing is named to change',
    path: 'edit',
    raw: subcommand('edit', [G1]),
    seed: running,
    follows: false,
  },
  {
    label: 'info describes a giveaway',
    path: 'info',
    raw: subcommand('info', [G1]),
    seed: running,
    follows: false,
  },
  {
    label: 'entrants lists who entered',
    path: 'entrants',
    raw: subcommand('entrants', [G1]),
    seed: running,
    follows: false,
    deferred: true,
  },
  {
    label: 'export hands over the entrant file',
    path: 'export',
    raw: subcommand('export', [G1]),
    seed: running,
    follows: false,
    deferred: true,
  },
  {
    label: 'history lists what happened',
    path: 'history',
    raw: subcommand('history', [G1]),
    seed: running,
    follows: false,
  },
  {
    label: 'stats totals the server',
    path: 'stats',
    raw: subcommand('stats'),
    seed: running,
    follows: false,
  },
  {
    label: 'list shows the running giveaways',
    path: 'list',
    raw: subcommand('list'),
    seed: running,
    follows: false,
  },
  {
    label: 'entries shows who holds entries',
    path: 'entries',
    raw: subcommand('entries', [G1]),
    seed: running,
    follows: false,
  },
  {
    label: 'template save saves a template',
    path: 'template.save',
    raw: group('template', 'save', [stringOption('name', 'weekly'), G1]),
    seed: running,
    follows: false,
    deferred: true,
  },
  {
    label: 'template load opens the builder from a template',
    path: 'template.load',
    raw: group('template', 'load', [stringOption('name', 'weekly')]),
    seed: templated,
    deps: builder,
    follows: false,
  },
  {
    label: 'template list lists the templates',
    path: 'template.list',
    raw: group('template', 'list'),
    seed: templated,
    follows: false,
  },
  {
    label: 'template delete deletes a template',
    path: 'template.delete',
    raw: group('template', 'delete', [stringOption('name', 'weekly')]),
    seed: templated,
    follows: false,
  },
  {
    label: 'bonus add grants extra entries',
    path: 'bonus.add',
    raw: group('bonus', 'add', [G1, userOption('member', MEMBER), integerOption('entries', 2)]),
    seed: running,
    follows: false,
    deferred: true,
  },
  {
    label: 'bonus remove says there is nothing to take back',
    path: 'bonus.remove',
    raw: group('bonus', 'remove', [G1, userOption('member', MEMBER)]),
    seed: running,
    follows: false,
    deferred: true,
  },
  {
    label: 'bonus list lists the grants',
    path: 'bonus.list',
    raw: group('bonus', 'list', [G1]),
    seed: running,
    follows: false,
  },
  {
    label: 'blacklist add blocks a member',
    path: 'blacklist.add',
    raw: group('blacklist', 'add', [userOption('member', MEMBER)]),
    follows: false,
  },
  {
    label: 'blacklist remove says the member was not blocked',
    path: 'blacklist.remove',
    raw: group('blacklist', 'remove', [userOption('member', MEMBER)]),
    follows: false,
  },
  {
    label: 'blacklist list lists who is blocked',
    path: 'blacklist.list',
    raw: group('blacklist', 'list'),
    follows: false,
  },
];

const CASES = LEAVES.map((leaf) => [`/giveaway ${leaf.label}`, leaf] as const);

async function runLeaf(leaf: Leaf, overrides: Partial<RunOverrides>): Promise<CommandHarness> {
  const h = commandHarness(leaf.deps ?? {});
  await leaf.seed?.(h);
  await h.run(leaf.raw, {
    idempotencyKey: 'evt-giveaway',
    ...(leaf.userId ? { userId: leaf.userId } : {}),
    ...overrides,
  });
  return h;
}

const ANSWERS = new Set(['interaction_reply', 'interaction_followup']);

function trace(h: CommandHarness) {
  return h.requests.map((request) => {
    if (!ANSWERS.has(request.kind)) return { kind: request.kind };

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

function ephemeralOf(h: CommandHarness): unknown[] {
  return h.requests
    .filter((request) => ANSWERS.has(request.kind))
    .map((request) => (request.payload as { ephemeral?: unknown } | undefined)?.ephemeral);
}

describe('the /giveaway reply policy', () => {
  test('the table names every leaf path of /giveaway', () => {
    expect([...new Set(LEAVES.map((leaf) => leaf.path))].sort()).toEqual(
      leafPaths(giveawayCommand.data).sort(),
    );
  });

  test('replies privately by default, and only the running-a-giveaway paths can be made public', () => {
    const control = replyControl(
      giveawayCommand.reply,
      giveawayCommand.data,
      giveawaysConfigSchema.parse({}),
    );

    expect(control?.supported).toBe(true);
    expect(control?.inheritsFrom).toBeUndefined();
    expect(control?.paths.every((entry) => entry.default === 'private')).toBe(true);
    expect(
      control?.paths
        .filter((entry) => entry.toggleable)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([...TOGGLEABLE].sort());
  });

  test.each(['export', 'info', 'entrants', 'entries', 'history', 'stats', 'list', 'create'])(
    '%s is never toggleable',
    (path) => {
      expect(giveawayCommand.reply?.toggleable).not.toContain(path);
    },
  );
});

describe('with no command setting', () => {
  test.each(CASES)('%s exactly as before, privately', async (_label, leaf) => {
    const before = await runLeaf(leaf, { privateReply: undefined });
    const after = await runLeaf(leaf, { replyPreference: null });

    expect(trace(after)).toEqual(trace(before));
    expect(ephemeralOf(after)).toEqual(visibility(leaf, true));
  });
});

describe.each([
  ['public', false],
  ['private', true],
] as const)('set %s on the Commands page', (_label, preference) => {
  test.each(CASES)('%s', async (_label, leaf) => {
    const h = await runLeaf(leaf, { replyPreference: preference });

    expect(ephemeralOf(h)).toEqual(visibility(leaf, leaf.follows ? preference : true));
  });
});

describe('the module keeps its own private paths private', () => {
  test.each(CASES)('%s, even when a worker hands it a public reply', async (_label, leaf) => {
    const h = await runLeaf(leaf, { privateReply: false });

    expect(ephemeralOf(h)).toEqual(visibility(leaf, !leaf.follows));
  });
});

describe('every /giveaway leaf acknowledges exactly once, first', () => {
  test.each(CASES)('%s', async (_label, leaf) => {
    const h = await runLeaf(leaf, { replyPreference: null });

    const initial = h.requests.filter((request) => request.kind === 'interaction_reply');
    expect(initial).toHaveLength(1);
    expect(isDefer(initial[0] as ActionRequest)).toBe(leaf.deferred === true);

    const answers = h.requests.filter((request) => ANSWERS.has(request.kind));
    expect(answers).toHaveLength(leaf.deferred ? 2 : 1);
    if (leaf.deferred) expect(h.requests[0]).toBe(initial[0] as ActionRequest);
  });
});

describe('a private confirmation still does the public part', () => {
  test('a private /giveaway start still posts the giveaway card in the channel', async () => {
    const h = commandHarness();

    await h.run(subcommand('start', [stringOption('duration', '12h'), NITRO]), {
      replyPreference: true,
    });

    expect(ephemeralOf(h)).toEqual([true, true]);
    expect(h.replyText()).toContain('**Nitro** is live');

    const posted = h.requests.filter((request) => request.kind === 'send');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.payload).toMatchObject({ flags: MESSAGE_FLAG_IS_COMPONENTS_V2 });
    expect(posted[0]?.payload).toHaveProperty('components');
    expect(posted[0]?.payload).not.toHaveProperty('ephemeral');
  });

  test('a private /giveaway end still repaints the card and announces the winner', async () => {
    const h = commandHarness();
    await running(h);

    await h.run(subcommand('end', [G1]), { replyPreference: true });

    expect(ephemeralOf(h)).toEqual([true, true]);
    expect(h.replyText()).toContain('**A prize** has been drawn');

    const edited = h.requests.filter((request) => request.kind === 'edit_message');
    expect(edited.map((request) => request.payload)).toMatchObject([
      { channelId: GIVEAWAY_CHANNEL, messageId: GIVEAWAY_MESSAGE },
    ]);

    const announced = h.requests.filter((request) => request.kind === 'send');
    expect(announced).toHaveLength(1);
    expect(announced[0]?.payload).toMatchObject({ channelId: GIVEAWAY_CHANNEL });
    expect(announced[0]?.payload).not.toHaveProperty('ephemeral');

    const payload = announced[0]?.payload as { allowedMentions?: { users?: string[] } } | undefined;
    const winners = payload?.allowedMentions?.users;
    expect(winners).toHaveLength(1);
    expect([MEMBER, STRANGER]).toContain(winners?.[0] ?? '');
  });

  test('a public /giveaway end posts the same card and announcement as a private one', async () => {
    const kinds = async (preference: boolean) => {
      const h = commandHarness();
      await running(h);
      await h.run(subcommand('end', [G1]), { replyPreference: preference });
      return h.requests.map((request) => request.kind);
    };

    expect(await kinds(false)).toEqual(await kinds(true));
  });
});
