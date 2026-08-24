import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The authoritative record of a live temporary channel. Redis holds occupancy, which is a cache of
 * what Discord already knows; ownership is not, and losing it to a TTL or a restart is what left
 * members unable to manage a channel they were sitting in.
 *
 * A row is written in `reserving` before Discord is called, so a create that dies half-way leaves
 * evidence the reconciler can find. `channelId` is null until Discord answers with one.
 */
export const tempVoiceChannels = pgTable(
  'temp_voice_channels',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),

    hubChannelId: text('hub_channel_id').notNull(),
    channelId: text('channel_id'),

    ownerId: text('owner_id'),
    status: text('status').notNull().default('reserving'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),

    // Set when the channel empties, cleared the moment somebody rejoins. The sweeper deletes only
    // rows whose deadline has actually passed, so a fast rejoin costs nothing.
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
  },
  (t) => [
    // One row per Discord channel. This is what makes a redelivered create idempotent rather than
    // relying on an event id that repeats within a voice session.
    uniqueIndex('temp_voice_channel_uq')
      .on(t.guildId, t.channelId)
      .where(sql`${t.channelId} is not null`),

    index('temp_voice_owner_idx').on(t.guildId, t.ownerId).where(sql`${t.status} = 'live'`),

    index('temp_voice_guild_status_idx').on(t.guildId, t.status),

    index('temp_voice_sweep_idx').on(t.deleteAfter).where(sql`${t.deleteAfter} is not null`),
  ],
);

export type TempVoiceChannelRow = typeof tempVoiceChannels.$inferSelect;
export type NewTempVoiceChannelRow = typeof tempVoiceChannels.$inferInsert;

/**
 * Per-channel access an owner has granted or withheld. Separate from the channel's overwrites
 * because Proton has to be able to rebuild those from scratch — on a privacy change, on a
 * permission resync, or after somebody edits the channel by hand in Discord.
 */
export const tempVoiceAccess = pgTable(
  'temp_voice_access',
  {
    tempChannelId: text('temp_channel_id')
      .notNull()
      .references(() => tempVoiceChannels.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),

    // 'trust' or 'block'. One row per member: trusting somebody you had blocked replaces the row
    // rather than leaving both and making the outcome depend on read order.
    kind: text('kind').notNull(),

    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('temp_voice_access_uq').on(t.tempChannelId, t.userId),
    index('temp_voice_access_channel_idx').on(t.tempChannelId),
  ],
);

export type TempVoiceAccessRow = typeof tempVoiceAccess.$inferSelect;
export type NewTempVoiceAccessRow = typeof tempVoiceAccess.$inferInsert;

/**
 * Roles Proton itself handed out. Without this the module cannot tell a role it granted from one
 * the member already had, and taking the temporary role away on leave would strip a role somebody
 * earned somewhere else.
 */
export const tempVoiceRoles = pgTable(
  'temp_voice_roles',
  {
    tempChannelId: text('temp_channel_id')
      .notNull()
      .references(() => tempVoiceChannels.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    roleId: text('role_id').notNull(),

    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('temp_voice_role_uq').on(t.tempChannelId, t.userId, t.roleId),
    index('temp_voice_role_user_idx').on(t.userId),
  ],
);

export type TempVoiceRoleRow = typeof tempVoiceRoles.$inferSelect;
export type NewTempVoiceRoleRow = typeof tempVoiceRoles.$inferInsert;

export const TEMP_VOICE_STATUSES = ['reserving', 'live', 'closing'] as const;

export type TempVoiceStatus = (typeof TEMP_VOICE_STATUSES)[number];

export const ACCESS_KINDS = ['trust', 'block'] as const;

export type AccessKind = (typeof ACCESS_KINDS)[number];
