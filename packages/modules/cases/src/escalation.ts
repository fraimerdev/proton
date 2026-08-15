import type { RuleDefinition } from '@proton/core';
import { type CasesConfig, casesDefaultConfig, type EscalationRung } from './config.ts';

/** The rule id a rung compiles to. Stable, so a stored override survives edits. */
export function escalationRuleId(rung: EscalationRung): string {
  return `escalate-at-${rung.atWarnings}`;
}

/**
 * Compile a guild's ladder into preset rules (PLAN.md §4-P2).
 *
 * Escalation is deliberately *not* logic inside this module. It is a rule with
 * the trigger `moderation.warned`, evaluated by the same engine that runs
 * automod and anti-nuke, so a guild can inspect it, reorder it, switch a rung
 * off or replace it in the rule builder later. Hardcoding "on the third warning,
 * time them out" here would make the one behaviour admins most want to tune the
 * one behaviour they cannot see.
 *
 * Two properties of the engine make the ladder fall out of a single condition:
 *
 *  - `rate-over-window` trips only on the call where the count *equals* the
 *    limit, not on every call at or above it. The rung at 3 fires on the third
 *    warning and stays quiet on the fourth, so rungs do not pile up and a later,
 *    harsher rung is never undercut by an earlier, milder one re-firing.
 *  - the window is keyed by `(guildId, moduleId:ruleId, actorId)`, so each rung
 *    counts independently and `escalationWindow` means "how long a warning
 *    counts", exactly as the config field claims.
 *
 * This depends on the `moderation.warned` facts carrying the **warned member**
 * as `RuleFacts.actorId` — the member the event is about, not the moderator who
 * typed the command. Counting the moderator would escalate against staff.
 */
export function escalationRules(
  config: Pick<CasesConfig, 'escalationLadder' | 'escalationWindow'>,
): RuleDefinition[] {
  return config.escalationLadder.map((rung, index) => ({
    id: escalationRuleId(rung),
    trigger: { kind: 'event', event: 'moderation.warned' },
    conditions: [
      { kind: 'rate-over-window', limit: rung.atWarnings, window: config.escalationWindow },
    ],
    actions: [
      {
        kind: rung.action,
        // Reasons land in Discord's own audit log via `x-audit-log-reason`, so a
        // server admin reading their audit log sees why Proton acted without
        // having to open the dashboard.
        reason: `Warning ${rung.atWarnings} within ${config.escalationWindow} — automatic escalation`,
        ...(rung.duration !== undefined ? { duration: rung.duration } : {}),
      },
    ],
    enabled: true,
    // Ascending with the rung, so ordering is deterministic across deploys. The
    // engine breaks ties on module and id, but a ladder that reordered itself
    // between releases would be untestable, and the ordering is also the
    // fallback that keeps the harshest rung applied last if a future condition
    // ever lets two rungs fire on the same warning.
    priority: index * 10,
  }));
}

/**
 * The rules the manifest ships with — the compiled default ladder.
 *
 * A guild that edits its ladder needs these recompiled from *its* config;
 * `escalationRules` is exported for that. The manifest carries the defaults so a
 * guild that never opens the dashboard still gets an escalation ladder.
 */
export const casesPresetRules: RuleDefinition[] = escalationRules(casesDefaultConfig);
