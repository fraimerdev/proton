import {
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  checkLimit,
  type EntitlementTier,
  POLL_MAX_DURATION_HOURS,
  POLL_MAX_QUESTION_LENGTH,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { ANNOUNCE_JOB, closePoll } from './announce.ts';
import { ANSWER_SEPARATOR, closesAt, composePoll } from './compose.ts';
import {
  MODULE_ID,
  POLL_MIN_DURATION_HOURS,
  type PollsConfig,
  pollLink,
  unixSeconds,
} from './config.ts';
import { bindInteractive, bindStore, describeUnbound, type PollsDeps } from './deps.ts';
import { acknowledge, answer, replyNow } from './perform.ts';
import type { PollRecord, PollStore } from './store.ts';

type Command = CommandDefinition<PollsConfig>;
type Ctx = CommandContext<PollsConfig>;

// Eight lines of question, link and id is about 1700 characters, and a reply Discord refuses at
// 2000 tells the admin nothing at all rather than a little less.
export const POLL_LIST_MAX = 8;

const QUESTION_PREVIEW_MAX = 60;

const MESSAGE_ID_PATTERN = /^\d{17,20}$/;

const MESSAGE_GONE = 'discord_404';

const NOT_WIRED =
  "I can't run polls in this server because Proton isn't fully wired up in this deployment. " +
  'Nothing was changed. The Proton logs name the exact missing piece.';

function preview(question: string): string {
  return question.length > QUESTION_PREVIEW_MAX
    ? `${question.slice(0, QUESTION_PREVIEW_MAX - 1)}…`
    : question;
}

function sentMessageId(result: ActionResult): string | null {
  const body = result.body;
  if (typeof body !== 'object' || body === null) return null;

  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function reasonOf(result: ActionResult): string {
  return result.failure?.humanReason ?? 'Discord gave no reason.';
}

export function renderRunning(records: readonly PollRecord[], guildId: string): string {
  if (records.length === 0) {
    return 'No polls are running in this server right now. `/poll create` starts one.';
  }

  const shown = records.slice(0, POLL_LIST_MAX);

  const lines = shown.map(
    (record) =>
      `• “${preview(record.question)}” — closes <t:${unixSeconds(record.endsAt)}:R> · ` +
      `${pollLink(guildId, record.channelId, record.messageId)} · \`${record.messageId}\``,
  );

  const more = records.length > shown.length ? `\n…and ${records.length - shown.length} more.` : '';

  return `**Running polls** — ${records.length}\n${lines.join('\n')}${more}`;
}

function pollBuilder(): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Run one of Discord’s own polls.')
    .setContexts(InteractionContextType.Guild);

  builder.addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Post a poll in this channel.')
      .addStringOption((option) =>
        option
          .setName('question')
          .setDescription('What the poll asks.')
          .setRequired(true)
          .setMaxLength(POLL_MAX_QUESTION_LENGTH),
      )
      .addStringOption((option) =>
        option
          .setName('answers')
          .setDescription(`The answers, separated by ${ANSWER_SEPARATOR}. Two to ten of them.`)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('duration_hours')
          .setDescription('How many hours it runs for. Defaults to this server’s setting.')
          .setMinValue(POLL_MIN_DURATION_HOURS)
          .setMaxValue(POLL_MAX_DURATION_HOURS),
      )
      .addBooleanOption((option) =>
        option
          .setName('multiple')
          .setDescription('Let each member pick more than one answer. Off by default.'),
      ),
  );

  builder.addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('Close one of Proton’s polls before its clock runs out.')
      .addStringOption((option) =>
        option
          .setName('message_id')
          .setDescription('The poll message’s id — /poll list shows it.')
          .setRequired(true)
          .setMinLength(17)
          .setMaxLength(20),
      ),
  );

  builder.addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the polls running in this server.'),
  );

  return builder;
}

