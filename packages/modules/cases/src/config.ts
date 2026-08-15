import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

/**
 * One rung of the warn-escalation ladder.
 *
 * `atWarnings` starts at 2 because the ladder compiles to a `rate-over-window`
 * condition, whose limit floor is 2 (a limit of 1 is not a rate — it is the
 * event itself). A rung at one warning would therefore be silently unbuildable,
 * so it is refused where an admin can see the message instead.
 *
 * The action set is narrower than `ActionKind` on purpose: these are the kinds
 * whose target the rule engine can fill from the event's facts alone. `add_role`
 * would need a role id per rung, and `send` a channel — both are configuration
 * an escalation ladder has no business carrying.
 */
export const ESCALATION_ACTIONS = ['timeout', 'kick', 'ban'] as const;

export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

export const escalationRungSchema = z.object({
  atWarnings: z.number().int().min(2).max(100),
  action: z.enum(ESCALATION_ACTIONS),
  /**
   * How long the action lasts. A `timeout` without one is meaningless to
   * Discord, so it is required there; a `ban` with one becomes a temp ban that
   * the reversal scheduler lifts, and without one is permanent.
   */
  duration: durationStringSchema.optional(),
});

export type EscalationRung = z.infer<typeof escalationRungSchema>;

/**
 * Rungs must be strictly increasing.
 *
 * Two rungs at the same count would compile to two rules with identical rate
 * windows firing on the same warning, and an out-of-order ladder reads as if it
 * escalates when it does not. Both are configuration mistakes that would only
 * ever surface as "the bot did nothing sensible", so they are refused on write.
 */
function strictlyIncreasing(rungs: readonly EscalationRung[]): boolean {
  return rungs.every((rung, i) => i === 0 || rung.atWarnings > (rungs[i - 1]?.atWarnings ?? 0));
}

/** A timeout has no meaning without an expiry — Discord's field is an instant. */
function timeoutsHaveDuration(rungs: readonly EscalationRung[]): boolean {
  return rungs.every((rung) => rung.action !== 'timeout' || rung.duration !== undefined);
}

/**
 * Exported so the dashboard's bespoke ladder editor validates against the same
 * rules the module enforces on save (§9). A second copy of "strictly increasing"
 * written in the UI would eventually disagree with this one, and the admin would
 * meet the disagreement as a save that failed for no visible reason.
 */
export const escalationLadderSchema = z
  .array(escalationRungSchema)
  .max(20)
  .refine(strictlyIncreasing, {
    message:
      'rungs must be ordered by atWarnings, strictly increasing — two rungs at the same ' +
      'warning count would both fire on it.',
  })
  .refine(timeoutsHaveDuration, {
    message:
      "a 'timeout' rung needs a duration, e.g. 1h — Discord timeouts are an expiry, not a flag.",
  });

/**
 * Cases configuration.
 *
 * `escalationLadder` is an array of objects, which PLAN.md §9 puts explicitly
 * outside the v1 form generator: it supports flat arrays of scalars and objects
 * nesting one level, not arrays of objects. `zodToDescriptors` therefore throws
 * on this schema, and that is the intended behaviour — the alternative is
 * widening the generator until it half-renders the rule builder, which §9 rules
 * out in as many words.
 *
 * The ladder still lives in config, because it is per-guild data that has to be
 * validated on every read and write (I5) and diffed for the audit trail (I7).
 * `casesFormSchema` below is what the dashboard generates fields from; the
 * ladder gets a bespoke editor, exactly as §9 says the rule builder will.
 */
export const casesConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
    description: 'Record moderation cases and run the warn-escalation ladder in this server.',
  }),

  historyLimit: z.number().int().min(1).max(25).default(10).register(protonFields, {
    label: 'Cases shown in /history',
    description: 'How many of a member’s most recent cases /history lists. 1-25.',
  }),

  escalationWindow: durationStringSchema.default('30d').register(protonFields, {
    field: 'duration',
    label: 'Escalation window',
    description:
      'How long a warning counts towards the ladder. Warnings older than this stop counting.',
  }),

  // Deliberately not registered with `protonFields`: no v1 field kind describes
  // it, and a metadata hint would only make the generator's refusal look like a
  // bug rather than the documented boundary it is.
  escalationLadder: escalationLadderSchema.default([
    { atWarnings: 3, action: 'timeout', duration: '1h' },
    { atWarnings: 5, action: 'timeout', duration: '1d' },
  ]),
});

export type CasesConfig = z.infer<typeof casesConfigSchema>;

/**
 * The subset the dashboard form generator can build (PLAN.md §9).
 *
 * Derived by omission rather than written out a second time, so a field added
 * to the config appears on the form automatically and the two cannot drift.
 * Anything omitted here is a promise that a bespoke editor exists for it.
 */
export const casesFormSchema = casesConfigSchema.omit({ escalationLadder: true });

export const casesDefaultConfig: CasesConfig = {
  enabled: true,
  historyLimit: 10,
  escalationWindow: '30d',
  escalationLadder: [
    // Timeouts only by default. A ladder that kicks or bans out of the box makes
    // Proton itself the attack vector PLAN.md §15 warns about — the guild has to
    // opt into anything irreversible.
    { atWarnings: 3, action: 'timeout', duration: '1h' },
    { atWarnings: 5, action: 'timeout', duration: '1d' },
  ],
};

/** Bumped whenever the shape above changes (I5). */
export const CASES_SCHEMA_VERSION = 1;
