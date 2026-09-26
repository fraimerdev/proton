import { describe, expect, test } from 'bun:test';
import type { BadgeCard } from '@proton/cards';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  type CommandLabeler,
  createCommandOptions,
  DISCORD_EPOCH_MS,
  formatCommandLabel,
  leafPaths,
  OptionType,
  Permissions,
  parseCustomId,
  type RawOption,
  replyControl,
  resolvePrivateReply,
  subcommandPath,
  type TierId,
} from '@proton/core';
import {
  ACHIEVEMENTS_OFF,
  entryText,
  type ListEntry,
  listPage,
  STORE_UNBOUND,
} from '../src/command-views.ts';
import { achievementsCommands } from '../src/commands.ts';
import {
  type AchievementInput,
  type AchievementsConfig,
  achievementsConfigSchema,
} from '../src/config.ts';
import type { AchievementsDeps } from '../src/deps.ts';
import type { UnlockInput } from '../src/store.ts';
import { CHANNEL, DAY, GUILD, ROLE, T0, USER, USER_2, unlockInput } from './contracts.ts';
import { MemoryAchievementStore } from './memory-store.ts';
import { MemoryLimits } from './memory-voice-store.ts';

const APP = '900000000000000009';
const KEY = 'interaction.command:900000000000000001:1';
const INTERACTION = ((BigInt(T0 - DISCORD_EPOCH_MS) << 22n) | 7n).toString();
const V2 = 32768;

class Recorder implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  readonly #claimed = new Set<string>();

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    if (this.#claimed.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };
    this.#claimed.add(request.idempotencyKey);
    return { status: 'executed' };
  }
}

function payloadOf(request: ActionRequest | undefined): Record<string, unknown> {
  return (request?.payload ?? {}) as Record<string, unknown>;
}

function walk(node: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  const item = node as Record<string, unknown>;
  visit(item);
  walk(item.components, visit);
  walk(item.accessory, visit);
}

function textOf(request: ActionRequest | undefined): string {
  const lines: string[] = [];
  walk(payloadOf(request).components, (item) => {
    if (item.type === 10 && typeof item.content === 'string') lines.push(item.content);
  });
  return lines.join('\n');
}

function buttonsOf(request: ActionRequest | undefined): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  walk(payloadOf(request).components, (item) => {
    if (item.type === 2) found.push(item);
  });
  return found;
}

function embedText(request: ActionRequest | undefined): string {
  const embeds = (payloadOf(request).embeds ?? []) as Array<{ description?: string }>;
  return embeds.map((embed) => embed.description ?? '').join('\n');
}

const CHATTERBOX: AchievementInput = {
  id: 'chatterbox',
  name: 'Chatterbox',
  description: 'Keep the conversation going.',
  kind: 'tiered',
  status: 'active',
  requirements: [{ id: 'messages', trigger: 'messages.sent' }],
  endsAt: '2026-10-01T22:59:00.000Z',
  tiers: [
    { id: 'bronze', targets: { messages: 10 }, rewards: [{ kind: 'add_role', roleId: ROLE }] },
    { id: 'silver', targets: { messages: 100 }, rewards: [{ kind: 'xp', amount: 250 }] },
    { id: 'gold', targets: { messages: 1000 } },
  ],
};

function single(id: string, name: string, status: AchievementInput['status'] = 'active') {
  return {
    id,
    name,
    kind: 'single',
    status,
    requirements: [{ id: 'messages', trigger: 'messages.sent' }],
    tiers: [{ id: 'single', targets: { messages: 50 } }],
  } satisfies AchievementInput;
}

function unlockOf(
  achievementId: string,
  tiers: TierId[],
  options: { userId?: string; name?: string; kind?: 'single' | 'tiered'; at?: number } = {},
): UnlockInput {
  const input = unlockInput({
    achievementId,
    tiers,
    userId: options.userId ?? USER,
    unlockedAt: options.at ?? T0 - DAY,
    group: `group-${achievementId}`,
  });

  return {
    ...input,
    tiers: input.tiers.map((tier) => ({
      ...tier,
      definition: {
        ...tier.definition,
        name: options.name ?? tier.definition.name,
        kind: options.kind ?? tier.definition.kind,
      },
    })),
  };
}

