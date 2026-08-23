import {
  type ActionRow,
  DEFAULT_MENTION_POLICY,
  type Embed,
  type MentionPolicy,
  type ProtonMessage,
  type V2Component,
} from '@proton/core';

// Panels are handed raw stored config, not schema output, so the caller must lift first: a message
// saved before it could hold embeds is still a bare string, and a bare string has no embeds array.
export function messageFrom(lifted: unknown): ProtonMessage {
  const record = (typeof lifted === 'object' && lifted !== null ? lifted : {}) as Record<
    string,
    unknown
  >;
  const mentions = record.mentions;

  return {
    ...(typeof record.content === 'string' ? { content: record.content } : {}),
    embeds: Array.isArray(record.embeds) ? (record.embeds as Embed[]) : [],
    components: Array.isArray(record.components) ? (record.components as ActionRow[]) : [],
    mentions: {
      ...DEFAULT_MENTION_POLICY,
      ...(typeof mentions === 'object' && mentions !== null ? (mentions as MentionPolicy) : {}),
    },

    // Copied explicitly, like every other key: this is a hand-written projection rather than schema
    // output, so a key it forgets is dropped from the stored config on the next panel edit.
    v2: Array.isArray(record.v2) ? (record.v2 as V2Component[]) : [],
  };
}
