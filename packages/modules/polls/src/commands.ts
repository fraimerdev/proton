import {
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  checkLimit,
  type EntitlementTier,
  errorStatus,
  labelOf,
  type ModuleContext,
  POLL_MAX_ANSWERS,
  POLL_MAX_DURATION_HOURS,
  POLL_MAX_QUESTION_LENGTH,
  successStatus,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { ANNOUNCE_JOB, closePoll } from './announce.ts';
import { ANSWER_SEPARATOR, closesAt, composePoll, POLL_MIN_ANSWERS } from './compose.ts';
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
  'I can’t run polls right now. Nothing was changed. This is a fault on my side, not a setting ' +
  'in this server.';

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

export function renderRunning(
  records: readonly PollRecord[],
  guildId: string,
  labels: Pick<ModuleContext, 'commandLabel'> = {},
): string {
  if (records.length === 0) {
    return (
      'No polls are running in this server right now. ' +
      `Start one with \`${labelOf(labels, 'poll', 'create')}\`.`
    );
  }

  const shown = records.slice(0, POLL_LIST_MAX);

  const lines = shown.map(
    (record) =>
      `• “${preview(record.question)}” · closes <t:${unixSeconds(record.endsAt)}:R> · ` +
      `${pollLink(guildId, record.channelId, record.messageId)} · \`${record.messageId}\``,
  );

  const more = records.length > shown.length ? `\n…and ${records.length - shown.length} more.` : '';

  return `**Running polls (${records.length})**\n${lines.join('\n')}${more}`;
}

function pollBuilder(): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Post and manage Discord polls.')
    .setContexts(InteractionContextType.Guild);

  builder.addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Post a poll in this channel.')
      .addStringOption((option) =>
        option
          .setName('question')
          .setDescription('The question to ask.')
          .setRequired(true)
          .setMaxLength(POLL_MAX_QUESTION_LENGTH),
      )
      .addStringOption((option) =>
        option
          .setName('answers')
          .setDescription(
            `${POLL_MIN_ANSWERS} to ${POLL_MAX_ANSWERS} answers, separated by ${ANSWER_SEPARATOR}.`,
          )
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('duration_hours')
          .setDescription('How many hours it stays open. Defaults to this server’s setting.')
          .setMinValue(POLL_MIN_DURATION_HOURS)
          .setMaxValue(POLL_MAX_DURATION_HOURS),
      )
      .addBooleanOption((option) =>
        option
          .setName('multiple')
          .setDescription('Let members pick more than one answer. Off by default.'),
      ),
  );

  builder.addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('Close one of Proton’s polls early.')
      .addStringOption((option) =>
        option
          .setName('message_id')
          .setDescription('The poll’s message ID, from /poll list.')
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
    await answer(ctx, applicationId, errorStatus(`Didn’t post that poll. ${composed.humanReason}`));
    return;
  }

  const tier: EntitlementTier = ctx.tier ?? 'free';
  const limit = checkLimit(tier, 'activePolls', await store.countRunning(ctx.guildId, new Date()));
  if (!limit.ok) {
    await answer(
      ctx,
      applicationId,
      errorStatus(
        `Didn’t post that poll. ${limit.humanReason} ` +
          `Close one early with \`${labelOf(ctx, 'poll', 'end')}\`.`,
      ),
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
      errorStatus(
        'That poll was already posted, so I didn’t post it again. See what’s running with ' +
          `\`${labelOf(ctx, 'poll', 'list')}\`.`,
      ),
    );
    return;
  }

  if (result.status !== 'executed') {
    await answer(ctx, applicationId, errorStatus(`Couldn’t post that poll: ${reasonOf(result)}`));
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
      successStatus(
        'Your poll is up, but Discord didn’t tell me which message it is. It still closes on ' +
          'time, but I can’t end it early or announce the result.',
      ),
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
    successStatus(
      `Your poll is up in <#${ctx.channelId}> and closes <t:${unixSeconds(endsAt)}:R>.\n` +
        `${pollLink(ctx.guildId, ctx.channelId, messageId)}\n` +
        `To close it sooner: \`${labelOf(ctx, 'poll', 'end')} message_id:${messageId}\`.${note}`,
    ),
  );
}