const ANNIVERSARY: AchievementInput = {
  id: 'anniversary',
  name: 'Anniversary',
  kind: 'tiered',
  status: 'active',
  requirements: [{ id: 'days', trigger: 'membership.days' }],
  tiers: [
    { id: 'bronze', targets: { days: 30 } },
    { id: 'silver', targets: { days: 180 } },
  ],
};

const RISING_STAR: AchievementInput = {
  id: 'rising-star',
  name: 'Rising Star',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'level', trigger: 'leveling.level' }],
  tiers: [{ id: 'single', targets: { level: 5 } }],
};

const GRADUATE: AchievementInput = {
  id: 'graduate',
  name: 'Graduate',
  kind: 'single',
  status: 'active',
  requirements: [
    {
      id: 'prereq',
      trigger: 'achievements.unlocked',
      achievementId: 'chatterbox',
      tierId: 'silver',
    },
  ],
  tiers: [{ id: 'single', targets: { prereq: 1 } }],
};

const COLLECTOR: AchievementInput = {
  id: 'collector',
  name: 'Collector',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'earned', trigger: 'achievements.earned' }],
  tiers: [{ id: 'single', targets: { earned: 3 } }],
};

interface Setup {
  achievements?: AchievementInput[];
  timezone?: string;
  enabled?: boolean;
  store?: boolean;
  deps?: Partial<Pick<AchievementsDeps, 'renderBadge' | 'applicationId' | 'levelOf'>>;
}

interface RunExtra {
  applicationId?: string | null;
  actorPermissions?: bigint;
  commandLabel?: CommandLabeler;
  replyPreference?: boolean | null;
  // Present, it replaces what the worker would resolve — undefined is a worker that set none.
  privateReply?: boolean | undefined;
}

function privateReplyOf(
  command: CommandDefinition<AchievementsConfig>,
  config: AchievementsConfig,
  raw: readonly RawOption[],
  extra: RunExtra,
): { privateReply?: boolean } {
  if ('privateReply' in extra) {
    return extra.privateReply === undefined ? {} : { privateReply: extra.privateReply };
  }
  if (!command.reply) return {};

  const preference = extra.replyPreference ?? null;
  return {
    privateReply: resolvePrivateReply(command.reply, config, subcommandPath(raw), preference),
  };
}

function setup(input: Setup = {}) {
  const clock = { now: T0 };
  const store = new MemoryAchievementStore({ now: () => clock.now });
  const executor = new Recorder();
  const logs: string[] = [];
  const config: AchievementsConfig = achievementsConfigSchema.parse({
    enabled: input.enabled ?? true,
    timezone: input.timezone ?? 'UTC',
    achievements: input.achievements ?? [],
  });

  const deps: AchievementsDeps = {
    ...(input.store === false ? {} : { store }),
    limits: new MemoryLimits({ now: () => clock.now }),
    now: () => clock.now,
    ...input.deps,
  };

  const logger = {
    info: (message: string) => logs.push(`info: ${message}`),
    warn: (message: string) => logs.push(`warn: ${message}`),
    error: (message: string) => logs.push(`error: ${message}`),
  };

  const commands = achievementsCommands(deps);

  function context(options: RawOption[], extra: RunExtra = {}): CommandContext<AchievementsConfig> {
    const applicationId = extra.applicationId === undefined ? APP : extra.applicationId;
    return {
      guildId: GUILD,
      channelId: CHANNEL,
      userId: USER,
      config,
      executor,
      logger,
      options: createCommandOptions(options),
      interaction: { id: INTERACTION, token: 'command-token' },
      idempotencyKey: KEY,
      ...(applicationId === null ? {} : { applicationId }),
      ...(extra.actorPermissions === undefined ? {} : { actorPermissions: extra.actorPermissions }),
      ...(extra.commandLabel ? { commandLabel: extra.commandLabel } : {}),
    };
  }

  async function run(name: string, options: RawOption[] = [], extra: RunExtra = {}): Promise<void> {
    const command = commands.find((candidate) => candidate.name === name);
    if (!command) throw new Error(`no /${name}`);
    await command.handler({
      ...context(options, extra),
      ...privateReplyOf(command, config, options, extra),
    });
  }

  return { clock, store, executor, logs, config, deps, commands, run };
}

