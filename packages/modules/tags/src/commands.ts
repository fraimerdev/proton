import {
  type CommandContext,
  type CommandDefinition,
  checkLimit,
  type EntitlementTier,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import {
  MODULE_ID,
  normaliseTagName,
  TAG_CONTENT_MAX,
  TAG_LIST_PAGE_SIZE,
  TAG_NAME_MAX,
  type TagsConfig,
} from './config.ts';
import { bindStore, describeUnbound, type TagsDeps } from './deps.ts';
import { MENTIONS_OFF, reply } from './perform.ts';
import type { TagStore } from './store.ts';

type Command = CommandDefinition<TagsConfig>;

const NOT_WIRED =
  "I can't reach this server's tags because Proton isn't fully wired up in this deployment. " +
  'Nothing was changed. The Proton logs name the exact missing piece.';

async function ready(
  ctx: CommandContext<TagsConfig>,
  deps: TagsDeps,
  what: string,
): Promise<TagStore | null> {
  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(what, bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, NOT_WIRED, { ephemeral: true });
    return null;
  }

  return bound.store;
}

async function named(ctx: CommandContext<TagsConfig>, raw: string | null): Promise<string | null> {
  if (raw === null) {
    await reply(ctx, 'That command needs a tag name.', { ephemeral: true });
    return null;
  }

  const parsed = normaliseTagName(raw);
  if (!parsed.ok) {
    await reply(ctx, parsed.humanReason, { ephemeral: true });
    return null;
  }

  return parsed.name;
}

export function tagCommand(deps: TagsDeps): Command {
  return {
    name: 'tag',
    description: 'Post a saved snippet.',

    data: new SlashCommandBuilder()
      .setName('tag')
      .setDescription('Post a saved snippet.')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Which tag to post.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(TAG_NAME_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      const store = await ready(ctx, deps, 'a tag could not be posted');
      if (!store) return;

      const name = await named(ctx, ctx.options.getString('name'));
      if (name === null) return;

      const tag = await store.recall(ctx.guildId, name);
      if (!tag) {
        await reply(
          ctx,
          `There is no tag called **${name}** in this server. \`/tags list\` shows what there is.`,
          { ephemeral: true },
        );
        return;
      }

      await reply(ctx, tag.content, {
        ephemeral: ctx.config.ephemeral,
        ...(ctx.config.allowMentions ? {} : { allowedMentions: MENTIONS_OFF }),
      });
    },
  };
}

function tagsBuilder(): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName('tags')
    .setDescription('Create, edit and browse this server’s saved snippets.')
    .setContexts(InteractionContextType.Guild);

  builder.addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Save a new snippet.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('What to call it. Letters, digits, dots, dashes and underscores.')
          .setRequired(true)
          .setMaxLength(TAG_NAME_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('content')
          .setDescription('What the tag posts.')
          .setRequired(true)
          .setMaxLength(TAG_CONTENT_MAX),
      ),
  );

  builder.addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Replace what an existing tag posts.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Which tag to edit.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(TAG_NAME_MAX),
      )
      .addStringOption((option) =>
        option
          .setName('content')
          .setDescription('The new text.')
          .setRequired(true)
          .setMaxLength(TAG_CONTENT_MAX),
      ),
  );

  builder.addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Remove a tag.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Which tag to remove.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(TAG_NAME_MAX),
      ),
  );

  builder.addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List this server’s tags.')
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Which page to show. Defaults to 1.').setMinValue(1),
      ),
  );

  builder.addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show who wrote a tag and how often it is used.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Which tag to describe.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(TAG_NAME_MAX),
      ),
  );

  return builder;
}

async function create(ctx: CommandContext<TagsConfig>, store: TagStore): Promise<void> {
  const name = await named(ctx, ctx.options.getString('name'));
  if (name === null) return;

  const content = ctx.options.getString('content');
  if (content === null || content.trim().length === 0) {
    await reply(ctx, 'A tag needs some text to post.', { ephemeral: true });
    return;
  }

  const tier: EntitlementTier = ctx.tier ?? 'free';
  const limit = checkLimit(tier, 'tags', await store.count(ctx.guildId));
  if (!limit.ok) {
    await reply(ctx, `I did not save **${name}**: ${limit.humanReason}`, { ephemeral: true });
    return;
  }

  const outcome = await store.create({
    guildId: ctx.guildId,
    name,
    content,
    createdBy: ctx.userId,
  });

  if (outcome === 'exists') {
    await reply(
      ctx,
      `**${name}** already exists in this server. Use \`/tags edit\` to change what it says.`,
      { ephemeral: true },
    );
    return;
  }

  await reply(ctx, `Saved **${name}**. Anyone can post it with \`/tag ${name}\`.`, {
    ephemeral: true,
  });
}

