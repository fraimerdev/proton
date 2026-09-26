import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type CommandLabeler,
  encodeCustomId,
  formatCommandLabel,
  type ProtonEvent,
  ProviderRegistry,
  STATUS_ERROR_COLOUR,
} from '@proton/core';
import { handleBuilderComponent, handleBuilderModal } from '../src/builder/handler.ts';
import { handleBuilderPress } from '../src/builder/interactions.ts';
import { BUILDER_LOGIC, BUILDER_START, ITEM_MODAL } from '../src/builder/screens.ts';
import { MemoryDraftStore } from '../src/builder/state.ts';
import { giveawaysConfigSchema, MODULE_ID } from '../src/config.ts';
import { renderList } from '../src/message.ts';
import type { Ctx } from '../src/perform.ts';
import { renderStats } from '../src/reports.ts';
import type { CreateGiveawayInput, GiveawayStatus } from '../src/store.ts';
import {
  CHANNEL,
  type CommandHarness,
  commandHarness,
  GUILD,
  group,
  HOST,
  stringOption,
  subcommand,
} from './command-harness.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const HOUR = 60 * 60 * 1000;

const renamed: CommandLabeler = (key, path) =>
  formatCommandLabel(key, path, key === 'giveaway' ? 'gw' : undefined);

async function seed(h: CommandHarness, status?: GiveawayStatus): Promise<void> {
  await h.store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(Date.now() + 4 * HOUR),
    createdBy: HOST,
  } satisfies CreateGiveawayInput);

  const row = h.store.giveaways.get('g1');
  if (row && status) h.store.giveaways.set('g1', { ...row, status });
}

const G1 = stringOption('giveaway', 'g1');

describe('/giveaway reroll on a cancelled giveaway', () => {
  test('answers privately in red instead of saying nothing', async () => {
    const h = commandHarness();
    await seed(h, 'cancelled');

    await h.run(subcommand('reroll', [G1]));

    expect(h.replyText()).toContain(
      'That giveaway was cancelled, so there are no winners to reroll.',
    );
    expect(h.replyColour()).toBe(STATUS_ERROR_COLOUR);
    expect(
      h.requests.find((request) => request.kind === 'interaction_reply')?.payload,
    ).toMatchObject({ ephemeral: true });
  });
});

describe('giveaway copy names /giveaway as the server shows it', () => {
  test('rerolling a running giveaway points at the renamed end command', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(subcommand('reroll', [G1]), { commandLabel: renamed });

    expect(h.replyText()).toContain('Use `/gw end` first.');
  });

  test('without a label source the reroll refusal keeps /giveaway', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(subcommand('reroll', [G1]));

    expect(h.replyText()).toContain('Use `/giveaway end` first.');
  });

  test('ending a drawn giveaway points at the renamed reroll command', async () => {
    const h = commandHarness();
    await seed(h, 'ended');

    await h.run(subcommand('end', [G1]), { commandLabel: renamed });

    expect(h.replyText()).toContain('Use `/gw reroll` instead.');
  });

  test('an empty template list names the renamed save command', async () => {
    const h = commandHarness();

    await h.run(group('template', 'list'), { commandLabel: renamed });

    expect(h.replyText()).toBe('No templates saved yet. Save one with `/gw template save`.');
  });

  test('a saved template names the renamed load command', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(group('template', 'save', [G1, stringOption('name', 'weekly')]), {
      commandLabel: renamed,
    });

    expect(h.replyText()).toContain('`/gw template load name:weekly`');
  });

  test('an empty list names the renamed create command', async () => {
    const h = commandHarness();

    await h.run(subcommand('list'), { commandLabel: renamed });

    expect(h.replyText()).toBe('No giveaways are running. Start one with `/gw create`.');
  });

  test('empty stats name the renamed create command', async () => {
    const h = commandHarness();

    await h.run(subcommand('stats'), { commandLabel: renamed });

    expect(h.replyText()).toContain('Start one with `/gw create`.');
  });

  test('ending a giveaway that has not started points at the renamed cancel command', async () => {
    const h = commandHarness();
    await seed(h, 'scheduled');

    await h.run(subcommand('end', [G1]), { commandLabel: renamed });

    expect(h.replyText()).toContain('To stop it, use `/gw cancel`.');
  });

  test('pausing a finished giveaway says it has already ended', async () => {
    const h = commandHarness();
    await seed(h, 'ended');

    await h.run(subcommand('pause', [G1]), { commandLabel: renamed });

    expect(h.replyText()).toContain('**A prize** has already ended, so it can’t be paused.');
  });

  test('shortening into the past points at the renamed end command', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(subcommand('shorten', [G1, stringOption('duration', '1d')]), {
      commandLabel: renamed,
    });

    expect(h.replyText()).toContain('To draw it now, use `/gw end`.');
  });

  test('an unknown subcommand names the command as renamed', async () => {
    const h = commandHarness();

    await h.run(subcommand('nonsense'), { commandLabel: renamed });

    expect(h.replyText()).toContain('I don’t recognise that `/gw` subcommand.');
  });

  test('the pure renderers fall back to /giveaway without labels', async () => {
    const stats = await new MemoryGiveawayStore().stats(GUILD);

    expect(renderList([], { commandLabel: renamed })).toContain('`/gw create`');
    expect(renderList([])).toContain('`/giveaway create`');
    expect(renderStats(stats, { commandLabel: renamed })).toContain('`/gw create`');
    expect(renderStats(stats)).toContain('`/giveaway create`');
  });
});