function sub(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}

describe('/achievements', () => {
  test('defers publicly first, then follows up with a Components V2 page', async () => {
    const h = setup({ achievements: [CHATTERBOX] });
    await h.store.setValues(GUILD, USER, [
      { achievementId: 'chatterbox', requirementId: 'messages', version: 1, value: 3 },
    ]);

    await h.run('achievements');

    const [defer, page] = h.executor.requests;
    expect(h.executor.requests).toHaveLength(2);

    expect(defer?.kind).toBe('interaction_reply');
    expect(defer?.idempotencyKey).toBe(`${KEY}:defer`);
    expect(payloadOf(defer)).toMatchObject({ callbackType: 5, ephemeral: false });

    expect(page?.kind).toBe('interaction_followup');
    expect(payloadOf(page)).toMatchObject({
      applicationId: APP,
      interactionToken: 'command-token',
      ephemeral: false,
      flags: V2,
      allowedMentions: { parse: [] },
    });
    expect(payloadOf(page).content).toBeUndefined();
    expect(payloadOf(page).embeds).toBeUndefined();

    const body = textOf(page);
    expect(body).toContain(`**<@${USER}>’s achievements** · 0 of 1 earned`);
    expect(body).toContain('🔒 **Chatterbox**: Not earned yet');
    expect(body).toContain('3 / 10 messages for Bronze (30%)\n`▰▰▰▱▱▱▱▱▱▱`');
  });

  test('shows the chosen member and takes the application id from the deps', async () => {
    const h = setup({ achievements: [CHATTERBOX], deps: { applicationId: APP } });

    await h.run('achievements', [userOption('user', USER_2)], { applicationId: null });

    const page = h.executor.requests[1];
    expect(payloadOf(page).applicationId).toBe(APP);
    expect(textOf(page)).toContain(`**<@${USER_2}>’s achievements**`);
  });

  test('lists every earned achievement whatever its status, and never a draft', async () => {
    const h = setup({
      achievements: [
        CHATTERBOX,
        single('paused-one', 'Paused One', 'paused'),
        single('archived-held', 'Archived Held', 'archived'),
        single('archived-not', 'Archived Not', 'archived'),
        single('secret-one', 'Secret One', 'draft'),
        { ...single('ended-one', 'Ended One'), endsAt: '2026-08-01T00:00:00.000Z' },
      ],
    });
    await h.store.unlock(unlockOf('chatterbox', ['bronze']));
    await h.store.unlock(unlockOf('paused-one', ['single'], { kind: 'single' }));
    await h.store.unlock(unlockOf('archived-held', ['single'], { kind: 'single' }));
    await h.store.unlock(unlockOf('secret-one', ['single'], { kind: 'single' }));
    await h.store.unlock(unlockOf('long-gone', ['gold'], { name: 'Old Timer' }));

    await h.run('achievements');
    const body = textOf(h.executor.requests[1]);

    expect(body).toContain('· 4 of 5 earned');
    expect(body).toContain('🥉 **Chatterbox**: Bronze');
    expect(body).toContain('🏅 **Paused One**: Earned · Paused');
    expect(body).toContain('🏅 **Archived Held**: Earned · Archived\nEarned 31 Aug 2026');
    expect(body).toContain('🔒 **Ended One**: Not earned yet · Ended');
    expect(body).toContain('🥇 **Old Timer**: Gold · Retired\nEarned 31 Aug 2026');
    expect(body).not.toContain('Archived Not');
    expect(body).not.toContain('Secret One');
  });

  test('pages six at a time with Previous, the page and Next', async () => {
    const achievements = Array.from({ length: 8 }, (_, index) =>
      single(`goal-${index + 1}`, `Goal ${index + 1}`),
    );
    const h = setup({ achievements });

    await h.run('achievements');
    const page = h.executor.requests[1];
    const body = textOf(page);

    expect(body).toContain('Goal 6');
    expect(body).not.toContain('Goal 7');

    const [previous, here, next] = buttonsOf(page);
    expect(previous).toMatchObject({ label: 'Previous', disabled: true });
    expect(here).toMatchObject({ label: '1 / 2', disabled: true });
    expect(next).toMatchObject({ label: 'Next', disabled: false });
    expect(parseCustomId(next?.custom_id)).toEqual({
      moduleId: 'achievements',
      action: 'pg',
      args: [USER, '2', USER],
    });
  });

  test('reads the level from Leveling rather than from a stale progress row', async () => {
    const asked: string[] = [];
    const h = setup({
      achievements: [RISING_STAR],
      deps: {
        levelOf: async (_guildId, userId) => {
          asked.push(userId);
          return 3;
        },
      },
    });

    await h.run('achievements');

    expect(asked).toEqual([USER]);
    expect(textOf(h.executor.requests[1])).toContain('level 3 of 5 (60%)');
  });

  test('derives the prerequisite and the count of badges from the unlocks it already read', async () => {
    const h = setup({ achievements: [CHATTERBOX, GRADUATE, COLLECTOR] });
    await h.store.unlock(unlockOf('chatterbox', ['bronze', 'silver']));
    await h.store.unlock(unlockOf('old-timer', ['gold'], { name: 'Old Timer' }));

    await h.run('achievements');
    const body = textOf(h.executor.requests[1]);

    expect(body).toContain('prerequisite earned');
    expect(body).toContain('2 / 3 achievements (66%)');
  });

  test('refuses when the storage port is unbound, naming the fault', async () => {
    const h = setup({ achievements: [CHATTERBOX], store: false });

    await h.run('achievements');

    expect(h.executor.requests).toHaveLength(1);
    expect(payloadOf(h.executor.requests[0])).toMatchObject({ callbackType: 4, ephemeral: true });
    expect(embedText(h.executor.requests[0])).toContain(STORE_UNBOUND);
    expect(h.logs.some((line) => line.includes('DrizzleAchievementStore'))).toBe(true);
  });

  test('refuses while Achievements is off', async () => {
    const h = setup({ achievements: [CHATTERBOX], enabled: false });

    await h.run('achievements');

    expect(h.executor.requests).toHaveLength(1);
    expect(embedText(h.executor.requests[0])).toContain(ACHIEVEMENTS_OFF);
  });
});

