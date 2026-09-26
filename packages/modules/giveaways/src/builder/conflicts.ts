import type { ProviderRegistry } from '@proton/core';
import type { DraftItem, DraftMultiplier } from './state.ts';

export interface Conflict {
  humanReason: string;

  /** True when the giveaway is impossible as configured, not merely odd. */
  blocking: boolean;
}

function roleIds(config: Record<string, unknown>): string[] {
  const raw = config.roleIds;
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string');

  return typeof raw === 'string' ? [raw] : [];
}

function overlap(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((id) => other.has(id));
}

function labelFor(registry: ProviderRegistry, providerId: string): string {
  return registry.get(providerId)?.label ?? providerId;
}

/**
 * Catches the configurations a host cannot possibly have meant, before they publish a giveaway
 * nobody can enter. Deliberately not exhaustive — it names the ones that are unambiguously wrong
 * and stays quiet about the rest, because a builder that cries wolf gets clicked through.
 */
export function findConflicts(
  registry: ProviderRegistry,
  requirements: readonly DraftItem[],
  multipliers: readonly DraftMultiplier[],
  logic: 'all' | 'any',
): Conflict[] {
  const conflicts: Conflict[] = [];

  // Requiring and excluding the same role at once can never pass — but only under ALL. Under ANY
  // it is merely redundant, because either branch can carry the entry on its own.
  if (logic === 'all') {
    const required = requirements
      .filter((item) => item.providerId === 'core.has_role')
      .flatMap((item) => roleIds(item.config));

    const excluded = requirements
      .filter((item) => item.providerId === 'core.lacks_role')
      .flatMap((item) => roleIds(item.config));

    const both = overlap(required, excluded);

    if (both.length > 0) {
      conflicts.push({
        blocking: true,
        humanReason:
          `${both.map((id) => `<@&${id}>`).join(', ')} is both required and excluded, so nobody ` +
          'can enter. Change one of the two rules.',
      });
    }
  }

  const seen = new Map<string, number>();
  for (const item of requirements) {
    seen.set(item.providerId, (seen.get(item.providerId) ?? 0) + 1);
  }

  for (const [providerId, count] of seen) {
    if (count < 2) continue;

    conflicts.push({
      blocking: false,
      humanReason:
        `“${labelFor(registry, providerId)}” is added ${count} times. With ` +
        `${logic === 'all' ? '“all of these”, only the strictest one' : '“any one of these”, only the loosest one'}` +
        ' counts.',
    });
  }

  // A multiply by one is a no-op that reads like a bonus, which is worse than no rule at all.
  for (const item of multipliers) {
    const amount = item.config.amount;
    if (item.mode === 'multiply' && amount === 1) {
      conflicts.push({
        blocking: false,
        humanReason: `“${labelFor(registry, item.providerId)}” multiplies by 1, which changes nothing.`,
      });
    }
  }

  return conflicts;
}

export function blockingConflicts(conflicts: readonly Conflict[]): Conflict[] {
  return conflicts.filter((conflict) => conflict.blocking);
}
