import {
  type CommandContext,
  type CommandDefinition,
  formatDuration,
  Permissions,
  parseDuration,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { announce, MODULE_ID } from './breaker.ts';
import { CLASS_LABELS, NUKE_CLASSES, thresholdFor } from './classes.ts';
import type { AntinukeConfig } from './config.ts';
import type { AntinukeDeps } from './deps.ts';
import {
  hasLapsed,
  isMaintenanceRefusal,
  type MaintenanceStore,
  planMaintenance,
} from './maintenance.ts';

const REASON_MAX = 512;

const NO_STORE =
  'Maintenance mode is unavailable: Proton is running with nowhere to record a window, and a ' +
  'window nothing records is a hole nothing closes. Ask whoever runs Proton to make it ' +
  'available — until then the breaker stays armed and cannot be suspended.';

const DISABLED =
  'Anti-nuke is switched off in this server, so there is no breaker to suspend. Turn the ' +
  'Anti-nuke module on from the Proton dashboard first.';

export function createAntinukeCommands(deps: AntinukeDeps): CommandDefinition<AntinukeConfig>[] {
  return [
    {
      name: 'antinuke',
      description: 'Inspect the anti-nuke breaker, or suspend it briefly for bulk admin work.',

      data: new SlashCommandBuilder()
        .setName('antinuke')
        .setDescription('Inspect the anti-nuke breaker, or suspend it briefly for bulk admin work.')
        .setContexts(InteractionContextType.Guild)

        .setDefaultMemberPermissions(Permissions.ManageGuild)
        .addSubcommand((sub) =>
          sub
            .setName('status')
            .setDescription('Show whether the breaker is armed, and at what thresholds.'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('maintenance')
            .setDescription('Suspend the breaker for a fixed period of bulk admin work.')
            .addStringOption((option) =>
              option
                .setName('duration')
                .setDescription('How long to suspend it for, e.g. 20m. It cannot be indefinite.')
                .setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName('reason')
                .setDescription('What you are about to do. Recorded with the window.')
                .setMaxLength(REASON_MAX),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName('resume').setDescription('End maintenance mode now and re-arm the breaker.'),
        )
        .toJSON(),

      async handler(ctx) {
        switch (ctx.options.getSubcommand()) {
          case 'maintenance':
            return startMaintenance(ctx, deps);
          case 'resume':
            return resume(ctx, deps);
          default:
            return status(ctx, deps);
        }
      },
    },
  ];
}

async function startMaintenance(
  ctx: CommandContext<AntinukeConfig>,
  deps: AntinukeDeps,
): Promise<void> {
  const store = requireStore(deps);
  if (!store) return reply(ctx, NO_STORE);
  if (!ctx.config.enabled) return reply(ctx, DISABLED);

  const raw = ctx.options.getString('duration');
  if (!raw) return reply(ctx, 'I need a duration, for example 20m.');

  let durationMs: number;
  try {
    durationMs = parseDuration(raw);
  } catch (error) {
    return reply(ctx, error instanceof Error ? error.message : `'${raw}' is not a duration.`);
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

  if (isMaintenanceRefusal(planned)) return reply(ctx, planned.refusal);

  await store.set(planned);

  const until = new Date(planned.expiresAt).toISOString();
  const audit =
    `Anti-nuke maintenance mode was switched ON by ${ctx.userId} for ` +
    `${formatDuration(durationMs)}, until ${until}` +
    `${planned.reason ? `, for: ${planned.reason}` : ''}. The breaker will not act on anything ` +
    'destructive in that time, and re-arms by itself at the end — nothing extends it.';

  ctx.logger.warn(audit, { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: ctx.userId });
  await announce(ctx, ctx.idempotencyKey, audit, 'maintenance-on');

  await reply(
    ctx,
    `Maintenance mode is on until ${until} (${formatDuration(durationMs)}). Anti-nuke will not ` +
      'act until then. Run `/antinuke resume` the moment you are done — every minute of this is ' +
      'a minute the breaker is not protecting the server.',
  );
}

async function resume(ctx: CommandContext<AntinukeConfig>, deps: AntinukeDeps): Promise<void> {
  const store = requireStore(deps);
  if (!store) return reply(ctx, NO_STORE);

  const window = await store.get(ctx.guildId);
  const now = deps.now?.() ?? Date.now();

  if (!window || hasLapsed(window, now)) {
    return reply(ctx, 'Maintenance mode is not on — the breaker is already armed.');
  }

  await store.clear(ctx.guildId);

  const audit =
    `Anti-nuke maintenance mode was ended early by ${ctx.userId}; it was opened by ` +
    `${window.enabledBy} and would have run until ${new Date(window.expiresAt).toISOString()}. ` +
    'The breaker is armed again.';

  ctx.logger.warn(audit, { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: ctx.userId });
  await announce(ctx, ctx.idempotencyKey, audit, 'maintenance-off');

  await reply(ctx, 'Maintenance mode is off. The breaker is armed again.');
}

async function status(ctx: CommandContext<AntinukeConfig>, deps: AntinukeDeps): Promise<void> {
  const lines: string[] = [];

  if (!ctx.config.enabled) {
    lines.push('Anti-nuke is OFF in this server. Nothing is being counted.');
  } else {
    const store = requireStore(deps);
    const window = store ? await store.get(ctx.guildId) : null;
    const now = deps.now?.() ?? Date.now();

    if (!store) {
      lines.push(NO_STORE);
    } else if (window && !hasLapsed(window, now)) {
      lines.push(
        `Anti-nuke is SUSPENDED until ${new Date(window.expiresAt).toISOString()} — maintenance ` +
          `mode was opened by ${window.enabledBy}` +
          `${window.reason ? ` for: ${window.reason}` : ''}.`,
      );
    } else {
      lines.push('Anti-nuke is ARMED.');
    }

    for (const nukeClass of NUKE_CLASSES) {
      const threshold = thresholdFor(ctx.config, nukeClass);
      lines.push(
        'error' in threshold
          ? `- ${CLASS_LABELS[nukeClass]}: not being watched — ${threshold.error}`
          : `- ${CLASS_LABELS[nukeClass]}: ${threshold.limit} per ${threshold.window}`,
      );
    }

    lines.push(
      ctx.config.afterStrip === 'none'
        ? 'When it trips: roles are stripped and a human is told. Nothing irreversible.'
        : `When it trips: roles are stripped first, then ${ctx.config.afterStrip}.`,
    );

    if (!ctx.config.alertChannelId) {
      lines.push(
        'No alert channel is set, so the breaker can only report to the logs. Set one in the ' +
          'Proton dashboard — somebody has to be told.',
      );
    }
  }

  await reply(ctx, lines.join('\n'));
}

function requireStore(deps: AntinukeDeps): MaintenanceStore | null {
  return deps.maintenance ?? null;
}

async function reply(ctx: CommandContext<AntinukeConfig>, content: string): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}:reply`,
    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      content: content.slice(0, 2000),
      ephemeral: true,
    },
  });

  if (result.failure) {
    ctx.logger.warn(`anti-nuke could not answer the invoker: ${result.failure.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      code: result.failure.code,
    });
  }
}