describe('list pages', () => {
  const entries: ListEntry[] = Array.from({ length: 13 }, (_, index) => ({
    achievementId: `goal-${index + 1}`,
    name: `Goal ${index + 1}`,
    kind: 'single',
    state: 'active',
    held: null,
    earnedAt: null,
    next: { tier: 'single', parts: [{ trigger: 'messages.sent', current: 5, target: 50 }] },
  }));

  test('clamps the page into range', () => {
    const base = { subjectId: USER, invokerId: USER, entries, timeZone: 'UTC' };

    expect(listPage({ ...base, page: 0 }).page).toBe(1);
    expect(listPage({ ...base, page: 99 })).toMatchObject({ page: 3, pages: 3 });

    const last = listPage({ ...base, page: 3 });
    expect(JSON.stringify(last.components)).toContain('Goal 13');
    expect(JSON.stringify(last.components)).not.toContain('Goal 12');
  });

  test('has no buttons when everything fits on one page', () => {
    const view = listPage({
      subjectId: USER,
      invokerId: USER,
      entries: entries.slice(0, 6),
      page: 1,
      timeZone: 'UTC',
    });
    expect(view.components).toHaveLength(1);
  });

  test('puts the numbers before the bar', () => {
    const [first] = entries;
    if (!first) throw new Error('no entry');

    expect(entryText(first, 'UTC').split('\n')).toEqual([
      '🔒 **Goal 1**: Not earned yet',
      '5 / 50 messages (10%)',
      '`▰▱▱▱▱▱▱▱▱▱`',
    ]);
  });
});

