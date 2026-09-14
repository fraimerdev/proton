import {
  isForbiddenKey,
  isRestricted,
  type PlaceholderContext,
  type PlaceholderRegistry,
  type PlaceholderResolution,
  unavailableReason,
} from './definitions.ts';
import type { DiagnosticReporter } from './diagnostics.ts';
import type { PlaceholderToken } from './grammar.ts';
import { SENSITIVITY_LABELS } from './limits.ts';
import { type ModifierPlan, planModifiers } from './modifiers.ts';
import type { AbsentState } from './values.ts';

export interface BindContext extends PlaceholderContext {
  registry: PlaceholderRegistry;
}

export type BoundPlaceholder =
  | { kind: 'literal'; unknown: boolean }
  | { kind: 'absent'; state: AbsentState; plan: ModifierPlan }
  | { kind: 'lookup'; resolution: PlaceholderResolution; plan: ModifierPlan; verbatim: boolean };

export function bindPlaceholder(
  token: PlaceholderToken,
  context: BindContext,
  reporter: DiagnosticReporter,
): BoundPlaceholder {
  if (isForbiddenKey(token.key)) {
    reporter.report(
      'forbidden_key',
      `${token.raw} names a reserved key, which never resolves, so it is posted as written.`,
      token.span,
    );
    return { kind: 'literal', unknown: false };
  }

  const resolution = context.registry.resolve(token.key);

  if (resolution === undefined) {
    reporter.report(
      'unknown_placeholder',
      `${token.raw} is not a placeholder here, so it is posted as written.`,
      token.span,
    );
    return { kind: 'literal', unknown: true };
  }

  const { definition } = resolution;

  const plan = planModifiers(
    token.modifiers,
    { raw: token.raw, span: token.span, type: definition.type, allowed: definition.modifiers },
    context.field,
    reporter,
  );

  const outcome = plan.fallback === undefined ? 'renders as nothing' : 'renders its fallback';

  const unavailable = unavailableReason(definition, context);
  if (unavailable !== undefined) {
    reporter.report('unavailable', `${token.raw} ${unavailable}, so it ${outcome}.`, token.span);
    return { kind: 'absent', state: 'unavailable', plan };
  }

  if (isRestricted(definition, context.audience)) {
    reporter.report(
      'restricted',
      `${token.raw} may only be shown to ${SENSITIVITY_LABELS[definition.sensitivity]}, but this ` +
        `destination is seen by ${SENSITIVITY_LABELS[context.audience ?? 'public']}, so it ${outcome}.`,
      token.span,
    );
    return { kind: 'absent', state: 'restricted', plan };
  }

  if (!plan.fits) return { kind: 'absent', state: 'failed', plan };

  // Aliases stay unescaped so legacy output is unchanged; no legacy text token ever went in a link.
  return {
    kind: 'lookup',
    resolution,
    plan,
    verbatim: resolution.alias && token.modifiers.length === 0 && context.field !== 'url',
  };
}
