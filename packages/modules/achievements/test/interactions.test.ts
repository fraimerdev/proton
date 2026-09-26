import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type CommandLabeler,
  createCommandOptions,
  DISCORD_EPOCH_MS,
  encodeCustomId,
  formatCommandLabel,
  type ModuleContext,
  OptionType,
  Permissions,
  type ProtonEvent,
  type RawOption,
  type TierId,
} from '@proton/core';
import {
  ACHIEVEMENTS_OFF,
  RESET_CANCELLED,
  RESET_SETTLED,
  UNKNOWN_CONTROL,
  WORKING,
} from '../src/command-views.ts';
import { achievementsCommands } from '../src/commands.ts';
import {
  type AchievementInput,
  type AchievementsConfig,
  achievementsConfigSchema,
} from '../src/config.ts';
import type { AchievementLimits, AchievementsDeps } from '../src/deps.ts';
import { RESET_DRAFT_TTL_MS } from '../src/drafts.ts';
import { createAchievementsInteractionListener } from '../src/interactions.ts';
import type { UnlockInput } from '../src/store.ts';
import { CHANNEL, DAY, GUILD, MINUTE, ROLE, T0, USER, USER_2, unlockInput } from './contracts.ts';
import { MemoryAchievementStore } from './memory-store.ts';

const APP = '900000000000000009';
const MESSAGE_ID = '700000000000000042';

const RENAMES: Record<string, string> = { achievements: 'badges', achievement: 'badge' };
const renamed: CommandLabeler = (key, path) => formatCommandLabel(key, path, RENAMES[key]);
const INTERACTION = ((BigInt(T0 - DISCORD_EPOCH_MS) << 22n) | 3n).toString();
const V2 = 32768;

class Recorder implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  readonly #claimed = new Set<string>();
  #next: ActionResult | null = null;

  failNext(result: ActionResult): void {
    this.#next = result;
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);

    const forced = this.#next;
    if (forced) {
      this.#next = null;
      return forced;
    }

    if (this.#claimed.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };
    this.#claimed.add(request.idempotencyKey);
    return { status: 'executed' };
  }

  take(): ActionRequest[] {
    return this.requests.splice(0);
  }
}

class Limits implements AchievementLimits {
  readonly #claims = new Map<string, { value: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  async claim(key: string, value: string, ttlMs: number): Promise<boolean> {
    const held = this.#claims.get(key);
    if (held && held.expiresAt > this.#now()) return held.value === value;

    this.#claims.set(key, { value, expiresAt: this.#now() + Math.max(1, ttlMs) });
    return true;
  }

  async count(): Promise<number> {
    return 1;
  }

