import { type CommandDefinition, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { CountersConfig } from './config.ts';
import type { CountersDeps } from './deps.ts';
import { reply } from './perform.ts';
import { refreshCounters } from './refresh.ts';
import { NO_COUNTERS, renderReport } from './render.ts';

type Command = CommandDefinition<CountersConfig>;

export function countersCommand(deps: CountersDeps): Command {
  return {
    name: 'counters',
    description: 'Manage this server’s counter channels.',

    data: new SlashCommandBuilder()
      .setName('counters')
      .setDescription('Manage this server’s counter channels.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageChannels)
      .addSubcommand((sub) =>
        sub
          .setName('refresh')
          .setDescription('Update every counter channel now instead of waiting for the timer.'),
      )
      .toJSON(),

    async handler(ctx) {
      if (ctx.options.getSubcommand() !== 'refresh') {
        await reply(ctx, 'That subcommand is not one I know.');
        return;
      }

      if (ctx.config.counters.length === 0) {
        await reply(ctx, NO_COUNTERS);
        return;
      }

      const result = await refreshCounters(ctx, deps, ctx.idempotencyKey);

      await reply(ctx, result.ok ? renderReport(result.outcome) : result.humanReason);
    },
  };
}

export function countersCommands(deps: CountersDeps): Command[] {
  return [countersCommand(deps)];
}
