import {
  type CommandContext,
  type CommandDefinition,
  checkLimit,
  type EntitlementTier,
  errorStatus,
  labelOf,
  newId,
  successStatus,
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
import { CANCELLABLE, cancelGiveaway, drawGiveaway } from './end.ts';
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
import { notPosted, renderList, viewOf } from './message.ts';
import {
  acknowledgeCommand,
  acknowledgeToggleable,
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
import type { GiveawayStatus, GiveawayStore } from './store.ts';
import { BONUS_MAX, BONUS_MIN } from './store.ts';
import { templatePayloadSchema } from './templates.ts';

type Ctx = CommandContext<GiveawaysConfig>;

const MISSING = 'Couldn’t find a giveaway with that ID in this server.';

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
          .setDescription('How long it runs, like 30m, 12h or 7d.')
          .setRequired(true)
          .setMaxLength(16),
      )
      .addStringOption((option) =>
        option
          .setName('prize')
          .setDescription('What you’re giving away.')
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
          .setDescription('Extra detail shown under the prize.')
          .setMaxLength(DESCRIPTION_MAX),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('drop')
      .setDescription('Post a drop. The first eligible member to press it wins, with no draw.')
      .addStringOption((option) =>
        option
          .setName('prize')
          .setDescription('What you’re dropping.')
          .setRequired(true)
          .setMaxLength(TITLE_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('expires')
          .setDescription('How long it stays up if nobody claims it. Defaults to 24h.')
          .setMaxLength(16),
      )
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Extra detail shown under the prize.')
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
      .setDescription('Stop a giveaway without drawing any winners.')
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
      .setDescription('Close entries for now. The time left is kept until you resume it.')
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
          .setDescription('Shown on the giveaway while it’s paused.')
          .setMaxLength(200),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('resume')
      .setDescription('Reopen a paused giveaway. Its end time moves by however long it was paused.')
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
          .setDescription('Which giveaway to extend.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How much longer, like 30m, 12h or 2d.')
          .setRequired(true)
          .setMaxLength(16),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('shorten')
      .setDescription('Make a giveaway end sooner.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to shorten.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How much sooner, like 30m, 12h or 2d.')
          .setRequired(true)
          .setMaxLength(16),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Change a giveaway that’s already posted.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to edit.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option.setName('prize').setDescription('What you’re giving away.').setMaxLength(TITLE_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Extra detail shown under the prize.')
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
          .setDescription('Banner image URL. Type “none” to remove it.')
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
      .setDescription('Show the details of a giveaway.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to show.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('entrants')
      .setDescription('List everyone in a giveaway and how many entries they have.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to list.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Which page to show.').setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('export')
      .setDescription('Download the entrant list as a CSV file.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to export.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('history')
      .setDescription('Show everything that has happened to a giveaway, in order.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to show.')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('stats').setDescription('Show giveaway totals for this server.'),
  );

  command.addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the giveaways running in this server.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('entries')
      .setDescription('Show the top entrants in a giveaway, or how many entries a member has.')
      .addStringOption((option) =>
        option
          .setName('giveaway')
          .setDescription('Which giveaway to check.')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addUserOption((option) =>
        option
          .setName('member')
          .setDescription('Whose entries to show. Leave empty to see the top entrants.'),
      ),
  );

  command.addSubcommandGroup((group) =>
    group
      .setName('template')
      .setDescription('Save a giveaway’s setup and start new ones from it.')
      .addSubcommand((sub) =>
        sub
          .setName('save')
          .setDescription('Save a finished or running giveaway as a template.')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('A name for the template.')
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
              .setDescription('Which template to load.')
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
              .setDescription('Which template to delete.')
              .setRequired(true)
              .setMaxLength(60),
          ),
      ),
  );

  command.addSubcommandGroup((group) =>
    group
      .setName('bonus')
      .setDescription('Give members extra entries in a giveaway.')
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
            option
              .setName('member')
              .setDescription('Who gets the extra entries.')
              .setRequired(true),
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
            option
              .setName('reason')
              .setDescription('Why they get them. Shown in the bonus list.')
              .setMaxLength(200),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Take back all the extra entries a member was given.')
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
              .setDescription('Whose extra entries to take back.')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('Show who has been given extra entries.')
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
      .setDescription('Keep members out of every giveaway in this server.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Block a member from entering giveaways.')
          .addUserOption((option) =>
            option.setName('member').setDescription('Who to block.').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Why they’re blocked.').setMaxLength(200),
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
        sub.setName('list').setDescription('Show who can’t enter giveaways in this server.'),
      ),
  );

  return command;
}

export const giveawayCommand: CommandDefinition<GiveawaysConfig> = {
  name: 'giveaway',
  description: 'Run a giveaway members enter with a button.',
  data: builder().toJSON(),
  reply: {
    default: 'private',
    toggleable: [
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
    ],
  },
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
  await reply(ctx, errorStatus(NOT_WIRED), { ephemeral: true });
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
    await reply(ctx, errorStatus(expiry.humanReason), { ephemeral: true });
    return;
  }

  const title = (ctx.options.getString('prize') ?? '').trim();
  if (title.length === 0) {
    await reply(ctx, errorStatus('The prize can’t be blank.'), { ephemeral: true });
    return;
  }

  const running = await store.countRunning(ctx.guildId);
  const limit = checkLimit(tierOf(ctx), 'activeGiveaways', running);
  if (!limit.ok) {
    await reply(ctx, errorStatus(limit.humanReason), { ephemeral: true });
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'drop');

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
    await answer.refuse(errorStatus(`Couldn’t build the drop message: ${rendered.humanReason}`));
    return;
  }

  const posted = await postGiveaway(ctx, {
    channelId: ctx.channelId,
    actorId: ctx.userId,
    components: rendered.components,
    idempotencyKey: `${ctx.idempotencyKey}:drop`,
  });

  if (!succeeded(posted)) {
    await answer.refuse(
      errorStatus(notPosted(ctx, title, ctx.channelId, posted.failure?.humanReason)),
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

  await answer.answer(
    successStatus(
      `**${title}** is up for grabs in <#${ctx.channelId}>. The first eligible member to press ` +
        'the button wins it.',
    ),
  );
}

async function start(ctx: Ctx, deps: GiveawaysDeps, store: GiveawayStore): Promise<void> {
  const duration = parseGiveawayDuration(ctx.options.getString('duration') ?? '');
  if (!duration.ok) {
    await reply(ctx, errorStatus(duration.humanReason), { ephemeral: true });
    return;
  }

  const title = (ctx.options.getString('prize') ?? '').trim();
  if (title.length === 0) {
    await reply(ctx, errorStatus('The prize can’t be blank.'), { ephemeral: true });
    return;
  }

  const running = await store.countRunning(ctx.guildId);
  const limit = checkLimit(tierOf(ctx), 'activeGiveaways', running);
  if (!limit.ok) {
    await reply(ctx, errorStatus(limit.humanReason), { ephemeral: true });
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'start');

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
    await answer.refuse(
      errorStatus(`Couldn’t build the giveaway message: ${rendered.humanReason}`),
    );
    return;
  }

  const posted = await postGiveaway(ctx, {
    channelId: ctx.channelId,
    actorId: ctx.userId,
    components: rendered.components,
    idempotencyKey: `${ctx.idempotencyKey}:post`,
  });

  if (!succeeded(posted)) {
    await answer.refuse(
      errorStatus(notPosted(ctx, title, ctx.channelId, posted.failure?.humanReason)),
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

  await answer.answer(
    successStatus(
      `**${title}** is live in <#${ctx.channelId}>. ${plural(winnerCount, 'winner')} will be ` +
        `drawn <t:${Math.floor(endsAt.getTime() / 1000)}:R>.`,
    ),
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
    await reply(ctx, errorStatus(limit.humanReason), { ephemeral: true });
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
    await reply(ctx, errorStatus(`Couldn’t open the giveaway builder: ${screen.humanReason}`), {
      ephemeral: true,
    });
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
        ? `No templates saved yet. Save one with \`${labelOf(ctx, 'giveaway', 'template.save')}\`.`
        : saved.map((entry) => `• **${entry.name}** · saved by <@${entry.createdBy}>`).join('\n'),
      { ephemeral: true },
    );
    return;
  }

  if (action === 'delete') {
    const deleted = await store.deleteTemplate(ctx.guildId, name);
    await reply(
      ctx,
      deleted
        ? successStatus(`Deleted the **${name}** template.`)
        : errorStatus(`Couldn’t find a template called **${name}** in this server.`),
      { ephemeral: true },
    );
    return;
  }

  if (action === 'save') {
    const giveaway = await store.get(ctx.guildId, ctx.options.getString('giveaway') ?? '');
    if (!giveaway) {
      await reply(ctx, errorStatus(MISSING), { ephemeral: true });
      return;
    }

    const answer = await acknowledgeCommand(ctx, deps, { path: 'template.save', ephemeral: true });

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

    await answer.answer(
      successStatus(
        `Saved **${name}** as a template. Start the next one from it with ` +
          `\`${labelOf(ctx, 'giveaway', 'template.load')} name:${name}\`.`,
      ),
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
    await reply(ctx, errorStatus(`Couldn’t find a template called **${name}** in this server.`), {
      ephemeral: true,
    });
    return;
  }

  const parsed = templatePayloadSchema.safeParse(saved.payload);
  if (!parsed.success) {
    await reply(
      ctx,
      errorStatus(
        `Couldn’t load the **${name}** template because it was saved in an older format. Save ` +
          'it again from a current giveaway.',
      ),
      { ephemeral: true },
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
    await reply(ctx, errorStatus(`Couldn’t open the giveaway builder: ${screen.humanReason}`), {
      ephemeral: true,
    });
    return;
  }

  await replyWithComponents(ctx, screen.content, screen.components);
}

function alreadyDrawn(ctx: Ctx): string {
  return (
    'That giveaway has already been drawn. ' +
    `Use \`${labelOf(ctx, 'giveaway', 'reroll')}\` instead.`
  );
}

const BEING_DRAWN = 'That giveaway is being drawn right now. Give it a moment.';

function undrawable(ctx: Ctx, status: GiveawayStatus): string | null {
  switch (status) {
    case 'running':
      return null;
    case 'drawing':
      return BEING_DRAWN;
    case 'ended':
      return alreadyDrawn(ctx);
    case 'cancelled':
      return 'That giveaway was cancelled, so there’s nobody to draw.';
    case 'paused':
      return (
        'That giveaway is paused. Resume it with ' +
        `\`${labelOf(ctx, 'giveaway', 'resume')}\` before you end it.`
      );
    case 'scheduled':
      return (
        'That giveaway hasn’t started yet, so there’s nobody to draw. To stop it, use ' +
        `\`${labelOf(ctx, 'giveaway', 'cancel')}\`.`
      );
  }
}

async function end(ctx: Ctx, deps: GiveawaysDeps): Promise<void> {
  const bound = bindDraw(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'drawing a giveaway', bound.unbound);
    return;
  }

  const giveawayId = ctx.options.getString('giveaway') ?? '';

  const current = await bound.bound.store.get(ctx.guildId, giveawayId);
  const refusal = current ? undrawable(ctx, current.status) : MISSING;
  if (refusal !== null) {
    await reply(ctx, errorStatus(refusal), { ephemeral: true });
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'end');

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
      await answer.refuse(errorStatus(MISSING));
      return;

    case 'already-drawing':
      await answer.refuse(errorStatus(BEING_DRAWN));
      return;

    case 'already-ended':
      await answer.refuse(
        errorStatus(
          // Losing recordDraw hands back the row beginDraw returned, still 'drawing' though ended.
          drawn.giveaway.status === 'drawing'
            ? alreadyDrawn(ctx)
            : (undrawable(ctx, drawn.giveaway.status) ?? alreadyDrawn(ctx)),
        ),
      );
      return;

    case 'drawn': {
      await publishResult(ctx, bound.bound, {
        giveaway: drawn.giveaway,
        summary: drawn.summary,
      });
      await deps.dirty?.clear(ctx.guildId, giveawayId);
      await scheduleNextRun(ctx, bound.bound.store, drawn.giveaway, START_JOB_ID);

      await answer.answer(
        successStatus(
          drawn.summary.winnerIds.length === 0
            ? `**${drawn.giveaway.title}** has been drawn, but nobody qualified, so there’s no ` +
                'winner.'
            : `**${drawn.giveaway.title}** has been drawn: ${plural(
                drawn.summary.winnerIds.length,
                'winner',
              )} from ${plural(drawn.summary.entrantCount, 'entrant')}.`,
        ),
      );
      return;
    }
  }
}

const NOTHING_TO_CANCEL = 'That giveaway is already over, so there’s nothing to cancel.';

async function cancel(ctx: Ctx, deps: GiveawaysDeps): Promise<void> {
  const bound = bindDraw(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'cancelling a giveaway', bound.unbound);
    return;
  }

  const giveawayId = ctx.options.getString('giveaway') ?? '';

  const current = await bound.bound.store.get(ctx.guildId, giveawayId);
  if (!current || !CANCELLABLE.includes(current.status)) {
    await reply(ctx, errorStatus(current ? NOTHING_TO_CANCEL : MISSING), { ephemeral: true });
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'cancel');

  const outcome = await cancelGiveaway(bound.bound, ctx.guildId, giveawayId);

  if (outcome.outcome !== 'cancelled') {
    await answer.refuse(errorStatus(outcome.outcome === 'missing' ? MISSING : NOTHING_TO_CANCEL));
    return;
  }

  await publishCancelled(ctx, bound.bound.store, outcome.giveaway, {
    actorId: ctx.userId,
    entrantCount: await bound.bound.store.entrantCount(outcome.giveaway.id),
  });

  await answer.answer(
    successStatus(`**${outcome.giveaway.title}** has been cancelled. Nobody was drawn.`),
  );
}

function unrerollable(ctx: Ctx, outcome: 'still-running' | 'cancelled' | 'nobody-left'): string {
  switch (outcome) {
    case 'still-running':
      return `That giveaway hasn’t been drawn yet. Use \`${labelOf(ctx, 'giveaway', 'end')}\` first.`;
    case 'cancelled':
      return 'That giveaway was cancelled, so there are no winners to reroll.';
    case 'nobody-left':
      return 'There was nobody left to draw. Everybody who qualified has already won this one.';
  }
}

async function reroll(ctx: Ctx, deps: GiveawaysDeps): Promise<void> {
  const bound = bindDraw(deps);
  if ('unbound' in bound) {
    await refuseUnbound(ctx, 'rerolling a giveaway', bound.unbound);
    return;
  }

  const giveawayId = ctx.options.getString('giveaway') ?? '';

  const current = await bound.bound.store.get(ctx.guildId, giveawayId);
  const refusal = !current
    ? MISSING
    : current.status === 'cancelled'
      ? unrerollable(ctx, 'cancelled')
      : current.status !== 'ended'
        ? unrerollable(ctx, 'still-running')
        : null;

  if (refusal !== null) {
    await reply(ctx, errorStatus(refusal), { ephemeral: true });
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'reroll');

  const outcome = await rerollGiveaway(
    { ...bound.bound, ...(deps.members ? { members: deps.members } : {}) },
    {
      guildId: ctx.guildId,
      giveawayId,
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
      await answer.refuse(errorStatus(MISSING));
      return;

    case 'still-running':
    case 'cancelled':
    case 'nobody-left':
      await answer.refuse(errorStatus(unrerollable(ctx, outcome.outcome)));
      return;

    case 'rerolled':
      await publishResult(ctx, bound.bound, {
        giveaway: outcome.giveaway,
        summary: outcome.summary,
        reroll: true,
        replacedIds: outcome.replaced,
      });
      await answer.answer(
        successStatus(
          `**${outcome.giveaway.title}** has been rerolled: ${plural(
            outcome.summary.winnerIds.length,
            'new winner',
          )}.`,
        ),
      );
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
      ctx,
    ),
    { ephemeral: true },
  );
}

async function entries(ctx: Ctx, store: GiveawayStore): Promise<void> {
  const giveawayId = ctx.options.getString('giveaway') ?? '';
  const asked = ctx.options.getUserId('member');

  const giveaway = await store.get(ctx.guildId, giveawayId);
  if (!giveaway) {
    await reply(ctx, errorStatus(MISSING), { ephemeral: true });
    return;
  }

  // No member named means "who is in this", which is the question a host actually has.
  if (asked === null) {
    const [top, total] = await Promise.all([
      store.topEntrants(giveawayId, TOP_ENTRANTS),
      store.entrantCount(giveawayId),
    ]);

    if (top.length === 0) {
      await reply(ctx, `Nobody has entered **${giveaway.title}** yet.`, { ephemeral: true });
      return;
    }

    const weighted = top.reduce((sum, row) => sum + row.totalEntries, 0);
    const lines = top.map(
      (row, index) =>
        `\`${index + 1}.\` <@${row.userId}> · ${plural(row.totalEntries, 'entry', 'entries')}`,
    );

    await reply(
      ctx,
      [
        `**${giveaway.title}** · ${plural(total, 'entrant')}`,
        ...lines,
        top.length < total ? `…and ${total - top.length} more.` : '',
        `Top ${top.length} hold ${plural(weighted, 'entry', 'entries')} between them.`,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      { ephemeral: true },
    );
    return;
  }

  const entry = await store.entry(giveawayId, asked);
  if (!entry) {
    await reply(ctx, `<@${asked}> isn’t in the draw for **${giveaway.title}**.`, {
      ephemeral: true,
    });
    return;
  }

  await reply(
    ctx,
    `<@${asked}> has **${plural(entry.totalEntries, 'entry', 'entries')}** in **${giveaway.title}**.`,
    { ephemeral: true },
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
                ? `• <@&${entry.subjectId}>${entry.reason ? `: ${entry.reason}` : ''}`
                : `• <@${entry.subjectId}>${entry.reason ? `: ${entry.reason}` : ''}`,
            )
            .join('\n'),
      { ephemeral: true },
    );
    return;
  }

  const userId = ctx.options.getUserId('member');
  if (!userId) {
    await reply(ctx, errorStatus('Choose a member to block or unblock.'), { ephemeral: true });
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
        ? successStatus(`<@${userId}> can no longer enter giveaways in this server.`)
        : errorStatus(`<@${userId}> is already blocked from giveaways in this server.`),
      { ephemeral: true },
    );
    return;
  }

  const removed = await store.removeBlacklist(ctx.guildId, 'user', userId);
  await reply(
    ctx,
    removed
      ? successStatus(`<@${userId}> can enter giveaways in this server again.`)
      : errorStatus(`<@${userId}> isn’t blocked from giveaways in this server.`),
    { ephemeral: true },
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
          await bonusCommand(ctx, deps, store, sub ?? 'list');
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
            await entrantsCommand(ctx, deps, store);
            return;
          case 'export':
            await exportCommand(ctx, deps, store);
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
            await reply(
              ctx,
              errorStatus(`I don’t recognise that \`${labelOf(ctx, 'giveaway')}\` subcommand.`),
              { ephemeral: true },
            );
        }
      },
    },
  ];
}

export { refreshMessage };
