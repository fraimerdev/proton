import type { RuleDefinition } from '@proton/core';
import { type AutoroleConfig, autoroleDefaultConfig } from './config.ts';

/** The rule id a configured role compiles to. Stable, so a stored override survives edits. */
export function autoroleRuleId(roleId: string): string {
  return `grant-${roleId}`;
}

/**
 * Compile a guild's autorole list into preset rules (PLAN.md §4-P2).
 *
 * Autorole is the textbook case for the rule engine and the reason this module
 * does not implement it in a listener: "when a member joins, give them this
 * role" is a trigger, no conditions, and one action — precisely the vocabulary
 * §4-P2 defines, with nothing left over. Writing it as a listener would work and
 * would be invisible: a guild could not see it in the rules table, could not
 * disable one role's grant while keeping another, and could not add a condition
 * to it in the rule builder later without this module being rewritten.
 *
 * Contrast `leveling`'s role rewards, which deliberately are *not* rules — those
 * key on "reached level N", and the predicate set is closed with no numeric
 * comparison in it. The dividing line is whether the behaviour fits the existing
 * vocabulary without widening it. Autorole does; level rewards do not.
 *
 * One rule per role rather than one rule with N actions, because that is what
 * makes a single role's grant switchable on its own. The engine runs them in
 * priority order and a failure in one does not cancel the rest.
 */
export function autoroleRules(config: Pick<AutoroleConfig, 'autoroleIds'>): RuleDefinition[] {
  return config.autoroleIds.map((roleId, index) => ({
    id: autoroleRuleId(roleId),
    trigger: { kind: 'event', event: 'member.joined' },
    // No conditions: every joining member gets it. A guild wanting "only accounts
    // older than a week" adds an `account-age` condition in the rule builder,
    // which is exactly the extensibility expressing this as a rule buys.
    conditions: [],
    actions: [
      {
        kind: 'add_role',
        // The engine fills `userId` from the event's facts; a preset cannot and
        // must not name a member. Only the role is ours to state.
        payload: { roleId },
        // Lands in Discord's own audit log via `x-audit-log-reason`, so a server
        // admin reading their audit log sees why Proton acted.
        reason: 'Autorole on join',
      },
    ],
    enabled: true,
    priority: index * 10,
  }));
}

/**
 * The rules the manifest ships with.
 *
 * Empty, because `autoroleIds` defaults to empty — there is no sensible default
 * role to grant in a server Proton has never seen. A guild that configures roles
 * needs these recompiled from *its* config; `autoroleRules` is exported for that.
 */
export const autorolePresetRules: RuleDefinition[] = autoroleRules(autoroleDefaultConfig);
