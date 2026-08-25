import {
  describeRequirements,
  describeTree,
  evaluateTree,
  type MemberContext,
  type ProviderRegistry,
  type RequirementNode,
  type RequirementSpec,
  type RequirementVerdict,
  requirementTreeSchema,
  treeFromFlat,
} from '@proton/core';
import type { Giveaway } from './store.ts';

/**
 * The tree if the giveaway has one, otherwise the flat rows expressed as a one-level tree. One
 * evaluation path either way — a giveaway written before nested rules existed must not take a
 * different code path from one written after.
 *
 * A stored tree that no longer parses (hand-edited jsonb, a schema that moved on) falls back to
 * the flat rows rather than throwing inside a button press.
 */
export function requirementTreeOf(
  giveaway: Pick<Giveaway, 'requirementTree' | 'requirementLogic'>,
  flat: readonly RequirementSpec[],
): RequirementNode | null {
  if (giveaway.requirementTree !== null && giveaway.requirementTree !== undefined) {
    const parsed = requirementTreeSchema.safeParse(giveaway.requirementTree);
    if (parsed.success) return parsed.data;
  }

  if (flat.length === 0) return null;

  return treeFromFlat(flat, giveaway.requirementLogic);
}

export interface RuleEvaluation extends RequirementVerdict {
  indeterminate: boolean;
}

const PASSED: RuleEvaluation = {
  passed: true,
  indeterminate: false,
  failures: [],
  degraded: [],
};

export async function evaluateRules(
  registry: ProviderRegistry,
  ctxs: readonly MemberContext[],
  tree: RequirementNode | null,
  options: { chunkSize?: number } = {},
): Promise<Map<string, RuleEvaluation>> {
  const verdicts = new Map<string, RuleEvaluation>();

  // No requirements is not the same as requirements nobody meets: a giveaway with none is open to
  // everybody, and must not be folded through a tree that has no children to decide.
  if (tree === null) {
    for (const ctx of ctxs) verdicts.set(ctx.userId, { ...PASSED });
    return verdicts;
  }

  return evaluateTree(registry, ctxs, tree, options);
}

export async function evaluateRulesFor(
  registry: ProviderRegistry,
  ctx: MemberContext,
  tree: RequirementNode | null,
): Promise<RuleEvaluation> {
  const verdicts = await evaluateRules(registry, [ctx], tree);
  return verdicts.get(ctx.userId) ?? { ...PASSED };
}

/** Indented for a nested tree, a plain bulleted list for the flat case almost everybody has. */
export function describeRules(
  registry: ProviderRegistry,
  tree: RequirementNode | null,
  flat: readonly RequirementSpec[],
): string[] {
  if (tree === null) return describeRequirements(registry, flat);
  return describeTree(registry, tree);
}
