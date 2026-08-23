import {
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
} from '@proton/core';
import { MODULE_ID, type SuggestionsConfig } from './config.ts';
import { votingOpen } from './decide.ts';
import { bindDeps, describeUnbound, type SuggestionsDeps } from './deps.ts';
import {
  buildSuggestionEmbed,
  buildVoteRow,
  emojiFor,
  isVoteDirection,
  STATUS_LABELS,
  type Tally,
  VOTE_ACTION,
  VOTE_VALUES,
  type VoteDirection,
} from './embed.ts';
import {
  acknowledge,
  answer,
  editSuggestion,
  NOT_WIRED,
  respondTo,
  succeeded,
  tell,
  whyItFailed,
} from './perform.ts';
import type { Suggestion } from './store.ts';

export interface VotePress {
  suggestionId: string;
  direction: VoteDirection;
}

export function readVotePress(customId: unknown): VotePress | null {
  const parsed = parseCustomId(customId);
  if (!parsed || parsed.moduleId !== MODULE_ID || parsed.action !== VOTE_ACTION) return null;

  const [suggestionId, direction] = parsed.args;
  if (!suggestionId || direction === undefined || !isVoteDirection(direction)) return null;

  return { suggestionId, direction };
}

export function describeTally(tally: Tally): string {
  return `${emojiFor('up')} **${tally.up}** ${emojiFor('down')} **${tally.down}**`;
}

export type VoteOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'counted'; suggestionId: string; direction: VoteDirection; unchanged: boolean };

export async function handleVote(
  event: ProtonEvent,
  ctx: ModuleContext<SuggestionsConfig>,
  deps: SuggestionsDeps,
): Promise<VoteOutcome> {
  const facts = readComponentInteraction(event);
  if (!facts) {
    ctx.logger.error(
      'suggestions received an interaction.component it could not read, so whoever voted was ' +
        'left with a failed interaction. This is a gateway/normaliser mismatch.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable interaction payload' };
  }

  const press = readVotePress(facts.customId);
  if (!press) return { action: 'ignored', reason: 'the button is not a suggestion vote' };

  const to = respondTo(ctx, interactionRef(facts), facts.userId, event.id);

  if (!ctx.config.enabled) {
    await answer(
      ctx,
      to,
      'Suggestions are switched off in this server, so this button does nothing right now. An ' +
        'admin can turn them back on from the Proton dashboard.',
    );
    return { action: 'refused', reason: 'suggestions are off in this server' };
  }

  const bound = bindDeps(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('a vote could not be counted', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await answer(ctx, to, NOT_WIRED);
    return { action: 'refused', reason: 'the suggestion store or application id is unbound' };
  }

  await acknowledge(ctx, to);

  const say = (content: string): Promise<unknown> =>
    tell(ctx, to, bound.deps.applicationId, content);

  const suggestion = await bound.deps.store.get(ctx.guildId, press.suggestionId);
  if (!suggestion) {
    await say(
      'That suggestion is no longer on record, so I cannot count your vote. Ask an admin to ' +
        'delete the post — the buttons on it lead nowhere.',
    );
    return { action: 'refused', reason: 'no such suggestion' };
  }

  const emoji = emojiFor(press.direction);

  if (!votingOpen(suggestion.status)) {
    await say(
      `**Suggestion #${suggestion.number}** was already **${STATUS_LABELS[suggestion.status]}**, ` +
        'so voting on it is closed and your press changed nothing.',
    );
    return { action: 'refused', reason: `the suggestion is ${suggestion.status}` };
  }

  if (!ctx.config.allowSelfVote && facts.userId === suggestion.authorId) {
    await say(
      `**Suggestion #${suggestion.number}** is your own, and this server has **Let members vote ` +
        'on their own suggestion** switched off, so I did not count your ' +
        `${emoji}. Everyone else can still vote on it.`,
    );
    return { action: 'refused', reason: 'self-vote is not allowed in this server' };
  }

  const outcome = await bound.deps.store.vote(
    suggestion.id,
    facts.userId,
    VOTE_VALUES[press.direction],
  );

  // Recounted from the vote rows rather than nudged by one: the upsert may have replaced the
  // member's other vote, and an increment would leave both of them standing.
  const tally = await bound.deps.store.tally(suggestion.id);

  const counted =
    outcome === 'unchanged'
      ? `Your ${emoji} on **suggestion #${suggestion.number}** was already counted, so nothing ` +
        `changed. It stands at ${describeTally(tally)}.`
      : `Counted your ${emoji} on **suggestion #${suggestion.number}** — it is now ` +
        `${describeTally(tally)}. Press the other button to change your mind.`;

  await say(`${counted}${await repaint(ctx, event.id, facts.userId, suggestion, tally)}`);

  return {
    action: 'counted',
    suggestionId: suggestion.id,
    direction: press.direction,
    unchanged: outcome === 'unchanged',
  };
}

async function repaint(
  ctx: ModuleContext<SuggestionsConfig>,
  eventId: string,
  actorId: string,
  suggestion: Suggestion,
  tally: Tally,
): Promise<string> {
  if (suggestion.messageId === null) {
    return ' The post itself could not be updated because I never recorded which message it is.';
  }

  const row = buildVoteRow(suggestion.id, suggestion.status);
  if (!row.ok) return ` The post itself could not be updated: ${row.humanReason}`;

  const edited = await editSuggestion(ctx, {
    channelId: suggestion.channelId,
    messageId: suggestion.messageId,
    actorId,
    embeds: [buildSuggestionEmbed(suggestion, tally, { anonymous: ctx.config.anonymous })],
    components: row.components,
    idempotencyKey: `${MODULE_ID}:${eventId}:edit`,
  });

  return succeeded(edited)
    ? ''
    : ` The post itself still shows the old counts: ${whyItFailed(edited)}`;
}
