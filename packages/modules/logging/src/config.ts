import { protonFields } from '@proton/core';
import { z } from 'zod';

/**
 * How many UTC days of message logs are kept.
 *
 * A platform constant, not per-guild config, and that is a deliberate limit.
 * Retention here is implemented by dropping whole daily partitions (§6) — one
 * `DROP TABLE`, O(1), no rows touched — and a partition holds every guild's rows
 * for that day. A per-guild retention would have to expire rows individually
 * across 30 days of content, which is the cost the partitioning exists to avoid.
 * Guilds that need a shorter window need a targeted per-guild purge job; that is
 * a feature, not a config field, and it is not built.
 *
 * 30 days is the owner's recorded decision (CLAUDE.md, "Message-log retention:
 * opt-in, 30 days"; PLAN.md §14.5).
 */
export const MESSAGE_LOG_RETENTION_DAYS = 30;

/**
 * Logging configuration.
 *
 * Everything here defaults to the least data collected. `enabled` is false so a
 * guild that has never opened this page has no message content stored anywhere:
 * §6 calls content retention a legal surface (GDPR/DSA — Proton is the data
 * controller), which makes opt-in the only defensible default, and Gate 1 states
 * it outright ("behind per-guild opt-in").
 */
export const loggingConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Enabled',
      description:
        `Record message edits and deletions in this server for ${MESSAGE_LOG_RETENTION_DAYS} days. ` +
        'Off until you turn it on — stored message content is personal data you are responsible for.',
    }),

  logEdits: z.boolean().default(true).register(protonFields, {
    label: 'Log edits',
    description: 'Record the new text when a member edits a message.',
  }),

  logDeletes: z.boolean().default(true).register(protonFields, {
    label: 'Log deletions',
    description: 'Record which message was deleted, in which channel, and when.',
  }),

  /**
   * Channels excluded from logging.
   *
   * The one control that reduces what is collected rather than what is shown, so
   * it belongs in config where it is validated on every read (I5) and diffed into
   * the audit trail (I7) — a staff member quietly removing a channel from this
   * list is exactly the change an admin needs to be able to see afterwards.
   */
  ignoredChannels: z
    .array(z.string())
    .max(50)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Ignored channels',
      description: 'Edits and deletions in these channels are never recorded.',
      // Text, announcement, and public/private threads — the channel types a
      // guild message can be edited or deleted in.
      channelTypes: [0, 5, 11, 12],
    }),
});

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

export const loggingDefaultConfig: LoggingConfig = {
  enabled: false,
  logEdits: true,
  logDeletes: true,
  ignoredChannels: [],
};

/** Bumped whenever the shape above changes (I5). */
export const LOGGING_SCHEMA_VERSION = 1;
