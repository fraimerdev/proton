import { type CommandDefinition, errorStatus, Permissions, successStatus } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { CountersConfig } from './config.ts';
import type { CountersDeps } from './deps.ts';
import { reply } from './perform.ts';
import { refreshCounters } from './refresh.ts';
import { NO_COUNTERS, refreshSucceeded, renderReport } from './render.ts';

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
      const subcommand = ctx.options.getSubcommand();

      if (subcommand !== 'refresh') {
        await reply(
          ctx,
          errorStatus(
            `I don’t know a \`/counters ${subcommand}\` subcommand. The only one is \`/counters refresh\`.`,
          ),
        );
        return;
      }

      if (ctx.config.counters.length === 0) {
        await reply(ctx, errorStatus(NO_COUNTERS));
        return;
      }

      const result = await refreshCounters(ctx, deps, ctx.idempotencyKey);

      if (!result.ok) {
        await reply(ctx, errorStatus(result.humanReason));
        return;
      }

      const report = renderReport(result.outcome);

      await reply(
        ctx,
        refreshSucceeded(result.outcome) ? successStatus(report) : errorStatus(report),
      );
    },
  };
}

export function countersCommands(deps: CountersDeps): Command[] {
  return [countersCommand(deps)];
}
