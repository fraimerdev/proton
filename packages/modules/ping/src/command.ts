import type { CommandDefinition } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import type { PingConfig } from './config.ts';

/**
 * `/ping` — the Gate 0 vertical slice.
 *
 * Note what this handler does *not* do: it never touches discord.js's client,
 * never constructs a REST call, and never writes to the database. It builds one
 * ActionRequest and hands it to the executor (I1), which is the only path to a
 * state change in the entire system.
 */
export const pingCommand: CommandDefinition<PingConfig> = {
  name: 'ping',
  description: 'Check that Proton is responding.',

  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check that Proton is responding.')
    .toJSON(),

  async handler(ctx) {
    if (!ctx.config.enabled) return;

    if (ctx.config.restrictToChannel && ctx.config.restrictToChannel !== ctx.channelId) {
      ctx.logger.info('ping ignored: wrong channel', {
        guildId: ctx.guildId,
        channelId: ctx.channelId,
      });
      return;
    }

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: 'ping',
      kind: 'interaction_reply',
      actorId: ctx.userId,
      // Reusing the event-derived key means a RESUME redelivery of this same
      // interaction is deduped rather than replied to twice (I4).
      idempotencyKey: ctx.idempotencyKey,
      dryRun: false,
      payload: {
        interactionId: ctx.interaction.id,
        interactionToken: ctx.interaction.token,
        content: ctx.config.response,
        ephemeral: false,
      },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      // Never fail silently — surface which permission is missing and where.
      ctx.logger.warn(`ping failed: ${result.failure?.humanReason ?? 'unknown reason'}`, {
        guildId: ctx.guildId,
        code: result.failure?.code,
      });
    }
  },
};