describe('/achievement view', () => {
  const view = (value: string, extra: RawOption[] = []) =>
    sub('view', [stringOption('achievement', value), ...extra]);

  async function seeded(input: Setup = {}) {
    const h = setup({ achievements: [CHATTERBOX], timezone: 'Europe/London', ...input });
    await h.store.setValues(GUILD, USER, [
      { achievementId: 'chatterbox', requirementId: 'messages', version: 1, value: 40 },
    ]);
    await h.store.unlock(unlockOf('chatterbox', ['bronze']));
    return h;
  }

  test('shows the badge, the deadline in the module time zone, tiers, rewards and progress', async () => {
    const cards: BadgeCard[] = [];
    const h = await seeded({
      deps: {
        renderBadge: async (card) => {
          cards.push(card);
          return new Uint8Array([137, 80, 78, 71]);
        },
      },
    });

    await h.run('achievement', view('chatterbox'));

    const [defer, reply] = h.executor.requests;
    expect(payloadOf(defer)).toMatchObject({ callbackType: 5, ephemeral: false });
    expect(reply?.kind).toBe('interaction_followup');
    expect(payloadOf(reply)).toMatchObject({
      flags: V2,
      ephemeral: false,
      allowedMentions: { parse: [] },
    });

    const files = payloadOf(reply).files as Array<{ filename: string; contentType: string }>;
    expect(files.map((file) => file.filename)).toEqual(['badge.png']);
    expect(cards).toEqual([{ kind: 'badge', shape: 'circle', colour: '#b0764a', icon: 'trophy' }]);

    const thumbnails: unknown[] = [];
    walk(payloadOf(reply).components, (item) => {
      if (item.type === 11) thumbnails.push(item.media);
    });
    expect(thumbnails).toEqual([{ url: 'attachment://badge.png' }]);

    const ends = Math.floor(Date.UTC(2026, 9, 1, 22, 59) / 1000);
    const body = textOf(reply);
    expect(body).toContain('## Chatterbox');
    expect(body).toContain('Keep the conversation going.');
    expect(body).toContain(`-# Active · Ends 1 Oct 2026, 23:59 (Europe/London) · <t:${ends}:R>`);
    expect(body).toContain(`🥉 **Bronze**: Send 10 messages · <@&${ROLE}>`);
    expect(body).toContain('🥈 **Silver**: Send 100 messages · 250 XP');
    expect(body).toContain(`**<@${USER}>’s progress**`);
    expect(body).toContain('🥉 Bronze: earned 31 Aug 2026');
    expect(body).toContain('🥈 Silver: 40 / 100 messages (40%)\n`▰▰▰▰▱▱▱▱▱▱`');
    expect(body).toContain('🥇 Gold: 40 / 1,000 messages (4%)');
    expect(body).not.toContain('—');
  });

  test('leaves the badge out when it cannot be drawn', async () => {
    const h = await seeded({ deps: { renderBadge: async () => null } });

    await h.run('achievement', view('Chatterbox'));

    const reply = h.executor.requests[1];
    expect(payloadOf(reply).files).toBeUndefined();
    expect(JSON.stringify(payloadOf(reply).components)).not.toContain('attachment://');
    expect(textOf(reply)).toContain('## Chatterbox');
  });

  test('keeps a draft hidden and refuses before deferring', async () => {
    const h = setup({ achievements: [single('secret-one', 'Secret One', 'draft')] });

    await h.run('achievement', view('secret-one'));

    expect(h.executor.requests).toHaveLength(1);
    expect(payloadOf(h.executor.requests[0])).toMatchObject({ callbackType: 4, ephemeral: true });
    expect(embedText(h.executor.requests[0])).toContain('There’s no achievement called');
  });

  test('shows a retired achievement from what the member earned', async () => {
    const h = setup({ achievements: [CHATTERBOX] });
    await h.store.unlock(unlockOf('old-timer', ['bronze', 'silver'], { name: 'Old Timer' }));

    await h.run('achievement', view('old timer'));

    const [defer, reply] = h.executor.requests;
    expect(payloadOf(defer)).toMatchObject({ callbackType: 5, ephemeral: true });
    expect(payloadOf(reply)).toMatchObject({ ephemeral: true, flags: V2 });

    const body = textOf(reply);
    expect(body).toContain('## Old Timer');
    expect(body).toContain('Retired');
    expect(body).toContain('🥈 Silver: earned 31 Aug 2026');
  });

  test('keeps a name nobody has out of the channel, deferring privately first', async () => {
    const h = setup({ achievements: [CHATTERBOX] });

    await h.run('achievement', view('chaterbox'));

    const [defer, refusal] = h.executor.requests;
    expect(h.executor.requests).toHaveLength(2);
    expect(payloadOf(defer)).toMatchObject({ callbackType: 5, ephemeral: true });
    expect(refusal?.kind).toBe('interaction_followup');
    expect(payloadOf(refusal)).toMatchObject({ ephemeral: true });
    expect(embedText(refusal)).toContain('There’s no achievement called “chaterbox”');
  });

  test('counts the days as a member live, not from the last evaluation', async () => {
    const h = setup({ achievements: [ANNIVERSARY] });
    await h.store.upsertFacts(GUILD, USER, { joinedAt: T0 - 150 * DAY });
    await h.store.setValues(GUILD, USER, [
      { achievementId: 'anniversary', requirementId: 'days', version: 1, value: 30 },
    ]);

    await h.run('achievement', view('anniversary'));

    const body = textOf(h.executor.requests[1]);
    expect(body).toContain('🥈 Silver: 150 / 180 days as a member (83%)');
    expect(body).not.toContain('30 / 180');
  });

  test('counts nobody’s days once they have left', async () => {
    const h = setup({ achievements: [ANNIVERSARY] });
    await h.store.upsertFacts(GUILD, USER, { joinedAt: T0 - 150 * DAY, leftAt: T0 - DAY });

    await h.run('achievement', view('anniversary'));

    expect(textOf(h.executor.requests[1])).toContain('🥉 Bronze: 0 / 30 days as a member (0%)');
  });
});

