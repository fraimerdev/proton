import type { CommandDefinition } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { attachmentMeta } from '../reports/evidence.ts';
import { refuseInvoker, startIntake } from '../reports/intake.ts';
import { REPORT_COMMAND } from '../reports/types.ts';

const LINK_OPTION_MAX = 200;

export function reportCommand(deps: ModerationDeps): CommandDefinition<ModerationConfig> {
  return {
    name: REPORT_COMMAND,
    description: 'Report a member to this server’s staff.',

    data: new SlashCommandBuilder()
      .setName(REPORT_COMMAND)
      .setDescription('Report a member to this server’s staff.')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option.setName('member').setDescription('The member you’re reporting.').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription('A link to a message that shows the problem.')
          .setMaxLength(LINK_OPTION_MAX),
      )
      .addAttachmentOption((option) =>
        option.setName('evidence').setDescription('A screenshot or file that shows the problem.'),
      )
      .toJSON(),

    async handler(ctx) {
      const targetId = ctx.options.getUserId('member');
      if (!targetId) return refuseInvoker(ctx, 'Pick the member you want to report.');

      const user = ctx.resolved?.users.get(targetId);
      const member = ctx.resolved?.members.get(targetId);
      const attachment = ctx.options.getAttachment('evidence');
      const link = ctx.options.getString('message')?.trim() ?? '';

      return startIntake(ctx, deps, {
        method: 'command',
        targetId,
        targetName: user?.username ?? null,
        targetBot: user?.bot ?? false,
        targetRoleIds: member ? member.roleIds : null,
        source: null,
        message: null,
        messageLink: link.length > 0 ? link : null,
        attachment: attachment ? attachmentMeta(attachment) : null,
      });
    },
  };
}
