import {
  type CommandContext,
  type CommandDefinition,
  errorStatus,
  Permissions,
  type StatusBody,
  snowflakeSchema,
  successStatus,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { findMenu, type RolemenuConfig, type RolemenuMenu } from './config.ts';
import { MESSAGE_MAX, MODULE_ID, replyEphemeral, succeeded } from './perform.ts';
import { postMenu } from './post.ts';

type Command = CommandDefinition<RolemenuConfig>;

type Ctx = CommandContext<RolemenuConfig>;

export function rolemenuCommand(): Command {
  return {
    name: 'rolemenu',
    description: 'Post one of this server’s role menus, or refresh it after editing it.',

    data: new SlashCommandBuilder()
      .setName('rolemenu')
      .setDescription('Post one of this server’s role menus, or refresh it after editing it.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles)
      .addStringOption((option) =>
        option
          .setName('menu')
          .setDescription('The id of the menu, as configured in the Proton dashboard.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription('Text to post above the menu. Leave empty when refreshing to keep it.')
          .setMaxLength(MESSAGE_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      await runRolemenu(ctx);
    },
  };
}

export const rolemenuCommands: Command[] = [rolemenuCommand()];

async function runRolemenu(ctx: Ctx): Promise<void> {
  if (!ctx.config.enabled) {
    return reply(
      ctx,
      errorStatus(
        'Role menus are disabled in this server, so posting one would give nobody anything. ' +
          'Turn the Role menus module on from the Proton dashboard first.',
      ),
    );
  }

  const menuId = ctx.options.getString('menu')?.trim() ?? '';
  const menu = findMenu(ctx.config, menuId);

  if (!menu) {
    const configured = ctx.config.menus.map((candidate) => candidate.id);
    return reply(
      ctx,
      errorStatus(
        configured.length === 0
          ? 'This server has no role menus configured yet. Add one in the Proton dashboard under ' +
              'Role menus, then run this again.'
          : `There is no menu called '${menuId}'. This server has: ${configured.join(', ')}.`,
      ),
    );
  }

  return menu.kind === 'reaction' ? seedReactions(ctx, menu) : postComponents(ctx, menu);
}

async function postComponents(ctx: Ctx, menu: RolemenuMenu): Promise<void> {
  const posted = await postMenu(ctx, menu, {
    actorId: ctx.userId,
    idempotencyKey: ctx.idempotencyKey,
    content: ctx.options.getString('message') ?? undefined,
  });

  const refreshing = posted.refreshed;

  if (!posted.ok) {
    return reply(
      ctx,
      errorStatus(
        `I couldn't ${refreshing ? 'refresh' : 'post'} '${menu.id}' in <#${menu.channelId}>: ` +
          `${posted.humanReason}`,
      ),
    );
  }

  return reply(
    ctx,
    successStatus(
      refreshing
        ? `Refreshed '${menu.id}' in <#${menu.channelId}>. It now offers ${menu.bindings.length} ` +
            `role${menu.bindings.length === 1 ? '' : 's'}.`
        : `Posted '${menu.id}' in <#${menu.channelId}>. Copy the new message's id into the menu's ` +
            'settings so this command refreshes it in place next time instead of posting a ' +
            'second copy.',
    ),
  );
}

async function seedReactions(ctx: Ctx, menu: RolemenuMenu): Promise<void> {
  const seeded: string[] = [];
  const manual: string[] = [];
  const failures: string[] = [];

  for (const binding of menu.bindings) {
    if (snowflakeSchema.safeParse(binding.key).success) {
      manual.push(binding.key);
      continue;
    }

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'add_reaction',
      actorId: ctx.userId,
      dryRun: false,
      idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}:seed:${menu.id}:${binding.key}`,
      payload: { channelId: menu.channelId, messageId: menu.messageId, emoji: binding.key },
    });

    if (succeeded(result)) {
      seeded.push(binding.key);
    } else {
      failures.push(`${binding.key}: ${result.failure?.humanReason ?? 'no reason was reported'}`);
    }
  }

  const lines: string[] = [];
  if (seeded.length > 0) {
    lines.push(`Added ${seeded.join(' ')} to '${menu.id}' in <#${menu.channelId}>.`);
  }
  if (manual.length > 0) {
    const one = manual.length === 1;
    lines.push(
      `${one ? 'One custom emoji needs' : `${manual.length} custom emoji need`} adding by hand — I ` +
        `only have ${one ? 'its id' : 'their ids'} (${manual.join(', ')}), not ${one ? 'its name' : 'their names'}, ` +
        `and Discord needs an emoji's name to react with it. React to the message once with ` +
        `${one ? 'it' : 'each'} and members can use ${one ? 'it' : 'them'} normally.`,
    );
  }
  if (failures.length > 0) lines.push(`I couldn't add: ${failures.join(' | ')}`);
  if (lines.length === 0) lines.push(`'${menu.id}' has no emoji for me to add.`);

  const fellShort = failures.length > 0 || manual.length > 0 || seeded.length === 0;
  const text = lines.join(' ');

  return reply(ctx, fellShort ? errorStatus(text) : successStatus(text));
}

async function reply(ctx: Ctx, message: string | StatusBody): Promise<void> {
  await replyEphemeral(ctx, ctx.interaction, ctx.userId, ctx.idempotencyKey, message);
}
