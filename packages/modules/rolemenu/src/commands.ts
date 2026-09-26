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
import type { RolemenuDeps } from './deps.ts';
import {
  deferEphemeral,
  followUp,
  MESSAGE_MAX,
  MODULE_ID,
  replyEphemeral,
  succeeded,
} from './perform.ts';
import { postMenu } from './post.ts';

type Command = CommandDefinition<RolemenuConfig>;

type Ctx = CommandContext<RolemenuConfig>;

type Answer = (message: string | StatusBody) => Promise<void>;

export function rolemenuCommand(deps: RolemenuDeps = {}): Command {
  return {
    name: 'rolemenu',
    description: 'Post a role menu, or update one that’s already posted.',

    data: new SlashCommandBuilder()
      .setName('rolemenu')
      .setDescription('Post a role menu, or update one that’s already posted.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles)
      .addStringOption((option) =>
        option
          .setName('menu')
          .setDescription('The menu ID from the Proton dashboard.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription(
            'Text to show above the menu. Leave empty when updating to keep the current text.',
          )
          .setMaxLength(MESSAGE_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      await runRolemenu(ctx, await acknowledge(ctx, deps));
    },
  };
}

export function rolemenuCommands(deps: RolemenuDeps = {}): Command[] {
  return [rolemenuCommand(deps)];
}

async function acknowledge(ctx: Ctx, deps: RolemenuDeps): Promise<Answer> {
  const applicationId = ctx.applicationId ?? deps.applicationId;

  // Without an application id there is no followup webhook, so the one callback must be the answer.
  if (!applicationId) {
    return async (message) => {
      await replyEphemeral(ctx, ctx.interaction, ctx.userId, ctx.idempotencyKey, message);
    };
  }

  await deferEphemeral(ctx, ctx.interaction, ctx.userId, ctx.idempotencyKey);

  return async (message) => {
    await followUp(
      ctx,
      { applicationId, interaction: ctx.interaction },
      ctx.userId,
      ctx.idempotencyKey,
      message,
    );
  };
}

async function runRolemenu(ctx: Ctx, answer: Answer): Promise<void> {
  if (!ctx.config.enabled) {
    return answer(
      errorStatus(
        'Role Menus is off in this server, so nothing was posted. An admin can turn it on from ' +
          'the Proton dashboard.',
      ),
    );
  }

  const menuId = ctx.options.getString('menu')?.trim() ?? '';
  const menu = findMenu(ctx.config, menuId);

  if (!menu) {
    const configured = ctx.config.menus.map((candidate) => candidate.id);
    return answer(
      errorStatus(
        configured.length === 0
          ? 'This server has no role menus yet. Create one on the Proton dashboard under Role ' +
              'Menus, then run this again.'
          : `Couldn't find a menu called '${menuId}'. Menus in this server: ${configured.join(', ')}.`,
      ),
    );
  }

  return menu.kind === 'reaction'
    ? seedReactions(ctx, menu, answer)
    : postComponents(ctx, menu, answer);
}

async function postComponents(ctx: Ctx, menu: RolemenuMenu, answer: Answer): Promise<void> {
  const posted = await postMenu(ctx, menu, {
    actorId: ctx.userId,
    idempotencyKey: ctx.idempotencyKey,
    content: ctx.options.getString('message') ?? undefined,
  });

  const refreshing = posted.refreshed;

  if (!posted.ok) {
    return answer(
      errorStatus(
        `Couldn't ${refreshing ? 'update' : 'post'} '${menu.id}' in <#${menu.channelId}>: ` +
          `${posted.humanReason}`,
      ),
    );
  }

  return answer(
    successStatus(
      refreshing
        ? `Updated '${menu.id}' in <#${menu.channelId}>. It now offers ${menu.bindings.length} ` +
            `role${menu.bindings.length === 1 ? '' : 's'}.`
        : `Posted '${menu.id}' in <#${menu.channelId}>. Copy the new message's ID into the menu's ` +
            'Message ID setting, so the next post updates it instead of adding a second copy.',
    ),
  );
}

async function seedReactions(ctx: Ctx, menu: RolemenuMenu, answer: Answer): Promise<void> {
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
      failures.push(
        `Couldn't add ${binding.key}: ${result.failure?.humanReason ?? 'no reason was given.'}`,
      );
    }
  }

  const lines: string[] = [];
  if (seeded.length > 0) {
    lines.push(`Added ${seeded.join(' ')} to the '${menu.id}' message in <#${menu.channelId}>.`);
  }
  if (manual.length > 0) {
    const one = manual.length === 1;
    lines.push(
      `${one ? 'One custom emoji' : `${manual.length} custom emoji`} (${manual.join(', ')}) ` +
        `must be added by hand, because Discord needs an emoji's name to react and I only have ` +
        `${one ? 'its ID' : 'their IDs'}. React to the message once with ${one ? 'it' : 'each'}, ` +
        `and members can then use ${one ? 'it' : 'them'}.`,
    );
  }
  lines.push(...failures);
  if (lines.length === 0) lines.push(`'${menu.id}' has no emoji to add.`);

  const fellShort = failures.length > 0 || manual.length > 0 || seeded.length === 0;
  const text = lines.join(' ');

  return answer(fellShort ? errorStatus(text) : successStatus(text));
}