describe('the giveaway builder names /giveaway as the server shows it', () => {
  const deps = () => ({
    store: new MemoryGiveawayStore(),
    providers: new ProviderRegistry(),
    drafts: new MemoryDraftStore(),
    availability: { isEnabled: async () => true },
  });

  const statusOf = (reply: Awaited<ReturnType<typeof handleBuilderComponent>>): string =>
    reply.kind === 'message' ? (reply.body.embeds[0]?.description ?? '') : '';

  test('an expired builder press names the renamed create command', async () => {
    const input = {
      action: BUILDER_LOGIC,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: [],
    };

    expect(
      statusOf(await handleBuilderComponent(deps(), input, { commandLabel: renamed })),
    ).toContain('Start a new one with `/gw create`.');
    expect(statusOf(await handleBuilderComponent(deps(), input))).toContain(
      'Start a new one with `/giveaway create`.',
    );
  });

  test('an expired builder modal names the renamed create command', async () => {
    const input = {
      action: ITEM_MODAL,
      args: ['r', 'leveling.level'],
      guildId: GUILD,
      userId: HOST,
      fields: {},
      values: {},
    };

    expect(statusOf(await handleBuilderModal(deps(), input, { commandLabel: renamed }))).toContain(
      'That builder has expired. Start a new one with `/gw create`.',
    );
    expect(statusOf(await handleBuilderModal(deps(), input))).toContain('`/giveaway create`');
  });

  test('starting an expired builder names the renamed create command', async () => {
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
      commandLabel: renamed,
    };

    const encoded = encodeCustomId(MODULE_ID, BUILDER_START);
    if (!encoded.ok) throw new Error(encoded.humanReason);

    const event = {
      id: 'interaction.component:900000000000000001',
      type: 'interaction.component',
      guildId: GUILD,
      occurredAt: Date.now(),
      payload: {
        id: '900000000000000001',
        token: 'token',
        type: 3,
        application_id: '800000000000000001',
        guild_id: GUILD,
        channel_id: CHANNEL,
        member: { user: { id: HOST }, roles: [] },
        data: { custom_id: encoded.customId, component_type: 2 },
      },
    } as unknown as ProtonEvent;

    expect(await handleBuilderPress(event, ctx, deps())).toBe('handled');

    const payload = requests.find((request) => request.kind === 'interaction_reply')?.payload as
      | { embeds?: { description?: string }[] }
      | undefined;
    expect(payload?.embeds?.[0]?.description).toContain(
      'That builder has expired. Start a new one with `/gw create`.',
    );
  });
});
