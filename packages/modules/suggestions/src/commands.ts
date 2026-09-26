import {
  type CommandContext,
  type CommandDefinition,
  errorStatus,
  type InteractionRef,
  labelOf,
  newId,
  Permissions,
  type RespondTo,
  type StatusBody,
  successStatus,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType, InteractionType } from 'discord-api-types/v10';
import {
  DECISION_REASON_MAX,
  MODULE_ID,
  normaliseSuggestion,
  SUGGESTION_CONTENT_MAX,
  SUGGESTION_NUMBER_MAX,
  type SuggestionsConfig,
  trimReason,
} from './config.ts';
import { DECISIONS, decide, isDecision } from './decide.ts';
import { bindDeps, describeUnbound, type SuggestionsDeps } from './deps.ts';
import {
  buildSuggestionEmbed,
  buildVoteRow,
  NO_VOTES,
  STATUS_LABELS,
  threadName,
} from './embed.ts';
import {
  acknowledge,
  answer,
  createdId,
  editSuggestion,
  NOT_WIRED,
  openThread,
  postSuggestion,
  respondTo,
  succeeded,
  tell,
  whyItFailed,
} from './perform.ts';
import type { Suggestion, SuggestionStore } from './store.ts';

type Command = CommandDefinition<SuggestionsConfig>;
type Ctx = CommandContext<SuggestionsConfig>;

function noChannel(suggest: string): string {
  return (
    `This server has no suggestion channel yet, so \`${suggest}\` can’t post anything. An ` +
    'admin can choose one in the Proton dashboard under **Suggestions**. Nothing was saved.'
  );
}

function interactionOf(ctx: Ctx): InteractionRef {
  return {
    id: ctx.interaction.id,
    token: ctx.interaction.token,
    type: InteractionType.ApplicationCommand,
  };
}

function replyTo(ctx: Ctx): RespondTo {
  return respondTo(ctx, interactionOf(ctx), ctx.userId, ctx.idempotencyKey);
}

interface Bound {
  store: SuggestionStore;
  applicationId: string;
  to: RespondTo;
}

async function ready(ctx: Ctx, deps: SuggestionsDeps, what: string): Promise<Bound | null> {
  const to = replyTo(ctx);
  const bound = bindDeps(deps);

  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(what, bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await answer(ctx, to, errorStatus(NOT_WIRED));
    return null;
  }

  return { store: bound.deps.store, applicationId: bound.deps.applicationId, to };
}

export function suggestCommand(deps: SuggestionsDeps): Command {
  return {
    name: 'suggest',
    description: 'Post a suggestion for the server to vote on.',

    data: new SlashCommandBuilder()
      .setName('suggest')
      .setDescription('Post a suggestion for the server to vote on.')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) =>
        option
          .setName('text')
          .setDescription('What you’d like to change, and why it would help.')
          .setRequired(true)
          .setMaxLength(SUGGESTION_CONTENT_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      const bound = await ready(ctx, deps, 'a suggestion could not be posted');
      if (!bound) return;

      const suggest = labelOf(ctx, 'suggest');
      const channelId = ctx.config.channelId;
      if (channelId === undefined) {
        await answer(ctx, bound.to, errorStatus(noChannel(suggest)));
        return;
      }

      const parsed = normaliseSuggestion(ctx.options.getString('text') ?? '', suggest);
      if (!parsed.ok) {
        await answer(ctx, bound.to, errorStatus(parsed.humanReason));
        return;
      }

      await acknowledge(ctx, bound.to);

      const say = (body: StatusBody): Promise<unknown> =>
        tell(ctx, bound.to, bound.applicationId, body);

      const suggestion = await bound.store.create({
        id: newId(),
        guildId: ctx.guildId,
        channelId,
        authorId: ctx.userId,
        content: parsed.content,
      });

      const row = buildVoteRow(suggestion.id, suggestion.status);
      if (!row.ok) {
        await bound.store.remove(ctx.guildId, suggestion.id);
        await say(
          errorStatus(
            `I couldn’t build the vote buttons, so nothing was posted in <#${channelId}>: ` +
              `${row.humanReason}`,
          ),
        );
        return;
      }

      const posted = await postSuggestion(ctx, {
        channelId,
        actorId: ctx.userId,
        embeds: [buildSuggestionEmbed(suggestion, NO_VOTES, { anonymous: ctx.config.anonymous })],
        components: row.components,
        idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}:post`,
      });

      // The number is handed back the moment the row is deleted, and a row nobody can vote on is
      // worse than no row: the dashboard would list a suggestion with no post behind it.
      if (!succeeded(posted)) {
        await bound.store.remove(ctx.guildId, suggestion.id);
        await say(
          errorStatus(
            `I couldn’t post your suggestion in <#${channelId}>, so nothing was saved: ` +
              `${whyItFailed(posted)}`,
          ),
        );
        return;
      }

      // The post key is this interaction's own event id, so a duplicate claim means the gateway
      // redelivered the command: the first delivery posted it, and this row is a second number.
      if (posted.status === 'skipped_duplicate') {
        await bound.store.remove(ctx.guildId, suggestion.id);
        return;
      }

      const messageId = createdId(posted);
      if (messageId !== null) {
        await bound.store.attach(ctx.guildId, suggestion.id, { messageId });
      }

      const thread = await discussIn(ctx, bound, suggestion.id, channelId, threadName(suggestion));

      await say(
        successStatus(
          `Posted **suggestion #${suggestion.number}** in <#${channelId}>. Members can vote ` +
            `with the buttons under it.${thread}`,
        ),
      );
    },
  };
}

