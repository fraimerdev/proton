import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

/**
 * What Proton does with the author of a message carrying a blocklisted link.
 *
 * Every entry is an existing `ActionKind`, so the executor's prechecks, case
 * ledger and dry-run policy apply unchanged (I1). `none` is a real choice, not a
 * placeholder: a server with human moderators online often wants the alert and
 * nothing else, and a module that cannot be put in observe-only mode is a module
 * admins switch off entirely the first time it surprises them.
 *
 * Deleting the message is deliberately absent — see the blocker on
 * `createPhishingModule`.
 */
export const PHISHING_ACTIONS = ['none', 'timeout', 'kick', 'ban'] as const;
export type PhishingAction = (typeof PHISHING_ACTIONS)[number];

/** Room for a guild's own list without letting one config row become a feed. */
const GUILD_LIST_MAX = 100;

export const phishingConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .register(protonFields, {
      label: 'Enabled',
      description:
        'Check messages against the community phishing blocklist. On by default — a scam ' +
        'link is acted on within seconds of being posted, which is the whole value.',
    }),

  action: z
    .enum(PHISHING_ACTIONS)
    .default('timeout')
    .register(protonFields, {
      label: 'Action',
      description:
        'What happens to whoever posted the link. Timeout is the default because it stops ' +
        'the spam immediately and lifts itself, so a false positive costs an hour rather ' +
        'than a ban appeal. Choose None to alert staff without acting.',
    }),

  timeoutDuration: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Timeout length',
    description: 'How long the timeout lasts. Discord caps timeouts at 28 days.',
  }),

  /**
   * Where the alert goes.
   *
   * Optional, and its absence is not an error: a guild that picked `none` and no
   * alert channel has asked for detection to be logged and nothing more, which
   * is a coherent thing to want while testing the module.
   */
  alertChannel: z
    .string()
    .optional()
    .register(protonFields, {
      field: 'channel-id',
      label: 'Alert channel',
      description:
        'Posts the channel, the author and the exact domain that matched, so staff can ' +
        'check the call. Leave empty for no alert.',
      // Text and announcement channels, and their threads.
      channelTypes: [0, 5, 11, 12],
    }),

  /**
   * A guild's own additions to the list.
   *
   * Here rather than as extra feed URLs on purpose: the fetched list is global
   * and shared, so a per-guild URL would have Proton issue an outbound request
   * to any address a dashboard user typed. These are matched exactly the way
   * feed entries are — on label boundaries, so an entry covers its subdomains.
   */
  blockDomains: z
    .array(z.string().max(253))
    .max(GUILD_LIST_MAX)
    .default([])
    .register(protonFields, {
      label: 'Extra blocked domains',
      description:
        'Blocked in this server on top of the community list. An entry also covers its ' +
        'subdomains, so blocking example.com also blocks login.example.com.',
    }),

  /**
   * The escape hatch for a wrong feed entry.
   *
   * Community lists are curated by volunteers and do occasionally list a domain
   * a particular server legitimately uses. Without this, that server's only
   * remedy is switching the whole module off and waiting for an upstream fix.
   */
  allowDomains: z
    .array(z.string().max(253))
    .max(GUILD_LIST_MAX)
    .default([])
    .register(protonFields, {
      label: 'Never blocked',
      description:
        'Checked before the blocklist, so these are never acted on even if a feed lists ' +
        'them. Also covers subdomains.',
    }),
});

export type PhishingConfig = z.infer<typeof phishingConfigSchema>;

export const phishingDefaultConfig: PhishingConfig = {
  enabled: true,
  action: 'timeout',
  timeoutDuration: '1h',
  blockDomains: [],
  allowDomains: [],
};

/** Bumped whenever the shape above changes (I5). */
export const PHISHING_SCHEMA_VERSION = 1;