  async release(key: string, value: string): Promise<boolean> {
    const held = this.#claims.get(key);
    if (!held || held.expiresAt <= this.#now() || held.value !== value) return false;
    this.#claims.delete(key);
    return true;
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

function customIdOf(request: ActionRequest | undefined, label: string): string {
  const id = buttonsOf(request).find((button) => button.label === label)?.custom_id;
  if (typeof id !== 'string') throw new Error(`no '${label}' button`);
  return id;
}

function embedText(request: ActionRequest | undefined): string {
  const embeds = (payloadOf(request).embeds ?? []) as Array<{ description?: string }>;
  return embeds.map((embed) => embed.description ?? '').join('\n');
}

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

const CHATTERBOX: AchievementInput = {
  id: 'chatterbox',
  name: 'Chatterbox',
  kind: 'tiered',
  status: 'active',
  requirements: [{ id: 'messages', trigger: 'messages.sent' }],
  tiers: [
    { id: 'bronze', targets: { messages: 10 }, rewards: [{ kind: 'add_role', roleId: ROLE }] },
    { id: 'silver', targets: { messages: 100 } },
  ],
};

function unlockOf(
  achievementId: string,
  tiers: TierId[],
  options: { userId?: string; name?: string } = {},
): UnlockInput {
  const input = unlockInput({
    achievementId,
    tiers,
    userId: options.userId ?? USER,
    unlockedAt: T0 - DAY,
    group: `group-${achievementId}`,
    rewards: [{ kind: 'add_role', roleId: ROLE }],
  });

  return {
    ...input,
    tiers: input.tiers.map((tier) => ({
      ...tier,
      definition: { ...tier.definition, name: options.name ?? tier.definition.name },
    })),
  };
}

function setup(achievements: AchievementInput[], options: { enabled?: boolean } = {}) {
  const clock = { now: T0 };
  const store = new MemoryAchievementStore({ now: () => clock.now });
  const executor = new Recorder();
  const logs: string[] = [];
  const config: AchievementsConfig = achievementsConfigSchema.parse({
    enabled: options.enabled ?? true,
    achievements,
  });

  const deps: AchievementsDeps = {
    store,
    limits: new Limits(() => clock.now),
    now: () => clock.now,
  };

  const logger = {
    info: (message: string) => logs.push(`info: ${message}`),
    warn: (message: string) => logs.push(`warn: ${message}`),
    error: (message: string) => logs.push(`error: ${message}`),
  };

  const ctx: ModuleContext<AchievementsConfig> = { guildId: GUILD, config, executor, logger };
  const listener = createAchievementsInteractionListener(deps);
  const commands = achievementsCommands(deps);

  async function command(name: string, options: RawOption[], actorPermissions?: bigint) {
    const found = commands.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no /${name}`);

    await found.handler({
      ...ctx,
      channelId: CHANNEL,
      userId: USER,
      options: createCommandOptions(options),
      interaction: { id: INTERACTION, token: 'command-token' },
      idempotencyKey: `interaction.command:${INTERACTION}`,
      applicationId: APP,
      ...(actorPermissions === undefined ? {} : { actorPermissions }),
    });
  }

  let presses = 0;

  async function press(
    customId: string,
    as: { userId?: string; permissions?: bigint } = {},
  ): Promise<ActionRequest[]> {
    presses += 1;
    const id = `80000000000000${String(1000 + presses)}`;
    const event: ProtonEvent = {
      id: `interaction.component:${GUILD}:${id}`,
      type: 'interaction.component',
      guildId: GUILD,
      occurredAt: clock.now,
      payload: {
        id,
        token: `press-token-${presses}`,
        type: 3,
        application_id: APP,
        guild_id: GUILD,
        channel_id: CHANNEL,
        member: {
          user: { id: as.userId ?? USER },
          roles: [],
          permissions: String(as.permissions ?? 0n),
        },
        data: { custom_id: customId, component_type: 2 },
        message: { id: MESSAGE_ID, flags: 0 },
      },
    };

    executor.take();
    await listener.handler(event, ctx);
    return executor.take();
  }

  async function autocomplete(
    subcommand: string,
    value: string,
    extra: { commandName?: string; focused?: string; options?: RawOption[] } = {},
  ): Promise<ActionRequest[]> {
    const event: ProtonEvent = {
      id: `interaction.autocomplete:${GUILD}:${value}`,
      type: 'interaction.autocomplete',
      guildId: GUILD,
      occurredAt: clock.now,
      payload: {
        id: '810000000000000001',
        token: 'autocomplete-token',
        type: 4,
        application_id: APP,
        guild_id: GUILD,
        member: { user: { id: USER }, roles: [] },
        data: {
          name: extra.commandName ?? 'achievement',
          options: [
            {
              type: OptionType.Subcommand,
              name: subcommand,
              options: [
                {
                  type: OptionType.String,
                  name: extra.focused ?? 'achievement',
                  value,
                  focused: true,
                },
                ...(extra.options ?? []),
              ],
            },
          ],
        },
      },
    };

    executor.take();
    await listener.handler(event, ctx);
    return executor.take();
  }

  return { clock, store, executor, logs, config, deps, ctx, command, press, autocomplete };
}

function choicesOf(requests: ActionRequest[]): Array<{ name: string; value: string }> {
  expect(requests).toHaveLength(1);
  expect(payloadOf(requests[0])).toMatchObject({ callbackType: 8 });
  return payloadOf(requests[0]).choices as Array<{ name: string; value: string }>;
}

const MANAGE = Permissions.ManageGuild;

describe('page buttons', () => {
  const eight = Array.from({ length: 8 }, (_, index) =>
    single(`goal-${index + 1}`, `Goal ${index + 1}`),
  );

  test('turn the page for the person who ran the command', async () => {
    const h = setup(eight);
    await h.command('achievements', []);
    const next = customIdOf(h.executor.requests[1], 'Next');

    const [update, ...rest] = await h.press(next);

    expect(rest).toHaveLength(0);
    expect(update?.kind).toBe('interaction_reply');
    expect(payloadOf(update)).toMatchObject({
      callbackType: 7,
      flags: V2,
      allowedMentions: { parse: [] },
    });
    expect(textOf(update)).toContain('Goal 7');
    expect(textOf(update)).not.toContain('Goal 6');
    expect(buttonsOf(update).map((button) => [button.label, button.disabled])).toEqual([
      ['Previous', false],
      ['2 / 2', true],
      ['Next', true],
    ]);
  });

  test('keep the page in range', async () => {
    const h = setup(eight);
    const beyond = encodeCustomId('achievements', 'pg', USER, '9', USER);
    if (!beyond.ok) throw new Error(beyond.humanReason);

    const [update] = await h.press(beyond.customId);

    expect(buttonsOf(update).map((button) => button.label)).toContain('2 / 2');
  });

  test('refuse anyone else, privately', async () => {
    const h = setup(eight);
    await h.command('achievements', []);
    const next = customIdOf(h.executor.requests[1], 'Next');

    const [refusal, ...rest] = await h.press(next, { userId: USER_2 });

    expect(rest).toHaveLength(0);
    expect(payloadOf(refusal)).toMatchObject({ callbackType: 4, ephemeral: true });
    expect(payloadOf(refusal).flags).toBeUndefined();
    expect(embedText(refusal)).toContain(
      'Only the person who ran /achievements can turn these pages.',
    );
  });

  test('name the list command as this server shows it when refusing', async () => {
    const h = setup(eight);
    h.ctx.commandLabel = renamed;
    await h.command('achievements', []);
    const next = customIdOf(h.executor.requests[1], 'Next');

    const [refusal] = await h.press(next, { userId: USER_2 });

    expect(embedText(refusal)).toContain('Only the person who ran /badges can turn these pages.');
  });

  test('ignore other modules’ buttons', async () => {
    const h = setup(eight);
    const foreign = encodeCustomId('leveling', 'pg', USER, '2', USER);
    if (!foreign.ok) throw new Error(foreign.humanReason);

    expect(await h.press(foreign.customId)).toHaveLength(0);
  });

  test('refuse while Achievements is off', async () => {
    const h = setup(eight, { enabled: false });
    const next = encodeCustomId('achievements', 'pg', USER, '2', USER);
    if (!next.ok) throw new Error(next.humanReason);

    const [refusal] = await h.press(next.customId);

    expect(payloadOf(refusal)).toMatchObject({ callbackType: 4, ephemeral: true });
    expect(embedText(refusal)).toContain(ACHIEVEMENTS_OFF);
  });

  test('refuse a control Proton no longer knows', async () => {
    const h = setup(eight);
    const stale = encodeCustomId('achievements', 'zz', USER);
    if (!stale.ok) throw new Error(stale.humanReason);

    const [refusal] = await h.press(stale.customId);

    expect(embedText(refusal)).toContain(UNKNOWN_CONTROL);
  });
});

describe('autocomplete', () => {
  const achievements = [
    CHATTERBOX,
    single('voice-regular', 'Voice Regular'),
    single('chat-secret', 'Chat Secret', 'draft'),
    single('chat-archive', 'Chat Archive', 'archived'),
    single('chattier', 'Chattier Archive', 'archived'),
  ];

  async function seeded(options: { enabled?: boolean } = {}) {
    const h = setup(achievements, options);
    await h.store.unlock(unlockOf('chat-archive', ['single']));
    await h.store.unlock(unlockOf('chat-legend', ['gold'], { name: 'Chat Legend' }));
    return h;
  }

  test('suggests live achievements plus the ones the member earned', async () => {
    const h = await seeded();

    expect(choicesOf(await h.autocomplete('view', 'CHAT'))).toEqual([
      { name: 'Chatterbox', value: 'chatterbox' },
      { name: 'Chat Archive (archived)', value: 'chat-archive' },
      { name: 'Chat Legend (retired)', value: 'chat-legend' },
    ]);
  });

  test('suggests archived achievements for a reset, never drafts', async () => {
    const h = await seeded();

    expect(choicesOf(await h.autocomplete('reset', 'chat'))).toEqual([
      { name: 'Chatterbox', value: 'chatterbox' },
      { name: 'Chat Archive (archived)', value: 'chat-archive' },
      { name: 'Chattier Archive (archived)', value: 'chattier' },
    ]);
  });

  test('uses the chosen member’s badges when one is picked', async () => {
    const h = await seeded();
    await h.store.unlock(
      unlockOf('chat-medal', ['single'], { userId: USER_2, name: 'Chat Medal' }),
    );

    const choices = choicesOf(
      await h.autocomplete('view', 'medal', {
        options: [{ type: OptionType.User, name: 'user', value: USER_2 }],
      }),
    );

    expect(choices).toEqual([{ name: 'Chat Medal (retired)', value: 'chat-medal' }]);
  });

  test('answers with an empty list rather than not at all', async () => {
    const h = await seeded();
    expect(choicesOf(await h.autocomplete('view', 'nothing like it'))).toEqual([]);

    const off = await seeded({ enabled: false });
    expect(choicesOf(await off.autocomplete('view', 'chat'))).toEqual([]);
  });

  test('caps suggestions at 25', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      single(`goal-${index + 10}`, `Goal ${index + 10}`),
    );
    const h = setup(many);

    expect(choicesOf(await h.autocomplete('view', ''))).toHaveLength(25);
  });

  test('leaves other commands and options alone', async () => {
    const h = await seeded();

    expect(await h.autocomplete('view', 'chat', { commandName: 'tag' })).toHaveLength(0);
    expect(await h.autocomplete('view', 'chat', { focused: 'user' })).toHaveLength(0);
  });
});

describe('reset confirmation', () => {
  async function prompted(options: { rewardsAgain?: boolean; achievement?: string | null } = {}) {
    const h = setup([CHATTERBOX]);
    await h.store.unlock(unlockOf('chatterbox', ['bronze'], { userId: USER_2 }));

    const chosen = options.achievement === undefined ? 'chatterbox' : options.achievement;
    await h.command(
      'achievement',
      [
        {
          type: OptionType.Subcommand,
          name: 'reset',
          options: [
            { type: OptionType.User, name: 'member', value: USER_2 },
            ...(chosen === null
              ? []
              : [{ type: OptionType.String, name: 'achievement', value: chosen }]),
            ...(options.rewardsAgain
              ? [{ type: OptionType.Boolean, name: 'rewards_again', value: true }]
              : []),
          ],
        },
      ],
      MANAGE,
    );

    const prompt = h.executor.requests[1];
    return { h, reset: customIdOf(prompt, 'Reset'), cancel: customIdOf(prompt, 'Cancel') };
  }

  async function stateOf(h: ReturnType<typeof setup>) {
    const [state] = await h.store.memberStates(GUILD, USER_2, ['chatterbox']);
    return state;
  }

  test('resets once confirmed, with an audit entry and a new generation', async () => {
    const { h, reset } = await prompted();

    const [working, done, ...rest] = await h.press(reset, { permissions: MANAGE });

    expect(rest).toHaveLength(0);
    expect(payloadOf(working)).toMatchObject({ callbackType: 7, content: WORKING, components: [] });
    expect(done?.kind).toBe('interaction_followup');
    expect(payloadOf(done)).toMatchObject({ ephemeral: true, applicationId: APP });
    expect(embedText(done)).toContain(`Reset **Chatterbox** for <@${USER_2}>.`);
    expect(embedText(done)).toContain('won’t be given again');

    expect(h.store.audits).toEqual([
      {
        id: `achievements.reset:${GUILD}:${INTERACTION}`,
        guildId: GUILD,
        actorId: USER,
        source: 'command',
        action: 'module.achievements.reset',
        before: null,
        after: {
          scope: 'member_achievement',
          userId: USER_2,
          achievementIds: ['chatterbox'],
          allowRewardsAgain: false,
        },
      },
    ]);
    expect(await stateOf(h)).toMatchObject({ generation: 1, rewardEpoch: 0, unlocked: [] });
    expect(await h.store.unlocksOf(GUILD, USER_2)).toHaveLength(0);
  });

  test('asks a second, separate time before letting rewards be earned again', async () => {
    const { h, reset } = await prompted({ rewardsAgain: true });

    const [second, ...rest] = await h.press(reset, { permissions: MANAGE });

    expect(rest).toHaveLength(0);
    expect(payloadOf(second)).toMatchObject({ callbackType: 7 });
    expect(String(payloadOf(second).content)).toContain(
      `Also let <@${USER_2}> earn the rewards again?`,
    );
    expect(h.store.audits).toHaveLength(0);
    expect(await stateOf(h)).toMatchObject({ generation: 0 });

    const again = customIdOf(second, 'Let them earn rewards again');
    const [working, done] = await h.press(again, { permissions: MANAGE });

    expect(payloadOf(working)).toMatchObject({ content: WORKING });
    expect(embedText(done)).toContain('They can earn the rewards again.');
    expect(h.store.audits).toHaveLength(1);
    expect(await stateOf(h)).toMatchObject({ generation: 1, rewardEpoch: 1, unlocked: [] });
  });

  test('cancelling at the second question resets nothing', async () => {
    const { h, reset } = await prompted({ rewardsAgain: true });
    const [second] = await h.press(reset, { permissions: MANAGE });

    const [cancelled] = await h.press(customIdOf(second, 'Cancel'));

    expect(payloadOf(cancelled)).toMatchObject({ callbackType: 7, content: RESET_CANCELLED });
    expect(h.store.audits).toHaveLength(0);
    expect(await stateOf(h)).toMatchObject({ generation: 0, unlocked: ['bronze'] });
  });

  test('a confirmation works once', async () => {
    const { h, reset } = await prompted();
    await h.press(reset, { permissions: MANAGE });

    const [refusal, ...rest] = await h.press(reset, { permissions: MANAGE });

    expect(rest).toHaveLength(0);
    expect(payloadOf(refusal)).toMatchObject({ callbackType: 4, ephemeral: true });
    expect(embedText(refusal)).toContain(RESET_SETTLED);
    expect(h.store.audits).toHaveLength(1);
  });

  test('stays pressable when Discord never heard the acknowledgement', async () => {
    const { h, reset } = await prompted();
    h.executor.failNext({
      status: 'failed_api',
      failure: { code: 'discord_404', humanReason: 'Unknown interaction.', discordCode: 10062 },
    });

    const lost = await h.press(reset, { permissions: MANAGE });

    expect(lost).toHaveLength(1);
    expect(h.store.audits).toHaveLength(0);

    const [working, done, ...rest] = await h.press(reset, { permissions: MANAGE });

    expect(rest).toHaveLength(0);
    expect(payloadOf(working)).toMatchObject({ callbackType: 7, content: WORKING });
    expect(embedText(done)).toContain(`Reset **Chatterbox** for <@${USER_2}>.`);
    expect(h.store.audits).toHaveLength(1);
  });

  test('stays pressable when the second question could not be shown', async () => {
    const { h, reset } = await prompted({ rewardsAgain: true });
    h.executor.failNext({
      status: 'failed_api',
      failure: { code: 'discord_404', humanReason: 'Unknown interaction.', discordCode: 10062 },
    });

    expect(await h.press(reset, { permissions: MANAGE })).toHaveLength(1);

    const [second, ...rest] = await h.press(reset, { permissions: MANAGE });

    expect(rest).toHaveLength(0);
    expect(String(payloadOf(second).content)).toContain(
      `Also let <@${USER_2}> earn the rewards again?`,
    );
  });

  test('cancel makes the Reset button stop working', async () => {
    const { h, reset, cancel } = await prompted();

    await h.press(cancel);
    const [refusal] = await h.press(reset, { permissions: MANAGE });

    expect(embedText(refusal)).toContain(RESET_SETTLED);
    expect(h.store.audits).toHaveLength(0);
  });

  test('a stale confirmation expires', async () => {
    const { h, reset } = await prompted();
    h.clock.now += RESET_DRAFT_TTL_MS + MINUTE;

    const [expired, ...rest] = await h.press(reset, { permissions: MANAGE });

    expect(rest).toHaveLength(0);
    expect(payloadOf(expired)).toMatchObject({ callbackType: 7, components: [] });
    expect(embedText(expired)).toContain(
      'This confirmation expired, so nothing was reset. Run /achievement reset again.',
    );
    expect(h.store.audits).toHaveLength(0);
  });

  test('the presser needs Manage Server too', async () => {
    const { h, reset } = await prompted();

    const [refusal] = await h.press(reset, { permissions: Permissions.SendMessages });

    expect(embedText(refusal)).toContain(
      'You need Manage Server to reset achievements. Anyone can still use /achievement view.',
    );
    expect(h.store.audits).toHaveLength(0);
  });

  test('resetting everything covers configured and retired achievements', async () => {
    const { h, reset } = await prompted({ achievement: null });
    await h.store.unlock(unlockOf('old-timer', ['bronze'], { userId: USER_2, name: 'Old Timer' }));

    await h.press(reset, { permissions: MANAGE });

    expect(h.store.audits[0]?.after).toMatchObject({
      scope: 'member_all',
      achievementIds: ['chatterbox', 'old-timer'],
    });
    expect(await h.store.unlocksOf(GUILD, USER_2)).toHaveLength(0);
  });

  test('a stale confirmation names /achievement reset as this server shows it', async () => {
    const { h, reset } = await prompted();
    h.ctx.commandLabel = renamed;
    h.clock.now += RESET_DRAFT_TTL_MS + MINUTE;

    const [expired] = await h.press(reset, { permissions: MANAGE });

    expect(embedText(expired)).toContain(
      'This confirmation expired, so nothing was reset. Run /badge reset again.',
    );
  });

  test('a presser without Manage Server is pointed at the renamed view', async () => {
    const { h, reset } = await prompted();
    h.ctx.commandLabel = renamed;

    const [refusal] = await h.press(reset, { permissions: Permissions.SendMessages });

    expect(embedText(refusal)).toContain('Anyone can still use /badge view.');
    expect(embedText(refusal)).not.toContain('/achievement');
  });
});