async function create(ctx: Ctx, store: PollStore, applicationId: string): Promise<void> {
  const durationHours = ctx.options.getInteger('duration_hours') ?? ctx.config.defaultDurationHours;

  const composed = composePoll({
    question: ctx.options.getString('question') ?? '',
    answers: ctx.options.getString('answers') ?? '',
    durationHours,
    multiselect: ctx.options.getBoolean('multiple') ?? false,
  });

  if (!composed.ok) {
    await answer(ctx, applicationId, `I did not post that poll: ${composed.humanReason}`);
    return;
  }

  const tier: EntitlementTier = ctx.tier ?? 'free';
  const limit = checkLimit(tier, 'activePolls', await store.countRunning(ctx.guildId, new Date()));
  if (!limit.ok) {
    await answer(
      ctx,
      applicationId,
      `I did not post that poll: ${limit.humanReason} \`/poll end\` closes one early.`,
    );
    return;
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:create`,
    dryRun: false,
    record: false,
    payload: { channelId: ctx.channelId, poll: composed.poll },
  });

  if (result.status === 'skipped_duplicate') {
    await answer(
      ctx,
      applicationId,
      'That poll was already posted — this is a repeat of the same command, so I did not post ' +
        'a second one. `/poll list` shows what is running.',
    );
    return;
  }

  if (result.status !== 'executed') {
    await answer(ctx, applicationId, `I could not post that poll: ${reasonOf(result)}`);
    return;
  }

  const messageId = sentMessageId(result);
  if (!messageId) {
    ctx.logger.error(
      'Discord accepted the poll but its response carried no message id, so the poll was not ' +
        'recorded: it cannot be closed with `/poll end`, it will not be announced, and it does ' +
        'not count towards this server’s running-poll limit.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: ctx.channelId },
    );

    await answer(
      ctx,
      applicationId,
      'Your poll is up, but Discord did not tell me which message it is. It will still close ' +
        'itself on time — I just cannot end it early or announce its result.',
    );
    return;
  }

  const endsAt = closesAt(new Date(), durationHours);

  await store.create({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    messageId,
    createdBy: ctx.userId,
    question: composed.poll.question.text,
    endsAt,
    announceChannelId: ctx.config.announceChannelId ?? null,
  });

  // Booked even when announcements are off: this job is what closes the row out, and a poll left
  // open counts against the server's running-poll limit for ever.
  const note = await bookClosing(ctx, messageId, endsAt);

  await answer(
    ctx,
    applicationId,
    `Your poll is up in <#${ctx.channelId}> and closes <t:${unixSeconds(endsAt)}:R>.\n` +
      `${pollLink(ctx.guildId, ctx.channelId, messageId)}\n` +
      `To close it sooner: \`/poll end message_id:${messageId}\`.${note}`,
  );
}

const NOT_BOOKED =
  '\n\nI could not book its closing job, so nothing will announce the result and the poll will ' +
  'keep counting towards this server’s running-poll limit until someone runs `/poll end` on it. ' +
  'The poll itself is fine.';

async function bookClosing(ctx: Ctx, messageId: string, endsAt: Date): Promise<string> {
  if (!ctx.schedule) {
    ctx.logger.error(
      'polls has no durable scheduler in this deployment, so no poll will ever be closed out or ' +
        'announced. The process running modules must build its module contexts with a ' +
        '`schedule`/`cancel` pair.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, messageId },
    );

    return NOT_BOOKED;
  }

  const outcome = await ctx.schedule(
    ANNOUNCE_JOB,
    endsAt,
    messageId,
    { messageId },
    { replace: true },
  );

  if (outcome.scheduled) return '';

  ctx.logger.warn(
    `polls could not book the closing job for ${messageId}, so that poll will stay open in ` +
      'this server’s records until someone ends it by hand.',
    { guildId: ctx.guildId, moduleId: MODULE_ID, messageId },
  );

  return NOT_BOOKED;
}

