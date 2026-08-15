import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const entitlements = pgTable(
  'entitlements',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    skuId: text('sku_id').notNull(),
    tier: text('tier').notNull(),
    source: text('source').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    discordEntitlementId: text('discord_entitlement_id'),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.skuId] })],
);

export type Entitlement = typeof entitlements.$inferSelect;
export type NewEntitlement = typeof entitlements.$inferInsert;
