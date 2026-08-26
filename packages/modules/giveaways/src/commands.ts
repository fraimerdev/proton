import {
  type CommandContext,
  type CommandDefinition,
  checkLimit,
  type EntitlementTier,
  newId,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { publishResult, refreshMessage } from './announce.ts';
import { draftKey, emptyDraft } from './builder/state.ts';
import { stepScreen } from './builder/steps.ts';
import {
  DESCRIPTION_MAX,
  GIVEAWAY_LIST_MAX,
  type GiveawaysConfig,
  MODULE_ID,
  parseGiveawayDuration,
  plural,
  TITLE_MAX,
  TOP_ENTRANTS,
  WINNER_COUNT_MAX,
} from './config.ts';
import { bindBuilder, bindDraw, bindStore, describeUnbound, type GiveawaysDeps } from './deps.ts';
import { renderCard } from './embed.ts';
import { cancelGiveaway, drawGiveaway } from './end.ts';
import { publishCancelled, publishCreated } from './events.ts';
import {
  bonusCommand,
  editCommand,
  entrantsCommand,
  exportCommand,
  historyCommand,
  infoCommand,
  pauseCommand,
  resumeCommand,
  shiftCommand,
  statsCommand,
} from './manage-commands.ts';
import { renderList, viewOf } from './message.ts';
import {
  NOT_WIRED,
  postGiveaway,
  reply,
  replyWithComponents,
  sentMessageId,
  succeeded,
} from './perform.ts';
import { scheduleNextRun } from './recurrence.ts';
import { rerollGiveaway } from './reroll.ts';
import { END_JOB_ID, START_JOB_ID } from './schedule.ts';
import type { GiveawayStore } from './store.ts';
import { BONUS_MAX, BONUS_MIN } from './store.ts';
import { templatePayloadSchema } from './templates.ts';

type Ctx = CommandContext<GiveawaysConfig>;

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run a giveaway members enter with a button.')
    .setContexts(InteractionContextType.Guild);

  command.addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Build a giveaway step by step, with requirements and bonus entries.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Post a giveaway in this channel.')
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How long it runs. A number and a unit — 30m, 12h, 7d.')
          .setRequired(true)
          .setMaxLength(16),
      )
      .addStringOption((option) =>
        option
          .setName('prize')
          .setDescription('What is being given away.')
          .setRequired(true)
          .setMaxLength(TITLE_MAX),
      )
      .addIntegerOption((option) =>
        option
          .setName('winners')
          .setDescription('How many members win. Defaults to this server’s setting.')
          .setMinValue(1)
          .setMaxValue(WINNER_COUNT_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Extra detail shown under the title.')
          .setMaxLength(DESCRIPTION_MAX),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('drop')
      .setDescription('Post a drop — the first eligible member to press it wins, with no draw.')
      .addStringOption((option) =>
        option
          .setName('prize')
          .setDescription('What is being dropped.')
          .setRequired(true)
          .setMaxLength(TITLE_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('expires')
          .setDescription('How long before it gives up unclaimed. Defaults to 24h.')
          .setMaxLength(16),
      )
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Extra detail shown under the title.')
          .setMaxLength(DESCRIPTION_MAX),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('Draw a running giveaway now, before its deadline.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to draw.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Stop a running giveaway without drawing anybody.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to cancel.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('reroll')
      .setDescription('Draw new winners for a giveaway that already ended.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to reroll.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('count')
          .setDescription('How many new winners to draw.')
          .setMinValue(1)
          .setMaxValue(WINNER_COUNT_MAX),
      )
      .addBooleanOption((option) =>
        option.setName('allow-repeat').setDescription('Let the previous winners be drawn again.'),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('pause')
      .setDescription('Close entries without ending it. The time left is held where it is.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to pause.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Shown on the giveaway while it is paused.')
          .setMaxLength(200),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('resume')
      .setDescription('Reopen a paused giveaway. The deadline moves by the time it was paused.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to resume.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('extend')
      .setDescription('Give a giveaway more time.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How much longer. A number and a unit — 30m, 12h, 2d.')
          .setRequired(true)
          .setMaxLength(16),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('shorten')
      .setDescription('Bring a giveaway’s deadline forward.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How much sooner. A number and a unit — 30m, 12h, 2d.')
          .setRequired(true)
          .setMaxLength(16),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Change a giveaway that is already posted.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option.setName('prize').setDescription('What is being given away.').setMaxLength(TITLE_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Extra detail shown under the title.')
          .setMaxLength(DESCRIPTION_MAX),
      )
      .addIntegerOption((option) =>
        option
          .setName('winners')
          .setDescription('How many members win.')
          .setMinValue(1)
          .setMaxValue(WINNER_COUNT_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('image')
          .setDescription('Banner image URL. Say “none” to remove it.')
          .setMaxLength(500),
      )
      .addIntegerOption((option) =>
        option
          .setName('colour')
          .setDescription('Accent colour as a number, 0 to 16777215.')
          .setMinValue(0)
          .setMaxValue(0xffffff),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Everything about one giveaway.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('entrants')
      .setDescription('Page through everybody in a giveaway and how many entries they hold.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Which page.').setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('export')
      .setDescription('Download the entrant list as a CSV, for an audit.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('history')
      .setDescription('Everything that has happened to one giveaway, in order.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('stats').setDescription('Giveaway totals for this server.'),
  );

  command.addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the giveaways running in this server.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('entries')
      .setDescription('Show how many entries somebody has, and why.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addUserOption((option) =>
        option.setName('member').setDescription('Whose entries to show. Defaults to you.'),
      ),
  );

  command.addSubcommandGroup((group) =>
    group
      .setName('template')
      .setDescription('Save a giveaway’s shape and start the next one from it.')
      .addSubcommand((sub) =>
        sub
          .setName('save')
          .setDescription('Save a finished or running giveaway as a template.')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('What to call it.')
              .setRequired(true)
              .setMaxLength(60),
          )
          .addStringOption((option) =>
            option
              .setName('giveaway')
              .setDescription('Which giveaway to copy.')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('load')
          .setDescription('Start a giveaway from a saved template.')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Which template.')
              .setRequired(true)
              .setMaxLength(60),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('Show this server’s saved templates.'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a saved template.')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Which template.')
              .setRequired(true)
              .setMaxLength(60),
          ),
      ),
  );

  command.addSubcommandGroup((group) =>
    group
      .setName('bonus')
      .setDescription('Grant somebody extra entries in one giveaway.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Give a member extra entries.')
          .addStringOption((option) =>
            option
              .setName('giveaway')
              .setDescription('Which giveaway.')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addUserOption((option) =>
            option.setName('member').setDescription('Who to reward.').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('entries')
              .setDescription('How many extra entries.')
              .setRequired(true)
              .setMinValue(BONUS_MIN)
              .setMaxValue(BONUS_MAX),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Why. Kept on the record.').setMaxLength(200),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Take back every extra entry a member was granted.')
          .addStringOption((option) =>
            option
              .setName('giveaway')
              .setDescription('Which giveaway.')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addUserOption((option) =>
            option
              .setName('member')
              .setDescription('Whose entries to take back.')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('Show who has been granted extra entries.')
          .addStringOption((option) =>
            option
              .setName('giveaway')
              .setDescription('Which giveaway.')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      ),
  );

  command.addSubcommandGroup((group) =>
    group
      .setName('blacklist')
      .setDescription('Keep members or roles out of every giveaway here.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Block a member from entering giveaways.')
          .addUserOption((option) =>
            option.setName('member').setDescription('Who to block.').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Why they are blocked.').setMaxLength(200),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Let a blocked member enter giveaways again.')
          .addUserOption((option) =>
            option.setName('member').setDescription('Who to unblock.').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('Show who cannot enter giveaways here.'),
      ),
  );

  return command;
}

export const giveawayCommand: CommandDefinition<GiveawaysConfig> = {
  name: 'giveaway',
  description: 'Run a giveaway members enter with a button.',
  data: builder().toJSON(),
  async handler() {
    // Replaced by giveawayCommands(deps); this exists so the manifest type stays honest.
  },
};

function tierOf(ctx: Ctx): EntitlementTier {
  return ctx.tier ?? 'free';
}

async function refuseUnbound(ctx: Ctx, what: string, unbound: readonly string[]): Promise<void> {
  ctx.logger.error(describeUnbound(what, unbound), {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
  });
  await reply(ctx, NOT_WIRED);
}

/**
 * A drop is a giveaway with `entry_method = 'drop'` and one winner. `ends_at` is not a deadline
 * anybody counts down to — it is the point at which an unclaimed drop gives up, so the end job
 * still needs one.
 */
async function drop(ctx: Ctx, deps: GiveawaysDeps, store: GiveawayStore): Promise<void> {
  const raw = ctx.options.getString('expires');
  const expiry = parseGiveawayDuration(raw ?? '24h');
  if (!expiry.ok) {
    await reply(ctx, expiry.humanReason);
    return;
  }

  const title = (ctx.options.getString('prize') ?? '').trim();
  if (title.length === 0) {
    await reply(ctx, 'A drop needs something to drop. Say what the prize is.');
    return;
  }

  const running = await store.countRunning(ctx.guildId);
  const limit = checkLimit(tierOf(ctx), 'activeGiveaways', running);
  if (!limit.ok) {
    await reply(ctx, limit.humanReason);
    return;
  }

  const id = newId();
  const endsAt = new Date((deps.now?.() ?? Date.now()) + expiry.ms);

  const giveaway = await store.create({
    id,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    messageId: null,
    hostId: ctx.userId,
    title,
    description: ctx.options.getString('description') ?? null,
    winnerCount: 1,
    entryMethod: 'drop',
    endsAt,
    createdBy: ctx.userId,
  });

  const rendered = renderCard('drop', {
    view: viewOf(giveaway),
    entrantCount: 0,
    requirements: [],
    multipliers: [],
    accentColor: ctx.config.embedColor,
  });

  if (!rendered.ok) {
    await reply(ctx, `I could not build the drop message: ${rendered.humanReason}`);
    return;
  }

  const posted = await postGiveaway(ctx, {
    channelId: ctx.channelId,
    actorId: ctx.userId,
    components: rendered.components,
    idempotencyKey: `${ctx.idempotencyKey}:drop`,
  });

  if (!succeeded(posted)) {
    await reply(
      ctx,
      `The drop was created but I could not post it: ${
        posted.failure?.humanReason ?? 'Discord refused the message.'
      }`,
    );
    return;
  }

  const messageId = sentMessageId(posted);
  if (messageId) await store.setMessageId(id, messageId);

  await ctx.schedule?.(END_JOB_ID, endsAt, `${MODULE_ID}:${id}`, { giveawayId: id });
  await publishCreated(
    ctx,
    store,
    { ...giveaway, messageId: messageId ?? null },
    {
      requirements: 0,
      multipliers: 0,
    },
  );

  await reply(ctx, `**${title}** is up for grabs. First eligible member to press it takes it.`);
}

async function start(ctx: Ctx, deps: GiveawaysDeps, store: GiveawayStore): Promise<void> {
  const duration = parseGiveawayDuration(ctx.options.getString('duration') ?? '');
  if (!duration.ok) {
    await reply(ctx, duration.humanReason);
    return;
  }

  const title = (ctx.options.getString('prize') ?? '').trim();
  if (title.length === 0) {
    await reply(ctx, 'A giveaway needs something to give away. Say what the prize is.');
    return;
  }

  const running = await store.countRunning(ctx.guildId);
  const limit = checkLimit(tierOf(ctx), 'activeGiveaways', running);
  if (!limit.ok) {
    await reply(ctx, limit.humanReason);
    return;
  }

  const winnerCount = ctx.options.getInteger('winners') ?? ctx.config.defaultWinnerCount;

  const id = newId();
  const endsAt = new Date((deps.now?.() ?? Date.now()) + duration.ms);

  const giveaway = await store.create({
    id,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    messageId: null,
    hostId: ctx.userId,
    title,
    description: ctx.options.getString('description') ?? null,
    winnerCount,
    endsAt,
    dmWinners: ctx.config.dmWinners,
    claimWindowSeconds: ctx.config.claimWindowSeconds ?? null,
    createdBy: ctx.userId,
  });

  const rendered = renderCard('active', {
    view: viewOf(giveaway),
    entrantCount: 0,
    requirements: [],
    multipliers: [],
    accentColor: ctx.config.embedColor,
  });

  if (!rendered.ok) {
    await reply(ctx, `I could not build the giveaway message: ${rendered.humanReason}`);
    return;
  }

  const posted = await postGiveaway(ctx, {
    channelId: ctx.channelId,
    actorId: ctx.userId,
    components: rendered.components,
    idempotencyKey: `${ctx.idempotencyKey}:post`,
  });

  if (!succeeded(posted)) {
    await reply(
      ctx,
      `The giveaway was created but I could not post it: ${
        posted.failure?.humanReason ?? 'Discord refused the message.'
      }`,
    );
    return;
  }

  const messageId = sentMessageId(posted);
  if (messageId) await store.setMessageId(id, messageId);

  // Durable, not an in-process timer: the row outlives this worker, and the boot sweep picks it
  // up even if the schedule row itself was never written.
  await ctx.schedule?.(END_JOB_ID, endsAt, `${MODULE_ID}:${id}`, { giveawayId: id });

  await publishCreated(
    ctx,
    store,
    { ...giveaway, messageId: messageId ?? null },
    { requirements: 0, multipliers: 0 },
  );

  await reply(
    ctx,
    `**${title}** is live — ${plural(winnerCount, 'winner')}, drawn <t:${Math.floor(
      endsAt.getTime() / 1000,
    )}:R>.`,
  );
}

async function create(ctx: Ctx, deps: GiveawaysDeps): Promise<void> {
  const bound = bindBuilder(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'the giveaway builder', bound.unbound);
    return;
  }

  const running = await bound.bound.store.countRunning(ctx.guildId);
  const limit = checkLimit(tierOf(ctx), 'activeGiveaways', running);
  if (!limit.ok) {
    await reply(ctx, limit.humanReason);
    return;
  }

  const key = draftKey(ctx.guildId, ctx.userId);
  const draft = emptyDraft(
    ctx.guildId,
    ctx.channelId,
    ctx.userId,
    {
      winnerCount: ctx.config.defaultWinnerCount,
      claimWindowSeconds: ctx.config.claimWindowSeconds ?? null,
    },
    deps.now?.() ?? Date.now(),
  );

  await bound.bound.drafts.put(key, draft);

  const available = await bound.bound.providers.listAvailable(
    ctx.guildId,
    bound.bound.availability,
  );
  const screen = stepScreen(draft, bound.bound.providers, available);

  if (!screen.ok) {
    await reply(ctx, `I could not open the builder: ${screen.humanReason}`);
    return;
  }

  await replyWithComponents(ctx, screen.content, screen.components);
}

async function template(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
  action: string,
): Promise<void> {
  const name = (ctx.options.getString('name') ?? '').trim();

  if (action === 'list') {
    const saved = await store.templates(ctx.guildId);

    await reply(
      ctx,
      saved.length === 0
        ? 'No templates saved yet. Save one with `/giveaway template save`.'
        : saved.map((entry) => `• **${entry.name}** — saved by <@${entry.createdBy}>`).join('\n'),
    );
    return;
  }

  if (action === 'delete') {
    const deleted = await store.deleteTemplate(ctx.guildId, name);
    await reply(
      ctx,
      deleted ? `Deleted the **${name}** template.` : `There is no template called **${name}**.`,
    );
    return;
  }

  if (action === 'save') {
    const giveaway = await store.get(ctx.guildId, ctx.options.getString('giveaway') ?? '');
    if (!giveaway) {
      await reply(ctx, 'There is no giveaway here with that id.');
      return;
    }

    const [requirements, multipliers] = await Promise.all([
      store.requirements(giveaway.id),
      store.multipliers(giveaway.id),
    ]);

    await store.saveTemplate({
      id: newId(),
      guildId: ctx.guildId,
      name,
      createdBy: ctx.userId,
      payload: {
        title: giveaway.title,
        description: giveaway.description,
        winnerCount: giveaway.winnerCount,
        requirementLogic: giveaway.requirementLogic,
        verifyOn: giveaway.verifyOn,
        maxEntriesPerUser: giveaway.maxEntriesPerUser,
        claimWindowSeconds: giveaway.claimWindowSeconds,
        durationMs: giveaway.endsAt.getTime() - giveaway.createdAt.getTime(),
        requirements: requirements.map((row) => ({
          providerId: row.providerId,
          config: row.config,
        })),
        multipliers: multipliers.map((row) => ({
          providerId: row.providerId,
          config: row.config,
          mode: row.mode,
        })),
      },
    });

    await reply(
      ctx,
      `Saved **${name}**. Start the next one from it with \`/giveaway template load name:${name}\`.`,
    );
    return;
  }

  // load: fills the builder rather than posting straight away, so the host still sees what they
  // are about to run and can change it.
  const bound = bindBuilder(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'the giveaway builder', bound.unbound);
    return;
  }

  const saved = await store.template(ctx.guildId, name);
  if (!saved) {
    await reply(ctx, `There is no template called **${name}**.`);
    return;
  }

  const parsed = templatePayloadSchema.safeParse(saved.payload);
  if (!parsed.success) {
    await reply(
      ctx,
      `The **${name}** template was saved in a shape I can no longer read, so it was not loaded. ` +
        'Save it again from a current giveaway.',
    );
    return;
  }

  const draft = {
    ...emptyDraft(
      ctx.guildId,
      ctx.channelId,
      ctx.userId,
      {
        winnerCount: ctx.config.defaultWinnerCount,
        claimWindowSeconds: ctx.config.claimWindowSeconds ?? null,
      },
      deps.now?.() ?? Date.now(),
    ),
    ...parsed.data,
  };

  const key = draftKey(ctx.guildId, ctx.userId);
  await bound.bound.drafts.put(key, draft);

  const available = await bound.bound.providers.listAvailable(
    ctx.guildId,
    bound.bound.availability,
  );
  const screen = stepScreen(draft, bound.bound.providers, available);

  if (!screen.ok) {
    await reply(ctx, `I could not open the builder: ${screen.humanReason}`);
    return;
  }

  await replyWithComponents(ctx, screen.content, screen.components);
}

async function end(ctx: Ctx, deps: GiveawaysDeps): Promise<void> {
  const bound = bindDraw(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'drawing a giveaway', bound.unbound);
    return;
  }

  const giveawayId = ctx.options.getString('giveaway') ?? '';

  const drawn = await drawGiveaway(
    { ...bound.bound, ...(deps.members ? { members: deps.members } : {}) },
    {
      guildId: ctx.guildId,
      giveawayId,
      drawnBy: ctx.userId,
      reason: `ended early by ${ctx.userId}`,
    },
  );

  switch (drawn.outcome) {
    case 'missing':
      await reply(ctx, 'There is no giveaway here with that id.');
      return;

    case 'already-drawing':
      await reply(
        ctx,
        'That giveaway is being drawn right now. Give it a moment — it will only be drawn once.',
      );
      return;

    case 'already-ended':
      await reply(ctx, 'That giveaway has already been drawn. Use `/giveaway reroll` instead.');
      return;

    case 'drawn': {
      await publishResult(ctx, bound.bound, {
        giveaway: drawn.giveaway,
        summary: drawn.summary,
      });
      await deps.dirty?.clear(ctx.guildId, giveawayId);
      await scheduleNextRun(ctx, bound.bound.store, drawn.giveaway, START_JOB_ID);

      await reply(
        ctx,
        drawn.summary.winnerIds.length === 0
          ? 'Drawn — but nobody qualified, so there is no winner.'
          : `Drawn. ${plural(drawn.summary.winnerIds.length, 'winner')} from ${plural(
              drawn.summary.entrantCount,
              'entrant',
            )}.`,
      );
      return;
    }
  }
}

async function cancel(ctx: Ctx, deps: GiveawaysDeps): Promise<void> {
  const bound = bindDraw(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'cancelling a giveaway', bound.unbound);
    return;
  }

  const outcome = await cancelGiveaway(
    bound.bound,
    ctx.guildId,
    ctx.options.getString('giveaway') ?? '',
  );

  if (outcome.outcome === 'missing') {
    await reply(ctx, 'There is no giveaway here with that id.');
    return;
  }

  if (outcome.outcome === 'already-ended') {
    await reply(ctx, 'That giveaway is not running, so there was nothing to cancel.');
    return;
  }

  await publishCancelled(ctx, bound.bound.store, outcome.giveaway, {
    actorId: ctx.userId,
    entrantCount: await bound.bound.store.entrantCount(outcome.giveaway.id),
  });

  await reply(ctx, `**${outcome.giveaway.title}** was cancelled. Nobody was drawn.`);
}

async function reroll(ctx: Ctx, deps: GiveawaysDeps): Promise<void> {
  const bound = bindDraw(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'rerolling a giveaway', bound.unbound);
    return;
  }

  const outcome = await rerollGiveaway(
    { ...bound.bound, ...(deps.members ? { members: deps.members } : {}) },
    {
      guildId: ctx.guildId,
      giveawayId: ctx.options.getString('giveaway') ?? '',
      drawnBy: ctx.userId,
      ...(ctx.options.getInteger('count') !== null
        ? { count: ctx.options.getInteger('count') as number }
        : {}),
      allowRepeat: ctx.options.getBoolean('allow-repeat') ?? false,
      reason: `rerolled by ${ctx.userId}`,
    },
  );

  switch (outcome.outcome) {
    case 'missing':
      await reply(ctx, 'There is no giveaway here with that id.');
      return;

    case 'still-running':
      await reply(ctx, 'That giveaway has not been drawn yet. Use `/giveaway end` first.');
      return;

    case 'nobody-left':
      await reply(
        ctx,
        'There was nobody left to draw — everybody who qualified has already won this one.',
      );
      return;

    case 'rerolled':
      await publishResult(ctx, bound.bound, {
        giveaway: outcome.giveaway,
        summary: outcome.summary,
        reroll: true,
        replacedIds: outcome.replaced,
      });
      await reply(ctx, `Rerolled. ${plural(outcome.summary.winnerIds.length, 'new winner')}.`);
      return;
  }
}

async function list(ctx: Ctx, store: GiveawayStore): Promise<void> {
  const giveaways = await store.list({
    guildId: ctx.guildId,
    state: 'running',
    limit: GIVEAWAY_LIST_MAX,
  });

  const counts = await store.entrantCounts(giveaways.map((giveaway) => giveaway.id));

  await reply(
    ctx,
    renderList(
      giveaways.map((giveaway) => ({
        view: viewOf(giveaway),
        entrants: counts.get(giveaway.id) ?? 0,
      })),
    ),
  );
}

async function entries(ctx: Ctx, store: GiveawayStore): Promise<void> {
  const giveawayId = ctx.options.getString('giveaway') ?? '';
  const asked = ctx.options.getUserId('member');

  const giveaway = await store.get(ctx.guildId, giveawayId);
  if (!giveaway) {
    await reply(ctx, 'There is no giveaway here with that id.');
    return;
  }

  // No member named means "who is in this", which is the question a host actually has.
  if (asked === null) {
    const [top, total] = await Promise.all([
      store.topEntrants(giveawayId, TOP_ENTRANTS),
      store.entrantCount(giveawayId),
    ]);

    if (top.length === 0) {
      await reply(ctx, `Nobody has entered **${giveaway.title}** yet.`);
      return;
    }

    const weighted = top.reduce((sum, row) => sum + row.totalEntries, 0);
    const lines = top.map(
      (row, index) => `\`${index + 1}.\` <@${row.userId}> — ${plural(row.totalEntries, 'entry')}`,
    );

    await reply(
      ctx,
      [
        `**${giveaway.title}** — ${plural(total, 'entrant')}`,
        ...lines,
        top.length < total ? `…and ${total - top.length} more.` : '',
        `Top ${top.length} hold ${plural(weighted, 'entry')} between them.`,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    );
    return;
  }

  const entry = await store.entry(giveawayId, asked);
  if (!entry) {
    await reply(ctx, `<@${asked}> is not in the draw for **${giveaway.title}**.`);
    return;
  }

  await reply(
    ctx,
    `<@${asked}> has **${plural(entry.totalEntries, 'entry')}** in **${giveaway.title}**.`,
  );
}

async function blacklist(ctx: Ctx, store: GiveawayStore, action: string): Promise<void> {
  if (action === 'list') {
    const entries = await store.blacklist(ctx.guildId);

    await reply(
      ctx,
      entries.length === 0
        ? 'Nobody is blocked from giveaways here.'
        : entries
            .map((entry) =>
              entry.subjectType === 'role'
                ? `• <@&${entry.subjectId}>${entry.reason ? ` — ${entry.reason}` : ''}`
                : `• <@${entry.subjectId}>${entry.reason ? ` — ${entry.reason}` : ''}`,
            )
            .join('\n'),
    );
    return;
  }

  const userId = ctx.options.getUserId('member');
  if (!userId) {
    await reply(ctx, 'Say which member.');
    return;
  }

  if (action === 'add') {
    const added = await store.addBlacklist(ctx.guildId, {
      subjectType: 'user',
      subjectId: userId,
      addedBy: ctx.userId,
      reason: ctx.options.getString('reason') ?? null,
    });

    await reply(
      ctx,
      added
        ? `<@${userId}> can no longer enter giveaways here.`
        : `<@${userId}> was already blocked.`,
    );
    return;
  }

  const removed = await store.removeBlacklist(ctx.guildId, 'user', userId);
  await reply(
    ctx,
    removed ? `<@${userId}> can enter giveaways again.` : `<@${userId}> was not blocked.`,
  );
}

export function giveawayCommands(deps: GiveawaysDeps): CommandDefinition<GiveawaysConfig>[] {
  return [
    {
      ...giveawayCommand,
      async handler(ctx) {
        const bound = bindStore(deps);
        if ('unbound' in bound) {
          await refuseUnbound(ctx, 'running giveaways', bound.unbound);
          return;
        }

        const { store } = bound.bound;
        const group = ctx.options.getSubcommandGroup();
        const sub = ctx.options.getSubcommand();

        if (group === 'bonus') {
          await bonusCommand(ctx, store, sub ?? 'list');
          return;
        }

        if (group === 'blacklist') {
          await blacklist(ctx, store, sub ?? 'list');
          return;
        }

        if (group === 'template') {
          await template(ctx, deps, store, sub ?? 'list');
          return;
        }

        switch (sub) {
          case 'create':
            await create(ctx, deps);
            return;
          case 'start':
            await start(ctx, deps, store);
            return;
          case 'drop':
            await drop(ctx, deps, store);
            return;
          case 'end':
            await end(ctx, deps);
            return;
          case 'cancel':
            await cancel(ctx, deps);
            return;
          case 'reroll':
            await reroll(ctx, deps);
            return;
          case 'pause':
            await pauseCommand(ctx, deps, store);
            return;
          case 'resume':
            await resumeCommand(ctx, deps, store);
            return;
          case 'extend':
            await shiftCommand(ctx, deps, store, 1);
            return;
          case 'shorten':
            await shiftCommand(ctx, deps, store, -1);
            return;
          case 'edit':
            await editCommand(ctx, deps, store);
            return;
          case 'info':
            await infoCommand(ctx, deps, store);
            return;
          case 'entrants':
            await entrantsCommand(ctx, store);
            return;
          case 'export':
            await exportCommand(ctx, store);
            return;
          case 'history':
            await historyCommand(ctx, store);
            return;
          case 'stats':
            await statsCommand(ctx, store);
            return;
          case 'list':
            await list(ctx, store);
            return;
          case 'entries':
            await entries(ctx, store);
            return;
          default:
            await reply(ctx, 'That giveaway subcommand does not exist.');
        }
      },
    },
  ];
}

export { refreshMessage };