async function end(ctx: Ctx, store: PollStore, applicationId: string): Promise<void> {
  const messageId = (ctx.options.getString('message_id') ?? '').trim();

  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    await answer(
      ctx,
      applicationId,
      `\`${messageId}\` is not a message id. A message id is 17 to 20 digits — turn on ` +
        'Developer Mode in Discord and use Copy Message ID, or take it from `/poll list`.',
    );
    return;
  }

  const stored = await store.get(ctx.guildId, messageId);
  if (!stored) {
    await answer(
      ctx,
      applicationId,
      `There is no poll with the id \`${messageId}\` in this server’s records, so I left it ` +
        'alone. Discord only lets an application close a poll it sent itself, so `/poll end` ' +
        'works on polls started with `/poll create` and on nothing else — a poll a member ' +
        'posted has to be closed by that member. `/poll list` shows the ones I can close.',
    );
    return;
  }

  if (stored.endedAt) {
    await answer(
      ctx,
      applicationId,
      `That poll already closed <t:${unixSeconds(stored.endedAt)}:R>.`,
    );
    return;
  }

  const now = new Date();

  if (stored.endsAt.getTime() <= now.getTime()) {
    await ctx.cancel?.(ANNOUNCE_JOB, messageId);

    const closed = await closePoll(ctx, store, stored, now);

    await answer(
      ctx,
      applicationId,
      `That poll’s clock ran out <t:${unixSeconds(stored.endsAt)}:R>, so Discord had already ` +
        'closed it and there was nothing left for me to expire. I have closed it in this ' +
        `server’s records${closed === 'announced' ? ' and posted the result' : ''}, so it no ` +
        'longer counts towards this server’s running-poll limit.',
    );
    return;
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'end_poll',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:end`,
    dryRun: false,
    record: false,
    payload: { channelId: stored.channelId, messageId },
  });

  // A poll Discord cannot find is a poll that was deleted: there is nothing left to expire, and
  // leaving the row open would hold a running-poll slot against a message nobody can even see.
  if (result.status === 'failed_api' && result.failure?.code === MESSAGE_GONE) {
    await ctx.cancel?.(ANNOUNCE_JOB, messageId);
    await store.end(ctx.guildId, messageId, now);

    await answer(
      ctx,
      applicationId,
      `Discord has no message \`${messageId}\` in <#${stored.channelId}> any more, so that poll ` +
        'was deleted and there was nothing left to close. I have closed it in this server’s ' +
        'records instead, so it no longer counts towards this server’s running-poll limit.',
    );
    return;
  }

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    await answer(
      ctx,
      applicationId,
      `I could not close that poll: ${reasonOf(result)} It is still running in ` +
        `<#${stored.channelId}> and still counts towards this server’s running-poll limit. Fix ` +
        `that and run \`/poll end message_id:${messageId}\` again, or leave it — it closes ` +
        `itself <t:${unixSeconds(stored.endsAt)}:R> and stops counting then.`,
    );
    return;
  }

  // Not guarded: a cancel that fails leaves the deadline job in place, and the announcement is
  // keyed on the poll, so the sweep that runs it later is collapsed by the executor's dedupe.
  await ctx.cancel?.(ANNOUNCE_JOB, messageId);

  const outcome = await closePoll(ctx, store, stored, now);

  await answer(
    ctx,
    applicationId,
    outcome === 'announced'
      ? `Closed “${preview(stored.question)}” and posted the result.`
      : `Closed “${preview(stored.question)}”.`,
  );
}

async function list(ctx: Ctx, store: PollStore): Promise<void> {
  await replyNow(ctx, renderRunning(await store.listRunning(ctx.guildId), ctx.guildId));
}

export function pollCommand(deps: PollsDeps): Command {
  return {
    name: 'poll',
    description: 'Run one of Discord’s own polls.',

    data: pollBuilder().toJSON(),

    async handler(ctx) {
      const subcommand = ctx.options.getSubcommand();

      if (subcommand === 'list') {
        const bound = bindStore(deps);
        if ('unbound' in bound) {
          ctx.logger.error(describeUnbound('the running polls could not be read', bound.unbound), {
            guildId: ctx.guildId,
            moduleId: MODULE_ID,
          });
          await replyNow(ctx, NOT_WIRED);
          return;
        }

        return list(ctx, bound.store);
      }

      // Bound before the interaction is deferred: a module missing a port cannot follow up, so
      // its refusal has to go out as the first response or the member sees nothing at all.
      const bound = bindInteractive(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound('a poll could not be started or closed', bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        await replyNow(ctx, NOT_WIRED);
        return;
      }

      await acknowledge(ctx);

      switch (subcommand) {
        case 'create':
          return create(ctx, bound.store, bound.applicationId);
        case 'end':
          return end(ctx, bound.store, bound.applicationId);
        default:
          await answer(ctx, bound.applicationId, 'That subcommand is not one I know.');
      }
    },
  };
}

export function pollsCommands(deps: PollsDeps): Command[] {
  return [pollCommand(deps)];
}