describe('/achievement reset', () => {
  const reset = (options: RawOption[]) => sub('reset', options);

  test('is refused without Manage Server, naming it, and changes nothing', async () => {
    const h = setup({ achievements: [CHATTERBOX] });
    await h.store.unlock(unlockOf('chatterbox', ['bronze'], { userId: USER_2 }));

    await h.run('achievement', reset([userOption('member', USER_2)]), {
      actorPermissions: Permissions.SendMessages,
    });

    expect(h.executor.requests).toHaveLength(1);
    expect(payloadOf(h.executor.requests[0])).toMatchObject({ callbackType: 4, ephemeral: true });
    expect(embedText(h.executor.requests[0])).toContain(
      'You need Manage Server to reset achievements. Anyone can still use /achievement view.',
    );
    expect(await h.store.unlocksOf(GUILD, USER_2)).toHaveLength(1);
    expect(h.store.audits).toHaveLength(0);
  });

  test('names /achievement view as this server shows it when refusing', async () => {
    const h = setup({ achievements: [CHATTERBOX] });

    await h.run('achievement', reset([userOption('member', USER_2)]), {
      actorPermissions: Permissions.SendMessages,
      commandLabel: (key, path) =>
        formatCommandLabel(key, path, key === 'achievement' ? 'badge' : undefined),
    });

    expect(embedText(h.executor.requests[0])).toContain('Anyone can still use /badge view.');
  });

  test('asks for confirmation privately, with Reset and Cancel', async () => {
    const h = setup({ achievements: [CHATTERBOX] });

    await h.run(
      'achievement',
      reset([userOption('member', USER_2), stringOption('achievement', 'chatterbox')]),
      { actorPermissions: Permissions.ManageGuild },
    );

    const [defer, prompt] = h.executor.requests;
    expect(payloadOf(defer)).toMatchObject({ callbackType: 5, ephemeral: true });
    expect(defer?.idempotencyKey).toBe(`${KEY}:defer`);
    expect(prompt?.kind).toBe('interaction_followup');
    expect(payloadOf(prompt)).toMatchObject({ ephemeral: true, allowedMentions: { parse: [] } });
    expect(String(payloadOf(prompt).content)).toContain(`Reset **Chatterbox** for <@${USER_2}>?`);

    const labels = buttonsOf(prompt).map((button) => button.label);
    expect(labels).toEqual(['Reset', 'Cancel']);
    expect(h.store.audits).toHaveLength(0);
  });

  test('refuses an achievement the server does not have', async () => {
    const h = setup({ achievements: [CHATTERBOX] });

    await h.run(
      'achievement',
      reset([userOption('member', USER_2), stringOption('achievement', 'nothing-here')]),
      { actorPermissions: Permissions.Administrator },
    );

    expect(h.executor.requests).toHaveLength(1);
    expect(embedText(h.executor.requests[0])).toContain('leave the achievement option empty');
  });
});

