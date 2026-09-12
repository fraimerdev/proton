import { type CommandDefinition, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { VerificationConfig } from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { runVerify } from './gate.ts';
import { REASON_MAX, reply } from './perform.ts';
import { runQuarantine, runRelease } from './quarantine.ts';

type Command = CommandDefinition<VerificationConfig>;

export function verifyCommand(deps: VerificationDeps): Command {
  return {
    name: 'verify',
    description: 'Pass this server’s verification and get access.',

    data: new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Pass this server’s verification and get access.')
      .setContexts(InteractionContextType.Guild)
      .toJSON(),

    async handler(ctx) {
      await runVerify(ctx, deps);
    },
  };
}

export function quarantineCommand(deps: VerificationDeps): Command {
  return {
    name: 'quarantine',
    description: 'Quarantine a member, or lift a quarantine.',

    data: new SlashCommandBuilder()
      .setName('quarantine')
      .setDescription('Quarantine a member, or lift a quarantine.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Swap a member’s roles for the quarantine role, recording what they had.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to quarantine.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('reason')
              .setDescription('Written to the Discord audit log, to the case and to the record.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Lift a quarantine and put the member’s roles back exactly.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to release.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('reason')
              .setDescription('Written to the Discord audit log and to the case.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .toJSON(),

    async handler(ctx) {
      const sub = ctx.options.getSubcommand();
      if (sub !== 'add' && sub !== 'remove') {
        await reply(
          ctx,
          'Use /quarantine add to quarantine somebody, or /quarantine remove to release them.',
        );
        return;
      }

      const targetId = ctx.options.getUserId('user');
      if (!targetId) {
        await reply(
          ctx,
          sub === 'add' ? 'I need a member to quarantine.' : 'I need a member to release.',
        );
        return;
      }

      const input = { targetId, reason: ctx.options.getString('reason') ?? undefined };

      await (sub === 'add' ? runQuarantine(ctx, deps, input) : runRelease(ctx, deps, input));
    },
  };
}

export function verificationCommands(deps: VerificationDeps): Command[] {
  return [verifyCommand(deps), quarantineCommand(deps)];
}
