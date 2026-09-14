import { z } from 'zod';
import { PLACEHOLDER_LIMITS } from './limits.ts';

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;

export const DIAGNOSTIC_CODES = [
  'template_too_long',
  'too_many_placeholders',
  'too_many_modifiers',
  'too_many_arguments',
  'argument_too_long',
  'key_too_long',
  'lone_brace',
  'malformed_placeholder',
  'forbidden_key',
  'unknown_placeholder',
  'unavailable',
  'restricted',
  'incompatible_field',
  'unknown_modifier',
  'incompatible_modifier',
  'invalid_argument',
  'invalid_value',
  'resolver_failed',
  'not_set',
  'list_truncated',
  'output_truncated',
  'invalid_url',
  'empty_channel_name',
  'mention_without_name',
  'invalid_locale',
  'invalid_time_zone',
] as const;

export const spanSchema = z.object({ start: z.int().min(0), end: z.int().min(0) });

export type Span = z.infer<typeof spanSchema>;

export const templateDiagnosticSchema = z.object({
  code: z.enum(DIAGNOSTIC_CODES),
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  message: z.string(),
  span: spanSchema.nullable(),
});

export type TemplateDiagnostic = z.infer<typeof templateDiagnosticSchema>;

export type DiagnosticCode = TemplateDiagnostic['code'];

export type DiagnosticSeverity = TemplateDiagnostic['severity'];

export const DIAGNOSTIC_SEVERITY: Record<DiagnosticCode, DiagnosticSeverity> = {
  template_too_long: 'error',
  too_many_placeholders: 'error',
  too_many_modifiers: 'error',
  too_many_arguments: 'error',
  argument_too_long: 'error',
  key_too_long: 'error',
  lone_brace: 'warning',
  malformed_placeholder: 'error',
  forbidden_key: 'warning',
  unknown_placeholder: 'warning',
  unavailable: 'error',
  restricted: 'error',
  incompatible_field: 'error',
  unknown_modifier: 'error',
  incompatible_modifier: 'error',
  invalid_argument: 'error',
  invalid_value: 'error',
  resolver_failed: 'error',
  not_set: 'info',
  list_truncated: 'info',
  output_truncated: 'warning',
  invalid_url: 'error',
  empty_channel_name: 'error',
  mention_without_name: 'warning',
  invalid_locale: 'warning',
  invalid_time_zone: 'warning',
};

export interface DiagnosticReporter {
  readonly diagnostics: TemplateDiagnostic[];
  readonly errors: number;
  report(code: DiagnosticCode, message: string, span: Span | null): void;
}

export function createReporter(seed: readonly TemplateDiagnostic[] = []): DiagnosticReporter {
  const diagnostics = seed.slice(0, PLACEHOLDER_LIMITS.diagnostics);
  let errors = seed.filter((diagnostic) => diagnostic.severity === 'error').length;

  return {
    diagnostics,
    get errors() {
      return errors;
    },
    report(code, message, span) {
      const severity = DIAGNOSTIC_SEVERITY[code];
      if (severity === 'error') errors += 1;

      if (diagnostics.length >= PLACEHOLDER_LIMITS.diagnostics) return;
      diagnostics.push({ code, severity, message, span });
    },
  };
}