interface Leaf {
  label: string;
  name: 'achievements' | 'achievement';
  path: string;
  options: RawOption[];
  setup?: Setup;
  seed?: (h: ReturnType<typeof setup>) => Promise<void>;
  actorPermissions?: bigint;
  privateBefore: boolean[];
  follows: boolean;
}

const view = (value: string) => sub('view', [stringOption('achievement', value)]);
const reset = (options: RawOption[] = []) =>
  sub('reset', [userOption('member', USER_2), ...options]);

const LEAVES: Leaf[] = [
  {
    label: '/achievements shows the member’s page',
    name: 'achievements',
    path: '',
    options: [],
    setup: { achievements: [CHATTERBOX] },
    privateBefore: [false, false],
    follows: true,
  },
  {
    label: '/achievements refuses without its store',
    name: 'achievements',
    path: '',
    options: [],
    setup: { achievements: [CHATTERBOX], store: false },
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/achievements refuses while Achievements is off',
    name: 'achievements',
    path: '',
    options: [],
    setup: { achievements: [CHATTERBOX], enabled: false },
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/achievement view shows an achievement',
    name: 'achievement',
    path: 'view',
    options: view('chatterbox'),
    setup: { achievements: [CHATTERBOX] },
    privateBefore: [false, false],
    follows: true,
  },
  {
    label: '/achievement view keeps a draft hidden',
    name: 'achievement',
    path: 'view',
    options: view('secret-one'),
    setup: { achievements: [single('secret-one', 'Secret One', 'draft')] },
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/achievement view shows a retired achievement privately',
    name: 'achievement',
    path: 'view',
    options: view('old timer'),
    setup: { achievements: [CHATTERBOX] },
    seed: async (h) => {
      await h.store.unlock(unlockOf('old-timer', ['bronze'], { name: 'Old Timer' }));
    },
    privateBefore: [true, true],
    follows: false,
  },
  {
    label: '/achievement view refuses a name nobody has',
    name: 'achievement',
    path: 'view',
    options: view('chaterbox'),
    setup: { achievements: [CHATTERBOX] },
    privateBefore: [true, true],
    follows: false,
  },
  {
    label: '/achievement reset asks for confirmation',
    name: 'achievement',
    path: 'reset',
    options: reset([stringOption('achievement', 'chatterbox')]),
    setup: { achievements: [CHATTERBOX] },
    actorPermissions: Permissions.ManageGuild,
    privateBefore: [true, true],
    follows: false,
  },
  {
    label: '/achievement reset refuses without Manage Server',
    name: 'achievement',
    path: 'reset',
    options: reset(),
    setup: { achievements: [CHATTERBOX] },
    actorPermissions: Permissions.SendMessages,
    privateBefore: [true],
    follows: false,
  },
  {
    label: '/achievement reset refuses an achievement the server does not have',
    name: 'achievement',
    path: 'reset',
    options: reset([stringOption('achievement', 'nothing-here')]),
    setup: { achievements: [CHATTERBOX] },
    actorPermissions: Permissions.ManageGuild,
    privateBefore: [true],
    follows: false,
  },
];

const CASES = LEAVES.map((leaf) => [leaf.label, leaf] as const);

async function runLeaf(leaf: Leaf, extra: RunExtra) {
  const h = setup(leaf.setup);
  await leaf.seed?.(h);
  await h.run(leaf.name, leaf.options, {
    ...(leaf.actorPermissions === undefined ? {} : { actorPermissions: leaf.actorPermissions }),
    ...extra,
  });
  return h;
}