async function discussIn(
  ctx: Ctx,
  bound: Bound,
  suggestionId: string,
  channelId: string,
  name: string,
): Promise<string> {
  if (!ctx.config.createThread) return '';

  const thread = await openThread(ctx, {
    channelId,
    name,
    actorId: ctx.userId,
    idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}:thread`,
  });

  if (!succeeded(thread)) {
    return ` I couldn’t open its discussion thread: ${whyItFailed(thread)}`;
  }

  const threadId = createdId(thread);
  if (threadId !== null) await bound.store.attach(ctx.guildId, suggestionId, { threadId });

  return threadId === null ? '' : ` Discuss it in <#${threadId}>.`;
}

function decisionBuilder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Accept, deny or mark one of this server’s suggestions implemented.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ManageMessages);

  const described: Record<string, string> = {
    accept: 'Accept a suggestion and update its post.',
    deny: 'Deny a suggestion and update its post.',
    implement: 'Mark a suggestion as implemented and update its post.',
  };

  for (const decision of DECISIONS) {
    command.addSubcommand((sub) =>
      sub
        .setName(decision)
        .setDescription(described[decision] ?? 'Decide a suggestion.')
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('The number in the suggestion post’s title.')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(SUGGESTION_NUMBER_MAX),
        )
        .addStringOption((option) =>
          option
            .setName('reason')
            .setDescription('Why you decided this. Shown on the post.')
            .setMaxLength(DECISION_REASON_MAX),
        ),
    );
  }

  return command;
}

export function suggestionCommand(deps: SuggestionsDeps): Command {
  return {
    name: 'suggestion',
    description: 'Accept, deny or mark one of this server’s suggestions implemented.',

    data: decisionBuilder().toJSON(),

    async handler(ctx) {
      const bound = await ready(ctx, deps, 'a suggestion could not be decided');
      if (!bound) return;

      const subcommand = ctx.options.getSubcommand() ?? '';
      if (!isDecision(subcommand)) {
        await answer(ctx, bound.to, errorStatus('I don’t recognise that subcommand.'));
        return;
      }

      const number = ctx.options.getInteger('number');
      if (number === null) {
        await answer(
          ctx,
          bound.to,
          errorStatus(
            'Give the suggestion’s number. It’s in the title of its post, like `Suggestion #12`.',
          ),
        );
        return;
      }

      await acknowledge(ctx, bound.to);

      const say = (body: StatusBody): Promise<unknown> =>
        tell(ctx, bound.to, bound.applicationId, body);

      const suggestion = await bound.store.byNumber(ctx.guildId, number);
      if (!suggestion) {
        await say(
          errorStatus(
            `Couldn’t find **suggestion #${number}**. The number is in the title of its post.`,
          ),
        );
        return;
      }

      const outcome = decide(suggestion.status, subcommand);
      if (outcome.outcome === 'unchanged') {
        await say(
          errorStatus(
            `**Suggestion #${number}** is already **${STATUS_LABELS[outcome.status]}**, so ` +
              'nothing changed.',
          ),
        );
        return;
      }

      const decided = await bound.store.decide({
        guildId: ctx.guildId,
        suggestionId: suggestion.id,
        status: outcome.to,
        decidedBy: ctx.userId,
        decidedAt: new Date(),
        reason: trimReason(ctx.options.getString('reason')),
      });

      if (!decided) {
        await say(
          errorStatus(
            `**Suggestion #${number}** was deleted before I could update it, so nothing was ` +
              'saved.',
          ),
        );
        return;
      }

      const previously = outcome.redecided
        ? ` It was **${STATUS_LABELS[outcome.from]}** before.`
        : '';

      const post = await refresh(ctx, bound, decided);

      await say(
        successStatus(
          `**Suggestion #${number}** is now **${STATUS_LABELS[decided.status]}**.` +
            `${previously}${post}`,
        ),
      );
    },
  };
}

async function refresh(ctx: Ctx, bound: Bound, suggestion: Suggestion): Promise<string> {
  if (suggestion.messageId === null) {
    return ' The post still shows the old status because I don’t know which message it is.';
  }

  const row = buildVoteRow(suggestion.id, suggestion.status);
  if (!row.ok) {
    return ` The post still shows the old status: ${row.humanReason}`;
  }

  const tally = await bound.store.tally(suggestion.id);

  const edited = await editSuggestion(ctx, {
    channelId: suggestion.channelId,
    messageId: suggestion.messageId,
    actorId: ctx.userId,
    embeds: [buildSuggestionEmbed(suggestion, tally, { anonymous: ctx.config.anonymous })],
    components: row.components,
    idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}:edit`,
  });

  return succeeded(edited)
    ? ''
    : ` The post in <#${suggestion.channelId}> still shows the old status: ${whyItFailed(edited)}`;
}

export function suggestionsCommands(deps: SuggestionsDeps): Command[] {
  return [suggestCommand(deps), suggestionCommand(deps)];
}
