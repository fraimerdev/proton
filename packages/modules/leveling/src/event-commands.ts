import {
  type ActionRequest,
  type AllowedMentions,
  type CommandContext,
  deferEphemeral,
  errorStatus,
  followUp,
  labelOf,
  type RespondTo,
  replyEphemeral,
  type StatusBody,
  snowflakeSchema,
  successStatus,
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

function storeFailed(ctx: Ctx): string {
  return (
    "Couldn't read or save this server's XP events. Run " +
    `${labelOf(ctx, 'xp', 'event.list')} to see where things stand, then try again.`
  );
}

const DASHBOARD_PAGE = 'the Leveling page of the Proton dashboard';

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
            .setDescription('From 0.1 to 5, in steps of 0.1. For example, 2 for double XP.')
            .setRequired(true)
            .setMinValue(XP_EVENT_MULTIPLIER_MIN)
            .setMaxValue(XP_EVENT_MULTIPLIER_MAX),
        )
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('How long it runs, from 10m to 14d. For example, 2h.')
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
      sub.setName('list').setDescription('List the running and scheduled XP events.'),
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
    'While it runs, members get the highest multiplier that applies to them. A 0× role or ' +
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

async function start(ctx: Ctx, store: XpEventStore, now: number): Promise<StatusBody> {
  const multiplier = ctx.options.getNumber('multiplier');
  const durationText = ctx.options.getString('duration');
  const leadText = ctx.options.getString('starts_in');

  if (multiplier === null || durationText === null) {
    return errorStatus(
      'I need a multiplier and a duration, for example ' +
        `\`${labelOf(ctx, 'xp', 'event.start')} multiplier:2 duration:2h\`.`,
    );
  }

  const parsed = xpEventMultiplierSchema.safeParse(multiplier);
  if (!parsed.success) {
    return errorStatus(
      `${multiplier} isn't a valid multiplier. Use a number from ${XP_EVENT_MULTIPLIER_MIN} to ` +
        `${XP_EVENT_MULTIPLIER_MAX} in steps of 0.1, like 1.5 or 2. Nothing was started.`,
    );
  }

  const duration = tryParseDuration(durationText);
  if (
    duration === null ||
    duration < XP_EVENT_MIN_DURATION_MS ||
    duration > XP_EVENT_MAX_DURATION_MS
  ) {
    return errorStatus(
      `\`${plain(durationText)}\` isn't a valid duration. Use 10m to 14d: a number followed by ` +
        'm, h or d, like 30m, 2h or 3d. Nothing was started.',
    );
  }

  const lead = leadText === null ? 0 : tryParseDuration(leadText);
  if (lead === null || lead > XP_EVENT_MAX_LEAD_MS) {
    return errorStatus(
      `\`${plain(leadText ?? '')}\` isn't a valid wait for starts_in. Use up to 30d: a number ` +
        'followed by m, h or d, like 45m or 2d. Nothing was started.',
    );
  }

  const startsAt = now + lead;
  const endsAt = startsAt + duration;

  const issue = xpEventBoundsIssue({ startsAt, endsAt }, now);
  if (issue) {
    const part = issue.path === 'startsAt' ? 'start' : 'end';
    return errorStatus(`Couldn't start that XP event: the ${part} ${issue.message}.`);
  }

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
    return errorStatus(
      `This server already has ${result.pending} XP events running or scheduled, and ` +
        `${XP_EVENT_MAX_PENDING} is the most it can have. End running ones with ` +
        `${labelOf(ctx, 'xp', 'event.end')}, cancel a scheduled one on ${DASHBOARD_PAGE}, or ` +
        'wait for one to finish. Nothing was started.',
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

  return successStatus(describeCreated(result.event, now));
}

async function end(ctx: Ctx, store: XpEventStore, now: number): Promise<StatusBody> {
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
      : scheduled === 1
        ? ` 1 scheduled XP event will still start. To stop it, cancel it on ${DASHBOARD_PAGE}.`
        : ` ${scheduled} scheduled XP events will still start. To stop one, cancel it on ` +
          `${DASHBOARD_PAGE}.`;

  if (ended === 0) {
    return errorStatus(`No XP event is running, so there was nothing to end.${still}`);
  }

  ctx.logger.info(`/xp event end ended ${ended} event(s)`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
  });

  return successStatus(`Ended ${ended} XP event${ended === 1 ? '' : 's'}.${still}`);
}

async function list(ctx: Ctx, store: XpEventStore, now: number): Promise<string> {
  const pending = await store.pending(ctx.guildId, now);
  if (pending.length === 0) {
    return (
      'No XP events are running or scheduled. Start one with ' +
      `${labelOf(ctx, 'xp', 'event.start')}.`
    );
  }

  const lines = pending.map((event) => {
    const running = xpEventStatus(event, now) === 'active';
    const by = snowflakeSchema.safeParse(event.createdBy).success
      ? ` · ${running ? 'started' : 'scheduled'} by <@${event.createdBy}>`
      : '';

    return running
      ? `**Running** · ${times(event.multiplier)} XP, ends <t:${unix(event.endsAt)}:R>${by}`
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
      replyEphemeral(respondTo(ctx), { ...errorStatus(NOT_WIRED), allowedMentions: MENTIONS_OFF }),
    );
    return;
  }

  await run(ctx, deferEphemeral(respondTo(ctx)));

  const say = (message: string | StatusBody) =>
    run(
      ctx,
      followUp(
        { ...respondTo(ctx), applicationId: bound.applicationId },
        {
          ...(typeof message === 'string' ? { content: message } : message),
          allowedMentions: MENTIONS_OFF,
          ephemeral: true,
        },
      ),
    );

  const now = clockOf(deps)();

  let answer: string | StatusBody;
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
        answer = errorStatus(
          `Use ${labelOf(ctx, 'xp', 'event.start')}, ${labelOf(ctx, 'xp', 'event.end')} or ` +
            `${labelOf(ctx, 'xp', 'event.list')}.`,
        );
    }
  } catch (error) {
    ctx.logger.error(
      `/xp event ${ctx.options.getSubcommand() ?? ''} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: ctx.userId },
    );
    answer = errorStatus(storeFailed(ctx));
  }

  await say(answer);
}
