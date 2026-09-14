import { z } from 'zod';
import { type BotNameStyle, botNameStyleSchema, snowflakeSchema } from '../actions/payloads.ts';

export const NAME_STYLE_OUTCOMES = ['confirmed', 'ignored', 'rejected', 'unverified'] as const;
export type NameStyleOutcome = (typeof NAME_STYLE_OUTCOMES)[number];

export const NAME_STYLE_REASONS = [
  'missing_change_nickname',
  'discord_refused',
  'discord_ignored',
  'no_answer',
  'not_readable',
  'changed_in_discord',
] as const;
export type NameStyleReason = (typeof NAME_STYLE_REASONS)[number];

export const nameStyleStateSchema = z.object({
  guildId: snowflakeSchema,
  requested: botNameStyleSchema.nullable(),
  outcome: z.enum(NAME_STYLE_OUTCOMES),
  reason: z.enum(NAME_STYLE_REASONS).nullable(),
  attemptedAt: z.number().int().nullable(),
  // Read confirmedAt to learn whether anything is confirmed: null here also means "confirmed no style".
  confirmed: botNameStyleSchema.nullable(),
  confirmedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type NameStyleState = z.infer<typeof nameStyleStateSchema>;

export const nameStyleAttemptSchema = z.object({
  guildId: snowflakeSchema,
  requested: botNameStyleSchema.nullable(),
  outcome: z.enum(NAME_STYLE_OUTCOMES),
  reason: z.enum(NAME_STYLE_REASONS).nullable(),
  at: z.number().int(),
});
export type NameStyleAttempt = z.infer<typeof nameStyleAttemptSchema>;

export interface BrandingNameStyleStore {
  get(guildId: string): Promise<NameStyleState | null>;
  // Touches confirmed only when the outcome is confirmed: a failed attempt must never erase it.
  recordAttempt(attempt: NameStyleAttempt): Promise<void>;
  confirmObserved(guildId: string, style: BotNameStyle | null, at: number): Promise<void>;
  forgetConfirmed(guildId: string, at: number): Promise<void>;
}
