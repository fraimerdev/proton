import {
  type ActionRequest,
  type AllowedMentions,
  type CommandContext,
  deferEphemeral,
  followUp,
  type RespondTo,
  replyEphemeral,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import type { SlashCommandSubcommandGroupBuilder } from 'discord.js';
import {
  type LevelingConfig,
  XP_EVENT_MAX_DURATION_MS,
  XP_EVENT_MAX_LEAD_MS,
  XP_EVENT_MAX_PENDING,
  XP_EVENT_MIN_DURATION_MS,
  XP_EVENT_MULTIPLIER_MAX,
  XP_EVENT_MULTIPLIER_MIN,
  xpEventBoundsIssue,
  xpEventMultiplierSchema,
} from './config.ts';
import { bindXpEvents, clockOf, describeUnbound, type LevelingDeps } from './deps.ts';
import { MODULE_ID } from './perform.ts';
import { createXpEvent, type XpEvent, type XpEventStore, xpEventStatus } from './xp-events.ts';

type Ctx = CommandContext<LevelingConfig>;

export const XP_EVENT_GROUP = 'event';

const MENTIONS_OFF: AllowedMentions = { parse: [] };

const NOT_WIRED =
  "I can't run XP events right now. Nothing was changed. This is a fault on my side, not a " +
  'setting in this server.';

const STORE_FAILED =
  "Something went wrong reading or saving this server's XP events. Run /xp event list to see " +
  'where things stand, then try again.';

const CANCEL_ON_DASHBOARD = 'cancel it on the Leveling page of the Proton dashboard';

export function xpEventId(interactionId: string): string {
  return `command:${interactionId}`;
}

export function addXpEventGroup(
  group: SlashCommandSubcommandGroupBuilder,
): SlashCommandSubcommandGroupBuilder {
  return group
    .setName(XP_EVENT_GROUP)
    .setDescription('Run a server-wide XP multiplier for a while.')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start or schedule an XP event.')
        .addNumberOption((option) =>
          option
            .setName('multiplier')
            .setDescription(
              'How much XP counts for, from 0.1 to 5 in steps of 0.1 — for example 2.',
            )
            .setRequired(true)
            .setMinValue(XP_EVENT_MULTIPLIER_MIN)
            .setMaxValue(XP_EVENT_MULTIPLIER_MAX),
        )
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('How long it runs, from 10m to 14d — for example 2h.')
            .setRequired(true)
            .setMaxLength(16),
        )
        .addStringOption((option) =>
          option
            .setName('starts_in')
            .setDescription(
              'How long to wait before it starts, up to 30d. Leave empty to start now.',
            )
            .setMaxLength(16),
        ),
    )
    .addSubcommand((sub) => sub.setName('end').setDescription('End every XP event running now.'))
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List the active and scheduled XP events.'),
    );
}

function respondTo(ctx: Ctx): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: { id: ctx.interaction.id, token: ctx.interaction.token },
    idempotencyKey: ctx.idempotencyKey,
  };
}