async function edit(ctx: CommandContext<TagsConfig>, store: TagStore): Promise<void> {
  const name = await named(ctx, ctx.options.getString('name'));
  if (name === null) return;

  const content = ctx.options.getString('content');
  if (content === null || content.trim().length === 0) {
    await reply(ctx, 'A tag needs some text to post.', { ephemeral: true });
    return;
  }

  const changed = await store.update(ctx.guildId, name, content, ctx.userId);

  await reply(
    ctx,
    changed
      ? `Updated **${name}**.`
      : `There is no tag called **${name}** in this server, so nothing was changed.`,
    { ephemeral: true },
  );
}

async function remove(ctx: CommandContext<TagsConfig>, store: TagStore): Promise<void> {
  const name = await named(ctx, ctx.options.getString('name'));
  if (name === null) return;

  const removed = await store.remove(ctx.guildId, name);

  await reply(
    ctx,
    removed
      ? `Deleted **${name}**.`
      : `There is no tag called **${name}** in this server, so nothing was deleted.`,
    { ephemeral: true },
  );
}

export function renderList(
  names: readonly string[],
  page: number,
  total: number,
  pageSize: number,
): string {
  if (total === 0) {
    return 'This server has no tags yet. `/tags create` makes the first one.';
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (names.length === 0) {
    return `Page ${page} is empty — this server has ${total} tag(s) across ${pages} page(s).`;
  }

  return (
    `**Tags** — page ${page} of ${pages}, ${total} in total\n` +
    names.map((name) => `\`${name}\``).join(', ')
  );
}

async function list(ctx: CommandContext<TagsConfig>, store: TagStore): Promise<void> {
  const page = ctx.options.getInteger('page') ?? 1;

  const result = await store.list({
    guildId: ctx.guildId,
    page,
    pageSize: TAG_LIST_PAGE_SIZE,
  });

  await reply(
    ctx,
    renderList(
      result.tags.map((tag) => tag.name),
      page,
      result.total,
      TAG_LIST_PAGE_SIZE,
    ),
    { ephemeral: true, allowedMentions: MENTIONS_OFF },
  );
}

async function info(ctx: CommandContext<TagsConfig>, store: TagStore): Promise<void> {
  const name = await named(ctx, ctx.options.getString('name'));
  if (name === null) return;

  const tag = await store.get(ctx.guildId, name);
  if (!tag) {
    await reply(ctx, `There is no tag called **${name}** in this server.`, { ephemeral: true });
    return;
  }

  const edited =
    tag.updatedBy === null
      ? ''
      : `\nLast edited by <@${tag.updatedBy}> <t:${Math.floor(tag.updatedAt.getTime() / 1000)}:R>.`;

  await reply(
    ctx,
    `**${tag.name}** — created by <@${tag.createdBy}> ` +
      `<t:${Math.floor(tag.createdAt.getTime() / 1000)}:R>, posted ${tag.uses} time(s).${edited}`,
    { ephemeral: true, allowedMentions: MENTIONS_OFF },
  );
}

export function tagsCommand(deps: TagsDeps): Command {
  return {
    name: 'tags',
    description: 'Create, edit and browse this server’s saved snippets.',

    data: tagsBuilder().toJSON(),

    async handler(ctx) {
      const store = await ready(ctx, deps, 'the tag list could not be reached');
      if (!store) return;

      switch (ctx.options.getSubcommand()) {
        case 'create':
          return create(ctx, store);
        case 'edit':
          return edit(ctx, store);
        case 'delete':
          return remove(ctx, store);
        case 'list':
          return list(ctx, store);
        case 'info':
          return info(ctx, store);
        default:
          await reply(ctx, 'That subcommand is not one I know.', { ephemeral: true });
      }
    },
  };
}

export function tagsCommands(deps: TagsDeps): Command[] {
  return [tagCommand(deps), tagsCommand(deps)];
}
