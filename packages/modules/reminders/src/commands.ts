import {
  type CommandContext,
  type CommandDefinition,
  checkLimit,
  type EntitlementTier,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import {
  MODULE_ID,
  REMINDER_CONTENT_MAX,
  REMINDER_LIST_LIMIT,
  type RemindersConfig,
  resolveDelay,
} from './config.ts';
import { DELIVER_JOB } from './deliver.ts';
import { bindStore, describeUnbound, type RemindersDeps } from './deps.ts';
import { MENTIONS_OFF, reply } from './perform.ts';
import { renderPending, unixSeconds } from './render.ts';
import type { Reminder, ReminderStore } from './store.ts';

type Command = CommandDefinition<RemindersConfig>;
type Ctx = CommandContext<RemindersConfig>;

const DISABLED =
  'Reminders are switched off in this server, so I would never post one. An admin can turn ' +
  'the Reminders module on from the Proton dashboard.';

const NOT_WIRED =
  'I can’t run reminders right now. Nothing was changed. This is a fault on my side, not a ' +
  'setting in this server.';

const NO_SCHEDULER =
  'I can’t set that reminder — I have no way to come back at that time, so it would never be ' +
  'posted. Nothing was saved. This is a fault on my side, not a setting in this server.';

const DURATION_HINT = 'I need to know how far ahead, for example `30m`, `12h` or `7d`.';

async function ready(ctx: Ctx, deps: RemindersDeps, what: string): Promise<ReminderStore | null> {
  if (!ctx.config.enabled) {
    await reply(ctx, DISABLED);
    return null;
  }

  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(what, bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, NOT_WIRED);
    return null;
  }

  return bound.store;
}

