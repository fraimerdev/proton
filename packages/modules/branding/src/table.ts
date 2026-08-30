import { guilds } from '@proton/db';
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// base64 in text, not bytea. Discord's Image Data wants `data:<mime>;base64,<payload>` and this is
// already that payload, so the push is a concatenation rather than a driver-specific binary round
// trip — and there is no bytea anywhere else in this schema to copy a working one from.
export const brandingAssets = pgTable(
  'branding_assets',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),

    contentType: text('content_type').notNull(),
    base64: text('base64').notNull(),

    hash: text('hash').notNull(),
    byteSize: integer('byte_size').notNull(),

    uploadedBy: text('uploaded_by'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.kind] })],
);

export type BrandingAssetRow = typeof brandingAssets.$inferSelect;

// The colour role Proton made for itself here. Guild state carries role ids, permissions and
// positions but not names, so there is no way to find this role again without writing its id down.
export const brandingRoles = pgTable('branding_roles', {
  guildId: text('guild_id')
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),

  roleId: text('role_id').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BrandingRoleRow = typeof brandingRoles.$inferSelect;