async function run(ctx: Ctx, request: ActionRequest): Promise<void> {
  const result = await ctx.executor.execute(request);
  if (result.status !== 'failed_precheck' && result.status !== 'failed_api') return;

  ctx.logger.warn(
    `leveling could not answer /xp event: ${result.failure?.humanReason ?? 'unknown reason'}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
  );
}

function unix(at: number): number {
  return Math.floor(at / 1000);
}

function times(value: number): string {
  return `${Number(value.toFixed(1))}×`;
}

function plain(text: string): string {
  return text.replaceAll('`', '').slice(0, 16);
}

function describeCreated(event: XpEvent, now: number): string {
  const end = unix(event.endsAt);
  const rule =
    'While it runs, members earn the highest multiplier that applies to them — a 0× role or ' +
    'channel still earns nothing.';

  if (xpEventStatus(event, now) === 'scheduled') {
    const start = unix(event.startsAt);
    return (
      `XP event scheduled: **${times(event.multiplier)}** XP from <t:${start}:f> ` +
      `(<t:${start}:R>) until <t:${end}:f>. ${rule}`
    );
  }

  return `XP event started: **${times(event.multiplier)}** XP until <t:${end}:f> (<t:${end}:R>). ${rule}`;
}

async function start(ctx: Ctx, store: XpEventStore, now: number): Promise<string> {
  const multiplier = ctx.options.getNumber('multiplier');
  const durationText = ctx.options.getString('duration');
  const leadText = ctx.options.getString('starts_in');

  if (multiplier === null || durationText === null) {
    return 'I need a multiplier and a duration, for example `/xp event start multiplier:2 duration:2h`.';
  }

  const parsed = xpEventMultiplierSchema.safeParse(multiplier);
  if (!parsed.success) {
    return (
      `The multiplier must be between ${XP_EVENT_MULTIPLIER_MIN} and ${XP_EVENT_MULTIPLIER_MAX} ` +
      `in steps of 0.1, like 1.5 or 2 — ${multiplier} is not. Nothing was started.`
    );
  }

  const duration = tryParseDuration(durationText);
  if (
    duration === null ||
    duration < XP_EVENT_MIN_DURATION_MS ||
    duration > XP_EVENT_MAX_DURATION_MS
  ) {
    return (
      `\`${plain(durationText)}\` is not a duration an XP event can run for. It must be between ` +
      '10m and 14d — a number followed by m, h or d, for example 30m, 2h or 3d. Nothing was started.'
    );
  }

  const lead = leadText === null ? 0 : tryParseDuration(leadText);
  if (lead === null || lead > XP_EVENT_MAX_LEAD_MS) {
    return (
      `\`${plain(leadText ?? '')}\` is not a wait an XP event can have. starts_in must be at most ` +
      '30d — a number followed by m, h or d, for example 45m or 2d. Nothing was started.'
    );
  }

  const startsAt = now + lead;
  const endsAt = startsAt + duration;

  const issue = xpEventBoundsIssue({ startsAt, endsAt }, now);
  if (issue) return `That XP event cannot be started: its ${issue.path} ${issue.message}.`;

  const result = await createXpEvent(
    store,
    {
      guildId: ctx.guildId,
      id: xpEventId(ctx.interaction.id),
      multiplier: Math.round(parsed.data * 10) / 10,
      startsAt,
      endsAt,
      createdBy: ctx.userId,
      now,
      maxPending: XP_EVENT_MAX_PENDING,
    },
    (error) =>
      ctx.logger.warn(
        `leveling started an XP event but could not clear out events that ended over a week ago: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      ),
  );

  if (result.status === 'full') {
    return (
      `This server already has ${result.pending} XP events active or scheduled, and ` +
      `${XP_EVENT_MAX_PENDING} is the most it can have. End the running ones with /xp event end, ` +
      `${CANCEL_ON_DASHBOARD} for a scheduled one, or wait for one to finish. Nothing was started.`
    );
  }

  if (result.status === 'created') {
    ctx.logger.info(`/xp event start ${times(result.event.multiplier)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      actorId: ctx.userId,
      eventId: result.event.id,
      startsAt: result.event.startsAt,
      endsAt: result.event.endsAt,
    });
  }

  return describeCreated(result.event, now);
}

async function end(ctx: Ctx, store: XpEventStore, now: number): Promise<string> {
  const pending = await store.pending(ctx.guildId, now);
  const active = pending.filter((event) => xpEventStatus(event, now) === 'active');
  const scheduled = pending.length - active.length;

  let ended = 0;
  for (const event of active) {
    if ((await store.end(ctx.guildId, event.id, now)) === 'ended') ended++;
  }

  const still =
    scheduled === 0
      ? ''
      : ` ${scheduled} scheduled XP event${scheduled === 1 ? ' is' : 's are'} untouched and will ` +
        `still start — ${CANCEL_ON_DASHBOARD} to stop one.`;

  if (ended === 0) return `No XP event is running right now, so there was nothing to end.${still}`;

  ctx.logger.info(`/xp event end ended ${ended} event(s)`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
  });

  return `Ended ${ended} XP event${ended === 1 ? '' : 's'}.${still}`;
}

async function list(ctx: Ctx, store: XpEventStore, now: number): Promise<string> {
  const pending = await store.pending(ctx.guildId, now);
  if (pending.length === 0) {
    return 'There are no active or scheduled XP events. Start one with /xp event start.';
  }

  const lines = pending.map((event) => {
    const by = snowflakeSchema.safeParse(event.createdBy).success
      ? ` — by <@${event.createdBy}>`
      : '';

    return xpEventStatus(event, now) === 'active'
      ? `**Active** · ${times(event.multiplier)} XP, ends <t:${unix(event.endsAt)}:R>${by}`
      : `**Scheduled** · ${times(event.multiplier)} XP, starts <t:${unix(event.startsAt)}:R> and ` +
          `runs until <t:${unix(event.endsAt)}:f>${by}`;
  });

  return [`**XP events** (${pending.length} of ${XP_EVENT_MAX_PENDING})`, ...lines].join('\n');
}

export async function runXpEventCommand(ctx: Ctx, deps: LevelingDeps): Promise<void> {
  const bound = bindXpEvents(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('XP events', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await run(
      ctx,
      replyEphemeral(respondTo(ctx), { content: NOT_WIRED, allowedMentions: MENTIONS_OFF }),
    );
    return;
  }

  await run(ctx, deferEphemeral(respondTo(ctx)));

  const say = (content: string) =>
    run(
      ctx,
      followUp(
        { ...respondTo(ctx), applicationId: bound.applicationId },
        { content, allowedMentions: MENTIONS_OFF },
      ),
    );

  const now = clockOf(deps)();

  let answer: string;
  try {
    switch (ctx.options.getSubcommand()) {
      case 'start':
        answer = await start(ctx, bound.xpEvents, now);
        break;
      case 'end':
        answer = await end(ctx, bound.xpEvents, now);
        break;
      case 'list':
        answer = await list(ctx, bound.xpEvents, now);
        break;
      default:
        answer = 'Use /xp event start, /xp event end or /xp event list.';
    }
  } catch (error) {
    ctx.logger.error(
      `/xp event ${ctx.options.getSubcommand() ?? ''} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: ctx.userId },
    );
    answer = STORE_FAILED;
  }

  await say(answer);
}
