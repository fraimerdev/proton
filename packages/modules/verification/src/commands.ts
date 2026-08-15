import { type CommandDefinition, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { VerificationConfig } from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { runVerify } from './gate.ts';
import { REASON_MAX, reply } from './perform.ts';
import { runQuarantine, runRelease } from './quarantine.ts';

type Command = CommandDefinition<VerificationConfig>;

/**
 * `/verify` — the one command in Proton every member may run.
 *
 * No `default_member_permissions`, deliberately. It is the gate: restricting it
 * to a Discord permission would restrict it to people already past the gate.
 *
 * What it is *not* is a challenge. Passing means running the command, which is a
 * rules-acceptance gate — the same thing Discord's own membership screening is —
 * and it stops a script that joins and immediately posts, which is the traffic
 * this catches. A captcha or a modal challenge needs Components V2 flows (§10.6)
 * and is not built here; nothing in the wording below claims otherwise, because
 * a gate that oversells itself is worse than one that doesn't exist.
 */
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

/**
 * MANAGE_ROLES rather than a moderation permission, because that is the
 * permission the operation actually is: a role swap. Presentation only — the
 * executor still runs every I8 precheck, since Discord's own gate can be
 * overridden per guild.
 */
export function quarantineCommand(deps: VerificationDeps): Command {
  return {
    name: 'quarantine',
    description: 'Swap a member’s roles for the quarantine role, recording what they had.',

    data: new SlashCommandBuilder()
      .setName('quarantine')
      .setDescription('Swap a member’s roles for the quarantine role, recording what they had.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles)
      .addUserOption((option) =>
        option.setName('user').setDescription('The member to quarantine.').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Written to the Discord audit log, to the case and to the record.')
          .setMaxLength(REASON_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      const targetId = ctx.options.getUserId('user');
      if (!targetId) {
        await reply(ctx, 'I need a member to quarantine.');
        return;
      }

      await runQuarantine(ctx, deps, {
        targetId,
        reason: ctx.options.getString('reason') ?? undefined,
      });
    },
  };
}

export function unquarantineCommand(deps: VerificationDeps): Command {
  return {
    name: 'unquarantine',
    description: 'Lift a quarantine and put the member’s roles back exactly.',

    data: new SlashCommandBuilder()
      .setName('unquarantine')
      .setDescription('Lift a quarantine and put the member’s roles back exactly.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles)
      .addUserOption((option) =>
        option.setName('user').setDescription('The member to release.').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Written to the Discord audit log and to the case.')
          .setMaxLength(REASON_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      const targetId = ctx.options.getUserId('user');
      if (!targetId) {
        await reply(ctx, 'I need a member to release.');
        return;
      }

      await runRelease(ctx, deps, {
        targetId,
        reason: ctx.options.getString('reason') ?? undefined,
      });
    },
  };
}

export function verificationCommands(deps: VerificationDeps): Command[] {
  return [verifyCommand(deps), quarantineCommand(deps), unquarantineCommand(deps)];
}
