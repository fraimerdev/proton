import {
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  deferEphemeral,
  errorStatus,
  followUp,
  formatDuration,
  type InteractionMessage,
  labelOf,
  Permissions,
  parseDuration,
  type RespondTo,
  replyEphemeral,
  type StatusBody,
  successStatus,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { announce, MODULE_ID } from './breaker.ts';
import { CLASS_LABELS, NUKE_CLASSES, thresholdFor } from './classes.ts';
import type { AntinukeConfig } from './config.ts';
import type { AntinukeDeps } from './deps.ts';
import {
  discordTime,
  hasLapsed,
  isMaintenanceRefusal,
  type MaintenanceStore,
  planMaintenance,
  startedBy,
} from './maintenance.ts';

const REASON_MAX = 512;

const NO_STORE =
  'Maintenance mode is unavailable because Proton has nowhere to store it right now, so ' +
  'Anti-Nuke stays armed.';

const DISABLED =
  "Anti-Nuke is off in this server, so there's nothing to pause. Turn it on in the Proton " +
  'dashboard first.';

type Ctx = CommandContext<AntinukeConfig>;

type Answer = (message: string | StatusBody) => Promise<void>;

export function createAntinukeCommands(deps: AntinukeDeps): CommandDefinition<AntinukeConfig>[] {
  return [
    {
      name: 'antinuke',
      description: "Check Anti-Nuke's status, or pause it while you make bulk changes.",

      data: new SlashCommandBuilder()
        .setName('antinuke')
        .setDescription("Check Anti-Nuke's status, or pause it while you make bulk changes.")
        .setContexts(InteractionContextType.Guild)

        .setDefaultMemberPermissions(Permissions.ManageGuild)
        .addSubcommand((sub) =>
          sub.setName('status').setDescription('Show whether Anti-Nuke is armed, and its limits.'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('maintenance')
            .setDescription('Pause Anti-Nuke for a set time while you make bulk changes.')
            .addStringOption((option) =>
              option
                .setName('duration')
                .setDescription('How long to pause it for, like 20m.')
                .setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName('reason')
                .setDescription("What you're about to do. It's shown in the alert and the status.")
                .setMaxLength(REASON_MAX),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName('resume').setDescription('End maintenance mode now and re-arm Anti-Nuke.'),
        )
        .toJSON(),

      async handler(ctx) {
        const answer = await acknowledge(ctx);

        switch (ctx.options.getSubcommand()) {
          case 'maintenance':
            return startMaintenance(ctx, deps, answer);
          case 'resume':
            return resume(ctx, deps, answer);
          default:
            return status(ctx, deps, answer);
        }
      },
    },
  ];
}

async function startMaintenance(ctx: Ctx, deps: AntinukeDeps, answer: Answer): Promise<void> {
  const store = requireStore(deps);
  if (!store) return answer(errorStatus(NO_STORE));
  if (!ctx.config.enabled) return answer(errorStatus(DISABLED));

  const raw = ctx.options.getString('duration');
  if (!raw) return answer(errorStatus('Include a duration, like 20m.'));

  let durationMs: number;
  try {
    durationMs = parseDuration(raw);
  } catch (error) {
    return answer(
      errorStatus(error instanceof Error ? error.message : `'${raw}' isn't a duration.`),
    );
  }

  const maxMs = parseDuration(ctx.config.maintenanceMaxDuration);
  const now = deps.now?.() ?? Date.now();

  const planned = planMaintenance({
    guildId: ctx.guildId,
    enabledBy: ctx.userId,
    reason: ctx.options.getString('reason'),
    durationMs,
    maxDurationMs: maxMs,
    now,
  });

  if (isMaintenanceRefusal(planned)) return answer(errorStatus(planned.refusal));

  await store.set(planned);

  const until = discordTime(planned.expiresAt);
  const audit =
    `<@${ctx.userId}> started Anti-Nuke maintenance mode until ${until} ` +
    `(${formatDuration(durationMs)}). Anti-Nuke won't act on destructive changes until then, ` +
    `and re-arms by itself when it ends.${planned.reason ? ` Reason: ${planned.reason}` : ''}`;

  ctx.logger.warn(audit, { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: ctx.userId });
  await announce(ctx, ctx.idempotencyKey, audit, 'maintenance-on');

  await answer(
    successStatus(
      `Maintenance mode is on until ${until} (${formatDuration(durationMs)}). Anti-Nuke won't ` +
        `act until then, so run \`${labelOf(ctx, 'antinuke', 'resume')}\` as soon as you're done.`,
    ),
  );
}

async function resume(ctx: Ctx, deps: AntinukeDeps, answer: Answer): Promise<void> {
  const store = requireStore(deps);
  if (!store) return answer(errorStatus(NO_STORE));

  const window = await store.get(ctx.guildId);
  const now = deps.now?.() ?? Date.now();

  if (!window || hasLapsed(window, now)) {
    return answer(errorStatus("Maintenance mode isn't on, so Anti-Nuke is already armed."));
  }

  await store.clear(ctx.guildId);

  const audit =
    `<@${ctx.userId}> ended Anti-Nuke maintenance mode early, so Anti-Nuke is armed again. ` +
    startedBy(window);

  ctx.logger.warn(audit, { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: ctx.userId });
  await announce(ctx, ctx.idempotencyKey, audit, 'maintenance-off');

  await answer(successStatus('Maintenance mode is off. Anti-Nuke is armed again.'));
}

async function status(ctx: Ctx, deps: AntinukeDeps, answer: Answer): Promise<void> {
  const lines: string[] = [];

  if (!ctx.config.enabled) {
    lines.push('Anti-Nuke is **off** in this server, so nothing is being counted.');
  } else {
    const store = requireStore(deps);
    const window = store ? await store.get(ctx.guildId) : null;
    const now = deps.now?.() ?? Date.now();

    if (!store) {
      lines.push(NO_STORE);
    } else if (window && !hasLapsed(window, now)) {
      lines.push(
        `Anti-Nuke is **paused** for maintenance mode until ${discordTime(window.expiresAt)}. ` +
          startedBy(window),
      );
    } else {
      lines.push('Anti-Nuke is **armed**.');
    }

    for (const nukeClass of NUKE_CLASSES) {
      const threshold = thresholdFor(ctx.config, nukeClass);
      const label = CLASS_LABELS[nukeClass];
      const name = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
      lines.push(
        'error' in threshold
          ? `- ${name}: not watched. ${threshold.error}`
          : `- ${name}: ${threshold.limit} per ${threshold.window}`,
      );
    }

    lines.push(
      ctx.config.afterStrip === 'none'
        ? "When it trips, the member's roles are removed. Nothing else is done."
        : `When it trips, the member's roles are removed first, then they're ` +
            `${ctx.config.afterStrip === 'ban' ? 'banned' : 'kicked'}.`,
    );

    if (!ctx.config.alertChannelId) {
      lines.push(
        'No alert channel is set, so no one is alerted when it trips. Set one on the Anti-Nuke ' +
          'page of the Proton dashboard.',
      );
    }
  }

  await answer(lines.join('\n'));
}

function requireStore(deps: AntinukeDeps): MaintenanceStore | null {
  return deps.maintenance ?? null;
}

function warnUnanswered(ctx: Ctx, result: ActionResult): void {
  if (result.failure) {
    ctx.logger.warn(`anti-nuke could not answer the invoker: ${result.failure.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      code: result.failure.code,
    });
  }
}

function privately(message: string | StatusBody): InteractionMessage {
  return typeof message === 'string'
    ? { content: message, ephemeral: true }
    : { ...message, ephemeral: true };
}

async function acknowledge(ctx: Ctx): Promise<Answer> {
  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: ctx.interaction,
    idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}`,
  };

  const applicationId = ctx.applicationId;

  // Without an application id there is no followup webhook, so the one callback must be the answer.
  if (!applicationId) {
    return async (message) =>
      warnUnanswered(ctx, await ctx.executor.execute(replyEphemeral(to, privately(message))));
  }

  warnUnanswered(ctx, await ctx.executor.execute(deferEphemeral(to)));

  return async (message) =>
    warnUnanswered(
      ctx,
      await ctx.executor.execute(followUp({ ...to, applicationId }, privately(message))),
    );
}
