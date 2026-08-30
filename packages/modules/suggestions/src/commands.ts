import {
  type CommandContext,
  type CommandDefinition,
  type InteractionRef,
  newId,
  Permissions,
  type RespondTo,
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

const NO_CHANNEL =
  'This server has not picked a suggestion channel yet, so there is nowhere for me to post ' +
  'this. An admin sets one under **Suggestions → Suggestion channel** on the Proton dashboard; ' +
  'until then `/suggest` cannot do anything. Nothing was saved.';

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
    await answer(ctx, to, NOT_WIRED);
    return null;
  }

  return { store: bound.deps.store, applicationId: bound.deps.applicationId, to };
}

export function suggestCommand(deps: SuggestionsDeps): Command {
  return {
    name: 'suggest',
    description: 'Suggest something to this server’s staff.',

    data: new SlashCommandBuilder()
      .setName('suggest')
      .setDescription('Suggest something to this server’s staff.')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) =>
        option
          .setName('text')
          .setDescription('What you would like changed, and why it would help.')
          .setRequired(true)
          .setMaxLength(SUGGESTION_CONTENT_MAX),
      )
      .toJSON(),

    async handler(ctx) {
      const bound = await ready(ctx, deps, 'a suggestion could not be posted');
      if (!bound) return;

      const channelId = ctx.config.channelId;
      if (channelId === undefined) {
        await answer(ctx, bound.to, NO_CHANNEL);
        return;
      }

      const parsed = normaliseSuggestion(ctx.options.getString('text') ?? '');
      if (!parsed.ok) {
        await answer(ctx, bound.to, parsed.humanReason);
        return;
      }

      await acknowledge(ctx, bound.to);

      const say = (content: string): Promise<unknown> =>
        tell(ctx, bound.to, bound.applicationId, content);

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
        await say(`I could not build the vote buttons, so nothing was posted: ${row.humanReason}`);
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
          `I could not post your suggestion in <#${channelId}>, so nothing was saved: ` +
            `${whyItFailed(posted)}`,
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
        `Posted as **suggestion #${suggestion.number}** in <#${channelId}>. Members vote with ` +
          `the buttons under it.${thread}`,
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
    return ` I could not open its discussion thread: ${whyItFailed(thread)}`;
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
    accept: 'Accept a suggestion and edit its post to say so.',
    deny: 'Turn a suggestion down and edit its post to say so.',
    implement: 'Mark a suggestion as done and edit its post to say so.',
  };

  for (const decision of DECISIONS) {
    command.addSubcommand((sub) =>
      sub
        .setName(decision)
        .setDescription(described[decision] ?? 'Decide a suggestion.')
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('The number in the title of the suggestion post.')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(SUGGESTION_NUMBER_MAX),
        )
        .addStringOption((option) =>
          option
            .setName('reason')
            .setDescription('Shown on the post, so the server knows why.')
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
        await answer(ctx, bound.to, 'That subcommand is not one I know.');
        return;
      }

      const number = ctx.options.getInteger('number');
      if (number === null) {
        await answer(
          ctx,
          bound.to,
          'That command needs a suggestion number — the one in the title of the post, like ' +
            '`Suggestion #12`.',
        );
        return;
      }

      await acknowledge(ctx, bound.to);

      const say = (content: string): Promise<unknown> =>
        tell(ctx, bound.to, bound.applicationId, content);

      const suggestion = await bound.store.byNumber(ctx.guildId, number);
      if (!suggestion) {
        await say(
          `There is no **suggestion #${number}** in this server, so there was nothing to ` +
            `${subcommand}. The number is the one in the title of the post you mean.`,
        );
        return;
      }

      const outcome = decide(suggestion.status, subcommand);
      if (outcome.outcome === 'unchanged') {
        await say(
          `**Suggestion #${number}** is already **${STATUS_LABELS[outcome.status]}**, so nothing ` +
            'changed. Pick a different decision if you have changed your mind.',
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
          `**Suggestion #${number}** disappeared while I was deciding it, so nothing was ` +
            'recorded. Try again.',
        );
        return;
      }

      const previously = outcome.redecided
        ? ` It was **${STATUS_LABELS[outcome.from]}** before.`
        : '';

      const post = await refresh(ctx, bound, decided);

      await say(
        `**Suggestion #${number}** is now **${STATUS_LABELS[decided.status]}**.${previously}${post}`,
      );
    },
  };
}

async function refresh(ctx: Ctx, bound: Bound, suggestion: Suggestion): Promise<string> {
  if (suggestion.messageId === null) {
    return (
      ' I never recorded which message it was posted as, so the post itself still shows the old ' +
      'status. Editing it by hand is the only fix.'
    );
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