function answers(h: ReturnType<typeof setup>) {
  return h.executor.requests.map((request) => {
    const payload = payloadOf(request);
    return {
      kind: request.kind,
      key: request.idempotencyKey,
      callbackType: payload.callbackType,
      ephemeral: payload.ephemeral,
      flags: payload.flags,
    };
  });
}

function ephemeralOf(h: ReturnType<typeof setup>): unknown[] {
  return answers(h).map((answer) => answer.ephemeral);
}

describe('achievements reply policies', () => {
  test('the table names every leaf path of both commands', () => {
    for (const command of setup().commands) {
      const paths = new Set(
        LEAVES.filter((leaf) => leaf.name === command.name).map((leaf) => leaf.path),
      );
      expect({ name: command.name, paths: [...paths].sort() }).toEqual({
        name: command.name,
        paths: leafPaths(command.data).sort(),
      });
    }
  });

  test('/achievements and /achievement view answer in public, and reset is always private', () => {
    const h = setup();
    const named = (name: string) => {
      const command = h.commands.find((candidate) => candidate.name === name);
      if (!command) throw new Error(`no /${name}`);
      return command;
    };
    const list = named('achievements');
    const detail = named('achievement');

    expect(replyControl(list.reply, list.data, h.config)).toEqual({
      supported: true,
      paths: [{ path: '', default: 'public', toggleable: true }],
    });
    expect(replyControl(detail.reply, detail.data, h.config)).toEqual({
      supported: true,
      paths: [
        { path: 'view', default: 'public', toggleable: true },
        { path: 'reset', default: 'private', toggleable: false },
      ],
    });
  });
});

describe('with no command setting', () => {
  test.each(CASES)('%s exactly as before', async (_label, leaf) => {
    const before = await runLeaf(leaf, { privateReply: undefined });
    const after = await runLeaf(leaf, { replyPreference: null });

    expect(after.executor.requests).toEqual(before.executor.requests);
    expect(ephemeralOf(after)).toEqual(leaf.privateBefore);
  });
});

describe.each([
  ['public', false],
  ['private', true],
] as const)('set %s on the Commands page', (_label, preference) => {
  test.each(CASES)('%s', async (_label, leaf) => {
    const h = await runLeaf(leaf, { replyPreference: preference });

    expect(ephemeralOf(h)).toEqual(
      leaf.follows ? leaf.privateBefore.map(() => preference) : leaf.privateBefore,
    );
  });
});

describe('a refusal is never the first followup of a public defer', () => {
  test.each(CASES)('%s set public', async (_label, leaf) => {
    const h = await runLeaf(leaf, { replyPreference: false });
    const [first, second] = answers(h);

    if (first?.callbackType === 5 && first.ephemeral === false) {
      expect(embedText(h.executor.requests[1])).toBe('');
      expect(second?.flags).toBe(V2);
    } else {
      expect(first?.ephemeral).toBe(true);
    }
  });

  test('a reset stays private even when a worker hands it a public reply', async () => {
    for (const leaf of LEAVES.filter((candidate) => candidate.path === 'reset')) {
      const h = await runLeaf(leaf, { privateReply: false });
      expect({ leaf: leaf.label, ephemeral: ephemeralOf(h) }).toEqual({
        leaf: leaf.label,
        ephemeral: leaf.privateBefore,
      });
    }
  });

  test('set private, /achievement view defers privately and answers the same way', async () => {
    const leaf = LEAVES.find((candidate) => candidate.path === 'view') as Leaf;
    const h = await runLeaf(leaf, { replyPreference: true });

    expect(answers(h)).toEqual([
      {
        kind: 'interaction_reply',
        key: `${KEY}:defer`,
        callbackType: 5,
        ephemeral: true,
        flags: undefined,
      },
      {
        kind: 'interaction_followup',
        key: `${KEY}:followup`,
        callbackType: undefined,
        ephemeral: true,
        flags: V2,
      },
    ]);
  });
});
