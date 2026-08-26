import { type CommandDefinition, MESSAGE_FLAG_IS_COMPONENTS_V2 } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { type HelpConfig, MODULE_ID } from './config.ts';
import { dashboardLink, type HelpDeps, NO_DASHBOARD_URL } from './deps.ts';
import { buildHelpComponents } from './overview.ts';

export const HELP_DESCRIPTION = 'What Proton does, and where to configure it.';

export function helpCommand(deps: HelpDeps = {}): CommandDefinition<HelpConfig> {
  return {
    name: MODULE_ID,
    description: HELP_DESCRIPTION,

    data: new SlashCommandBuilder()
      .setName(MODULE_ID)
      .setDescription(HELP_DESCRIPTION)
      .setContexts(InteractionContextType.Guild)
      .toJSON(),

    async handler(ctx) {
      if (!ctx.config.enabled) return;

      const link = dashboardLink(deps, ctx.guildId);
      if (!link) ctx.logger.warn(NO_DASHBOARD_URL, { guildId: ctx.guildId, moduleId: MODULE_ID });

      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'interaction_reply',
        actorId: ctx.userId,

        idempotencyKey: ctx.idempotencyKey,
        dryRun: false,
        payload: {
          interactionId: ctx.interaction.id,
          interactionToken: ctx.interaction.token,
          components: buildHelpComponents(link),
          flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
          ephemeral: ctx.config.ephemeral,
        },
      });

      if (result.status === 'failed_precheck' || result.status === 'failed_api') {
        ctx.logger.warn(`/help failed: ${result.failure?.humanReason ?? 'unknown reason'}`, {
          guildId: ctx.guildId,
          code: result.failure?.code,
        });
      }
    },
  };
}
