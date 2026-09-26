import { type CommandDefinition, errorStatus, labelOf, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { VerificationConfig } from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { runVerify } from './gate.ts';
import { acknowledge, REASON_MAX } from './perform.ts';
import { runQuarantine, runRelease } from './quarantine.ts';

type Command = CommandDefinition<VerificationConfig>;

export function verifyCommand(deps: VerificationDeps): Command {
  return {
    name: 'verify',
    description: 'Verify yourself and get access to this server.',

    data: new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify yourself and get access to this server.')
      .setContexts(InteractionContextType.Guild)
      .toJSON(),

    async handler(ctx) {
      await runVerify(ctx, deps, await acknowledge(ctx, deps));
    },
  };
}

export function quarantineCommand(deps: VerificationDeps): Command {
  return {
    name: 'quarantine',
    description: 'Quarantine a member, or release them.',

    data: new SlashCommandBuilder()
      .setName('quarantine')
      .setDescription('Quarantine a member, or release them.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription(
            'Replace a member’s roles with the quarantine role, saving the ones they had.',
          )
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to quarantine.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('reason')
              .setDescription(
                'Written to the Discord audit log, the case and the quarantine record.',
              )
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Release a member from quarantine and give back the roles they had.')
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
      const answer = await acknowledge(ctx, deps);

      const sub = ctx.options.getSubcommand();
      if (sub !== 'add' && sub !== 'remove') {
        await answer(
          errorStatus(
            `Use ${labelOf(ctx, 'quarantine', 'add')} to quarantine a member, or ` +
              `${labelOf(ctx, 'quarantine', 'remove')} to release them.`,
          ),
        );
        return;
      }

      const targetId = ctx.options.getUserId('user');
      if (!targetId) {
        await answer(
          errorStatus(
            sub === 'add'
              ? 'Choose the member to quarantine.'
              : 'Choose the member to release from quarantine.',
          ),
        );
        return;
      }

      const input = { targetId, reason: ctx.options.getString('reason') ?? undefined };

      await (sub === 'add'
        ? runQuarantine(ctx, deps, input, answer)
        : runRelease(ctx, deps, input, answer));
    },
  };
}

export function verificationCommands(deps: VerificationDeps): Command[] {
  return [verifyCommand(deps), quarantineCommand(deps)];
}