async function book(ctx: Ctx, reminder: Reminder): Promise<string | null> {
  try {
    const outcome = await ctx.schedule?.(
      DELIVER_JOB,
      reminder.remindAt,
      reminder.id,
      { reminderId: reminder.id },
      { replace: true },
    );

    if (outcome?.scheduled) return null;

    return 'the scheduler already holds a job under this reminder’s key';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function remindCommand(deps: RemindersDeps): Command {
  return {
    name: 'remind',
    description: 'Remind yourself about something later, in this channel.',

    data: new SlashCommandBuilder()
      .setName('remind')
      .setDescription('Remind yourself about something later, in this channel.')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How far ahead: a number and a unit, such as 30m, 12h or 7d.')
          .setRequired(true)
          .setMaxLength(32),
      )
      .addStringOption((option) =>
        option
          .setName('text')
          .setDescription('What to remind you about.')
          .setRequired(true)
          .setMaxLength(REMINDER_CONTENT_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      const store = await ready(ctx, deps, 'a reminder could not be saved');
      if (!store) return;

      const raw = ctx.options.getString('duration');
      if (raw === null || raw.trim().length === 0) {
        await reply(ctx, DURATION_HINT);
        return;
      }

      const delay = resolveDelay(raw, ctx.config);
      if (!delay.ok) {
        await reply(ctx, delay.humanReason);
        return;
      }

      const text = ctx.options.getString('text')?.trim() ?? '';
      if (text.length === 0) {
        await reply(ctx, 'A reminder needs something to say — tell me what to remind you about.');
        return;
      }

      if (typeof ctx.schedule !== 'function') {
        ctx.logger.error(
          'Reminders is enabled in this server but this process has no scheduler: the module ' +
            'context was built without `schedule`, so a saved reminder would never fire. The ' +
            'worker must be started with a scheduled-action store.',
          { guildId: ctx.guildId, moduleId: MODULE_ID },
        );
        await reply(ctx, NO_SCHEDULER);
        return;
      }

      const tier: EntitlementTier = ctx.tier ?? 'free';
      const limit = checkLimit(
        tier,
        'remindersPerUser',
        await store.countPending(ctx.guildId, ctx.userId),
      );

      if (!limit.ok) {
        await reply(
          ctx,
          `I did not set that reminder: ${limit.humanReason} ` +
            '`/reminders list` shows the ones you already have and `/reminders cancel` clears one.',
        );
        return;
      }

      const reminder = await store.create({
        id: ctx.idempotencyKey,
        guildId: ctx.guildId,
        userId: ctx.userId,
        channelId: ctx.channelId,
        content: text.slice(0, REMINDER_CONTENT_MAX),
        remindAt: new Date(Date.now() + delay.ms),
      });

      // Null means the id was already taken, and the id is this interaction's event id — so the
      // gateway redelivered the command and the first delivery already booked it.
      if (reminder === null) return;

      const failure = await book(ctx, reminder);
      if (failure !== null) {
        await store.remove(ctx.guildId, reminder.id, ctx.userId);

        ctx.logger.error(`reminders could not book a delivery: ${failure}`, {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
          userId: ctx.userId,
        });

        await reply(
          ctx,
          'I couldn’t save that reminder, so I threw it away rather than leave you one that ' +
            'never fires. Try again in a moment.',
        );
        return;
      }

      await reply(
        ctx,
        `I'll remind you <t:${unixSeconds(reminder.remindAt)}:R>, here in this channel.`,
      );
    },
  };
}

async function list(ctx: Ctx, store: ReminderStore): Promise<void> {
  const [pending, total] = await Promise.all([
    store.pending({ guildId: ctx.guildId, userId: ctx.userId, limit: REMINDER_LIST_LIMIT }),
    store.countPending(ctx.guildId, ctx.userId),
  ]);

  await reply(ctx, renderPending(pending, total), { allowedMentions: MENTIONS_OFF });
}

// The row is already gone by the time this runs, so a schedule left behind fires, finds nothing
// and returns — worth a loud log, never worth failing the member's cancellation over.
async function retire(ctx: Ctx, reminderId: string): Promise<void> {
  const meta = { guildId: ctx.guildId, moduleId: MODULE_ID, reminderId };

  if (typeof ctx.cancel !== 'function') {
    ctx.logger.warn(
      'a reminder was cancelled but this process has no scheduler, so its delivery could not be ' +
        'retired.',
      meta,
    );
    return;
  }

  try {
    await ctx.cancel(DELIVER_JOB, reminderId);
  } catch (error) {
    ctx.logger.error(
      `reminders deleted a reminder but could not retire its delivery: ${
        error instanceof Error ? error.message : String(error)
      }`,
      meta,
    );
  }
}

async function cancel(ctx: Ctx, store: ReminderStore): Promise<void> {
  const id = ctx.options.getString('reminder')?.trim() ?? '';
  if (id.length === 0) {
    await reply(
      ctx,
      'Tell me which reminder to cancel — start typing and pick one of yours from the list.',
    );
    return;
  }

  const reminder = await store.get(ctx.guildId, id);
  if (!reminder) {
    await reply(
      ctx,
      'I have no reminder by that name in this server — it may already have been posted or ' +
        'cancelled. `/reminders list` shows what you have waiting.',
    );
    return;
  }

  if (reminder.userId !== ctx.userId) {
    await reply(
      ctx,
      `That reminder was set by <@${reminder.userId}>, so only they can cancel it. ` +
        '`/reminders list` shows yours.',
      { allowedMentions: MENTIONS_OFF },
    );
    return;
  }

  if (reminder.deliveredAt !== null) {
    await reply(ctx, 'That reminder has already been posted, so there is nothing left to cancel.');
    return;
  }

  await store.remove(ctx.guildId, reminder.id, ctx.userId);
  await retire(ctx, reminder.id);

  await reply(ctx, 'Cancelled — I will not post that one.');
}

function remindersBuilder(): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('See and cancel the reminders you have waiting.')
    .setContexts(InteractionContextType.Guild);

  builder.addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the reminders you have waiting in this server.'),
  );

  builder.addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel one of your reminders.')
      .addStringOption((option) =>
        option
          .setName('reminder')
          .setDescription('Which one. Start typing and pick it from the list.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(64),
      ),
  );

  return builder;
}

export function remindersCommand(deps: RemindersDeps): Command {
  return {
    name: 'reminders',
    description: 'See and cancel the reminders you have waiting.',

    data: remindersBuilder().toJSON(),

    async handler(ctx) {
      const store = await ready(ctx, deps, 'your reminders could not be reached');
      if (!store) return;

      switch (ctx.options.getSubcommand()) {
        case 'list':
          return list(ctx, store);
        case 'cancel':
          return cancel(ctx, store);
        default:
          await reply(ctx, 'That subcommand is not one I know.');
      }
    },
  };
}

export function remindersCommands(deps: RemindersDeps): Command[] {
  return [remindCommand(deps), remindersCommand(deps)];
}
