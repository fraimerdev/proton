import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

/**
 * Verification and quarantine configuration (PLAN.md §8, Phase 2).
 *
 * Three roles and one switch. Proton decides *when* a role moves; what the role
 * means is the guild's own permission and channel-overwrite setup, and this
 * module deliberately does not try to configure that — a bot that also authored
 * the overwrites would have two sources of truth for who can see what.
 */
export const verificationConfigSchema = z.object({
  /**
   * Off by default, unlike anti-nuke.
   *
   * An enabled gate applies a restricted role to everyone who joins. Doing that
   * before an admin has chosen which role, and what it restricts, would lock a
   * server's new members into a role that grants and denies nothing — visibly
   * broken, and blamed on the bot.
   */
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Gate new members behind a role, and allow /quarantine.',
  }),

  unverifiedRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Unverified role',
    description:
      'The restricted role a member holds until they pass the gate. Prefer granting it with ' +
      'a role-granting invite (Server Settings → Invites): Discord applies it at the moment ' +
      'of joining, so there is no window in which the member is ungated. Proton detects that ' +
      'and stays out of the way.',
  }),

  verifiedRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Member role',
    description:
      'Granted when a member passes the gate. Leave empty if removing the unverified role ' +
      'is itself the grant — Proton needs at least one of the two roles to be set.',
  }),

  /**
   * The §10.5 fallback, and only the fallback.
   *
   * A role-granting invite closes the gate at join time with no bot round trip
   * to race, so when the join dispatch already carries the unverified role this
   * does nothing whatever its value. It matters only for the joins an invite did
   * not cover — a vanity URL, the discovery tab, a widget — and turning it off is
   * how a guild says "every one of my invites grants the role, and a join that
   * arrives without it is a bug I want reported rather than papered over".
   */
  applyUnverifiedOnJoin: z
    .boolean()
    .default(true)
    .register(protonFields, {
      label: 'Apply the unverified role on join',
      description:
        'Only used when the invite did not already grant it. Turn this off if every invite ' +
        'to this server is a role-granting one; Proton will then report an ungated join ' +
        'instead of applying the role after the fact.',
    }),

  quarantineRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Quarantine role',
    description:
      'Swapped in by /quarantine, which records every role it takes off so /unquarantine can put ' +
      'them back exactly. Isolating a member is only safe if undoing it is exact.',
  }),
});

export type VerificationConfig = z.infer<typeof verificationConfigSchema>;

/**
 * Defaults that act on nobody.
 *
 * No role ids: there is no role every guild has, and inventing one would have
 * Proton move a role the admin never chose. With `enabled` false as well, a
 * guild that installs Proton and ignores this module sees precisely nothing
 * happen — the correct behaviour for a control that restricts people.
 */
export const verificationDefaultConfig: VerificationConfig = {
  enabled: false,
  applyUnverifiedOnJoin: true,
};

/** Bumped whenever the shape above changes (I5). */
export const VERIFICATION_SCHEMA_VERSION = 1;
