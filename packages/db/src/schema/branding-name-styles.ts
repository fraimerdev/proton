import type { BotNameStyle, NameStyleOutcome, NameStyleReason } from '@proton/core';
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const brandingNameStyles = pgTable('branding_name_styles', {
  guildId: text('guild_id')
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),

  requested: jsonb('requested').$type<BotNameStyle>(),
  outcome: text('outcome').$type<NameStyleOutcome>().notNull(),
  reason: text('reason').$type<NameStyleReason>(),

  // SQL NULL is "confirmed no style" whenever confirmed_at is set, so never read meaning from it alone.
  confirmed: jsonb('confirmed').$type<BotNameStyle>(),

  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BrandingNameStyleRow = typeof brandingNameStyles.$inferSelect;
export type NewBrandingNameStyleRow = typeof brandingNameStyles.$inferInsert;
