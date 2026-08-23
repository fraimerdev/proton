import {
  type CommandContext,
  type CommandDefinition,
  Permissions,
  snowflakeSchema,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { findMenu, type RolemenuConfig, type RolemenuMenu } from './config.ts';
import { buildComponents } from './message.ts';
import { MESSAGE_MAX, MODULE_ID, replyEphemeral, succeeded } from './perform.ts';

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
      'Role menus are switched off in this server, so posting one would give nobody anything. ' +
        'Turn the Role menus module on from the Proton dashboard first.',
    );
  }

  const menuId = ctx.options.getString('menu')?.trim() ?? '';
  const menu = findMenu(ctx.config, menuId);

  if (!menu) {
    const configured = ctx.config.menus.map((candidate) => candidate.id);
    return reply(
      ctx,
      configured.length === 0
        ? 'This server has no role menus configured yet. Add one in the Proton dashboard under ' +
            'Role menus, then run this again.'
        : `There is no menu called '${menuId}'. This server has: ${configured.join(', ')}.`,
    );
  }

  return menu.kind === 'reaction' ? seedReactions(ctx, menu) : postComponents(ctx, menu);
}

async function postComponents(ctx: Ctx, menu: RolemenuMenu): Promise<void> {
  const content = ctx.options.getString('message') ?? undefined;
  const refreshing = menu.messageId !== undefined;

  const built = buildComponents(menu);
  if (!built.ok) {
    return reply(
      ctx,
      `I couldn't build '${menu.id}': ${built.humanReason} Edit the menu under Role menus in ` +
        'the Proton dashboard.',
    );
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: refreshing ? 'edit_message' : 'send',
    actorId: ctx.userId,
    dryRun: false,
    idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}:post:${menu.id}`,
    payload: {
      channelId: menu.channelId,
      ...(menu.messageId ? { messageId: menu.messageId } : {}),
      ...(content ? { content } : {}),
      components: built.components,
    },
  });

  if (!succeeded(result)) {
    return reply(
      ctx,
      `I couldn't ${refreshing ? 'refresh' : 'post'} '${menu.id}': ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}`,
    );
  }

  return reply(
    ctx,
    refreshing
      ? `Refreshed '${menu.id}' in <#${menu.channelId}>. It now offers ${menu.bindings.length} ` +
          `role${menu.bindings.length === 1 ? '' : 's'}.`
      : `Posted '${menu.id}' in <#${menu.channelId}>. Copy the new message's id into the menu's ` +
          'settings so this command refreshes it in place next time instead of posting a ' +
          'second copy.',
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
  if (seeded.length > 0) lines.push(`Added ${seeded.join(' ')} to the message.`);
  if (manual.length > 0) {
    lines.push(
      `${manual.length} custom emoji need adding by hand — I only have their ids ` +
        `(${manual.join(', ')}), not their names, and Discord's reaction endpoint needs the ` +
        'name. React to the message once with each and members can use them normally.',
    );
  }
  if (failures.length > 0) lines.push(`I couldn't add: ${failures.join(' | ')}`);
  if (lines.length === 0) lines.push('There was nothing to add.');

  return reply(ctx, lines.join(' '));
}

async function reply(ctx: Ctx, content: string): Promise<void> {
  await replyEphemeral(ctx, ctx.interaction, ctx.userId, ctx.idempotencyKey, content);
}