function notBooked(ctx: Ctx): string {
  return (
    '\n\nI couldn’t schedule its closing, so its result won’t be announced and it keeps ' +
    'counting towards this server’s running-poll limit until someone runs ' +
    `\`${labelOf(ctx, 'poll', 'end')}\` on it. The poll itself is fine.`
  );
}

async function bookClosing(ctx: Ctx, messageId: string, endsAt: Date): Promise<string> {
  if (!ctx.schedule) {
    ctx.logger.error(
      'polls has no durable scheduler in this deployment, so no poll will ever be closed out or ' +
        'announced. The process running modules must build its module contexts with a ' +
        '`schedule`/`cancel` pair.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, messageId },
    );

    return notBooked(ctx);
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

  return notBooked(ctx);
}

async function end(ctx: Ctx, store: PollStore, applicationId: string): Promise<void> {
  const messageId = (ctx.options.getString('message_id') ?? '').trim();

  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    await answer(
      ctx,
      applicationId,
      errorStatus(
        `\`${messageId}\` isn’t a message ID. Message IDs are 17 to 20 digits. Take one from ` +
          `\`${labelOf(ctx, 'poll', 'list')}\`, or turn on Developer Mode in Discord and use ` +
          'Copy Message ID.',
      ),
    );
    return;
  }

  const stored = await store.get(ctx.guildId, messageId);
  if (!stored) {
    await answer(
      ctx,
      applicationId,
      errorStatus(
        `Couldn’t find a poll with the ID \`${messageId}\` in this server’s records. Discord ` +
          'only lets an app close a poll it sent itself, so ' +
          `\`${labelOf(ctx, 'poll', 'end')}\` only works on polls started with ` +
          `\`${labelOf(ctx, 'poll', 'create')}\`. \`${labelOf(ctx, 'poll', 'list')}\` shows ` +
          'the ones I can close.',
      ),
    );
    return;
  }

  if (stored.endedAt) {
    await answer(
      ctx,
      applicationId,
      errorStatus(`That poll already closed <t:${unixSeconds(stored.endedAt)}:R>.`),
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
      successStatus(
        `That poll already ended <t:${unixSeconds(stored.endsAt)}:R>. I’ve marked it closed` +
          `${closed === 'announced' ? ' and posted the result' : ''}, so it no longer counts ` +
          'towards this server’s running-poll limit.',
      ),
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
      successStatus(
        `That poll’s message (\`${messageId}\`) was deleted from <#${stored.channelId}>, so ` +
          'there was nothing to close. I’ve marked it closed, so it no longer counts towards ' +
          'this server’s running-poll limit.',
      ),
    );
    return;
  }

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    await answer(
      ctx,
      applicationId,
      errorStatus(
        `Couldn’t close that poll: ${reasonOf(result)} It’s still running in ` +
          `<#${stored.channelId}> and still counts towards this server’s running-poll limit. Fix ` +
          `that and run \`${labelOf(ctx, 'poll', 'end')} message_id:${messageId}\` again, or ` +
          `leave it to close itself <t:${unixSeconds(stored.endsAt)}:R>.`,
      ),
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
    successStatus(
      outcome === 'announced'
        ? `Closed “${preview(stored.question)}” and posted the result.`
        : `Closed “${preview(stored.question)}”.`,
    ),
  );
}

async function list(ctx: Ctx, store: PollStore): Promise<void> {
  await replyNow(ctx, renderRunning(await store.listRunning(ctx.guildId), ctx.guildId, ctx));
}

export function pollCommand(deps: PollsDeps): Command {
  return {
    name: 'poll',
    description: 'Post and manage Discord polls.',

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
          await replyNow(ctx, errorStatus(NOT_WIRED));
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
        await replyNow(ctx, errorStatus(NOT_WIRED));
        return;
      }

      await acknowledge(ctx);

      switch (subcommand) {
        case 'create':
          return create(ctx, bound.store, bound.applicationId);
        case 'end':
          return end(ctx, bound.store, bound.applicationId);
        default:
          await answer(ctx, bound.applicationId, errorStatus('I don’t recognise that subcommand.'));
      }
    },
  };
}

export function pollsCommands(deps: PollsDeps): Command[] {
  return [pollCommand(deps)];
}
