import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

/**
 * Moderation's configuration.
 *
 * Every field here is policy a server owner genuinely disagrees about — nothing
 * that merely restates a Discord permission. Who *may* run `/ban` is already
 * decided by the command's `default_member_permissions` and by Discord's own
 * permission UI; duplicating that as config would give two answers to one
 * question.
 */
export const moderationConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
    description: 'Answer moderation commands in this server.',
  }),

  requireReason: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Require a reason',
      description:
        'Refuse a moderation command that carries no reason. The reason is written to ' +
        "Discord's audit log and to the case, so requiring it keeps both readable.",
    }),

  publicReplies: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Announce outcomes in the channel',
      description:
        'Off means only the moderator who ran the command sees the outcome. Failures are ' +
        'reported either way — Proton never fails silently.',
    }),

  defaultTimeoutDuration: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Default timeout length',
    description: 'Used when /timeout is run without a duration. Discord caps timeouts at 28 days.',
  }),

  defaultBanDeleteDays: z
    .number()
    .int()
    .min(0)
    .max(7)
    .default(0)
    .register(protonFields, {
      label: 'Default message deletion on ban (days)',
      description:
        "How much of a banned member's recent message history Discord deletes when " +
        '/ban is run without the delete_message_days option. 0 keeps everything.',
    }),
});

export type ModerationConfig = z.infer<typeof moderationConfigSchema>;

export const moderationDefaultConfig: ModerationConfig = {
  enabled: true,
  requireReason: false,
  publicReplies: false,
  defaultTimeoutDuration: '1h',
  defaultBanDeleteDays: 0,
};

/** Bumped whenever the shape above changes (I5). */
export const MODERATION_SCHEMA_VERSION = 1;
