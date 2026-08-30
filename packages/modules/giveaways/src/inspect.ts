import {
  describeMultipliers,
  evaluateRequirement,
  evaluateWeight,
  type MemberContext,
  type MultiplierSpec,
  type ProviderRegistry,
  type RequirementSpec,
} from '@proton/core';

export interface RuleLine {
  passed: boolean;
  description: string;
  reason: string | null;
}

/**
 * One verdict per rule rather than one for the whole set. `evaluateRequirement` folds the specs
 * through the any/all logic and reports only what failed, which cannot say which of the rules a
 * member already meets — and "here is what you still need" is the entire point of the button.
 */
export async function inspectRequirements(
  registry: ProviderRegistry,
  ctx: MemberContext,
  specs: readonly RequirementSpec[],
): Promise<RuleLine[]> {
  const lines: RuleLine[] = [];

  for (const spec of specs) {
    const provider = registry.condition(spec.providerId);
    const parsed = registry.parseConfig(spec.providerId, spec.config);
    if (!provider || !parsed.ok) continue;

    const verdict = await evaluateRequirement(registry, ctx, [spec], 'all');
    const failure = verdict.failures[0];

    lines.push({
      passed: verdict.passed,
      description: provider.describe(parsed.config, 'en-GB'),
      reason: failure?.humanReason ?? null,
    });
  }

  return lines;
}

export function renderRequirements(
  lines: readonly RuleLine[],
  logic: 'any' | 'all',
  title: string,
): string {
  if (lines.length === 0) return `**${title}** has no requirements — anybody here can enter.`;

  const met = lines.filter((line) => line.passed).length;
  const eligible = logic === 'any' ? met > 0 : met === lines.length;

  const body = lines
    .map(
      (line) =>
        `${line.passed ? '✅' : '❌'} ${line.description}${
          line.passed || line.reason === null ? '' : `\n　↳ ${line.reason}`
        }`,
    )
    .join('\n');

  const note =
    lines.length > 1
      ? logic === 'any'
        ? '\n\nYou need **any one** of these.'
        : '\n\nYou need **all** of these.'
      : '';

  const verdict = eligible
    ? '\n\n**You can enter this giveaway.**'
    : '\n\n**You cannot enter this giveaway yet.**';

  return `**Requirements — ${title}**\n${body}${note}${verdict}`;
}

export async function renderMultipliers(
  registry: ProviderRegistry,
  ctx: MemberContext,
  specs: readonly MultiplierSpec[],
  title: string,
  maxEntriesPerUser: number | null,
): Promise<string> {
  if (specs.length === 0) {
    return `**${title}** has no bonus entries — everybody who qualifies gets one entry.`;
  }

  const described = describeMultipliers(registry, specs);
  const weight = await evaluateWeight(registry, ctx, specs, { maxEntriesPerUser });

  const earned = new Set(weight.breakdown.map((entry) => entry.providerId));
  const body = described
    .map((line, index) => {
      const spec = specs[index];
      const has = spec !== undefined && earned.has(spec.providerId);
      return `${has ? '✨' : '▫️'} ${line}`;
    })
    .join('\n');

  const cap = maxEntriesPerUser === null ? '' : ` (capped at ${maxEntriesPerUser})`;

  return (
    `**Bonus entries — ${title}**\n${body}\n\n` +
    `On today’s figures you would enter with **${weight.total}** ` +
    `${weight.total === 1 ? 'entry' : 'entries'}${cap}.`
  );
}
