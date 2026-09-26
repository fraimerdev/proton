import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'suggestions';

export const SUGGESTION_CONTENT_MAX = 1500;
export const DECISION_REASON_MAX = 400;

export const SUGGESTION_NUMBER_MAX = 1_000_000;

export type ContentResult = { ok: true; content: string } | { ok: false; humanReason: string };

export function normaliseSuggestion(raw: string, suggest: string): ContentResult {
  const content = raw.trim();

  if (content.length === 0) {
    return {
      ok: false,
      humanReason: 'Your suggestion is empty. Say what you’d like to change and why it would help.',
    };
  }

  if (content.length > SUGGESTION_CONTENT_MAX) {
    return {
      ok: false,
      humanReason:
        `Suggestions can be up to ${SUGGESTION_CONTENT_MAX} characters, and yours has ` +
        `${content.length}. Nothing was posted. Shorten it and run \`${suggest}\` again.`,
    };
  }

  return { ok: true, content };
}

export function trimReason(raw: string | null): string | null {
  const reason = (raw ?? '').trim();
  return reason.length === 0 ? null : reason.slice(0, DECISION_REASON_MAX);
}

export const suggestionsConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  channelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Suggestion channel',
    description:
      'Where suggestions are posted. Needs View Channel, Send Messages and Embed Links there.',
  }),

  createThread: z.boolean().default(false).register(protonFields, {
    label: 'Create discussion threads',
    description:
      'Open a thread under each suggestion. Needs Create Public Threads in the suggestion channel.',
  }),

  allowSelfVote: z
    .boolean()
    .default(true)
    .register(protonFields, { label: 'Let members vote on their own suggestion' }),

  anonymous: z.boolean().default(false).register(protonFields, {
    label: 'Attribution',
    description: 'Choose whether suggestions show who wrote them. Proton still stores the author.',
  }),
});

export type SuggestionsConfig = z.infer<typeof suggestionsConfigSchema>;

export const suggestionsDefaultConfig: SuggestionsConfig = {
  enabled: false,
  createThread: false,
  allowSelfVote: true,
  anonymous: false,
};

export const SUGGESTIONS_SCHEMA_VERSION = 1;
